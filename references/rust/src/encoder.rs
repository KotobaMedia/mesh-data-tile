use std::io::Write;

use crc32fast::hash as crc32;
use flate2::write::DeflateEncoder;

use crate::common::{
    encode_no_data_field, expected_payload_length, pack_dtype_endian,
    validate_tile_id_for_mesh_kind, write_numeric_value,
};
use crate::consts::{
    HEADER_CHECKSUM_INPUT_LENGTH, HEADER_CHECKSUM_OFFSET, MAGIC, OFFSET_BANDS, OFFSET_COLS,
    OFFSET_COMPRESSED_PAYLOAD_LENGTH, OFFSET_COMPRESSION, OFFSET_DTYPE_ENDIAN, OFFSET_FORMAT_MAJOR,
    OFFSET_MESH_KIND, OFFSET_NO_DATA_KIND, OFFSET_NO_DATA_VALUE, OFFSET_PAYLOAD_CHECKSUM,
    OFFSET_ROWS, OFFSET_TILE_ID, OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH, TILE_FIXED_HEADER_LENGTH,
    TILE_VERSION_MAJOR,
};
use crate::{
    CompressionMode, DType, EncodedTile, Endianness, Result, TileEncodeInput, TileError,
    TileErrorCode, TileHeader,
};

pub fn encode_tile(input: TileEncodeInput<'_>) -> Result<EncodedTile> {
    input.dimensions.validate()?;
    validate_tile_id_for_mesh_kind(input.tile_id, input.mesh_kind)?;

    let expected_payload_len = expected_payload_length(input.dimensions, input.dtype)?;
    if input.payload.len() != expected_payload_len {
        return Err(TileError::new(
            TileErrorCode::InvalidPayloadLength,
            format!(
                "Payload byte length mismatch. expected={expected_payload_len} got={}",
                input.payload.len()
            ),
        ));
    }

    let payload_crc32 = crc32(input.payload);
    let compressed_payload = compress_payload(input.compression, input.payload)?;
    let compressed_payload_len = compressed_payload.len();

    let (no_data_kind, no_data_value_raw) =
        encode_no_data_field(input.no_data, input.dtype, input.endianness)?;

    let mut header_bytes = [0_u8; TILE_FIXED_HEADER_LENGTH];
    header_bytes[0..4].copy_from_slice(&MAGIC);
    header_bytes[OFFSET_FORMAT_MAJOR] = TILE_VERSION_MAJOR;
    header_bytes[OFFSET_TILE_ID..OFFSET_TILE_ID + 8].copy_from_slice(&input.tile_id.to_le_bytes());
    header_bytes[OFFSET_MESH_KIND] = input.mesh_kind.code();
    header_bytes[OFFSET_DTYPE_ENDIAN] = pack_dtype_endian(input.dtype, input.endianness);
    header_bytes[OFFSET_COMPRESSION] = input.compression.code();
    header_bytes[OFFSET_ROWS..OFFSET_ROWS + 4]
        .copy_from_slice(&input.dimensions.rows.to_le_bytes());
    header_bytes[OFFSET_COLS..OFFSET_COLS + 4]
        .copy_from_slice(&input.dimensions.cols.to_le_bytes());
    header_bytes[OFFSET_BANDS] = input.dimensions.bands;
    header_bytes[OFFSET_NO_DATA_KIND] = no_data_kind;
    header_bytes[OFFSET_NO_DATA_VALUE..OFFSET_NO_DATA_VALUE + 8]
        .copy_from_slice(&no_data_value_raw);
    header_bytes[OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH..OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH + 8]
        .copy_from_slice(&(input.payload.len() as u64).to_le_bytes());
    header_bytes[OFFSET_COMPRESSED_PAYLOAD_LENGTH..OFFSET_COMPRESSED_PAYLOAD_LENGTH + 8]
        .copy_from_slice(&(compressed_payload_len as u64).to_le_bytes());
    header_bytes[OFFSET_PAYLOAD_CHECKSUM..OFFSET_PAYLOAD_CHECKSUM + 4]
        .copy_from_slice(&payload_crc32.to_le_bytes());
    header_bytes[HEADER_CHECKSUM_OFFSET..HEADER_CHECKSUM_OFFSET + 4]
        .copy_from_slice(&0_u32.to_le_bytes());

    let header_crc32 = crc32(&header_bytes[..HEADER_CHECKSUM_INPUT_LENGTH]);
    header_bytes[HEADER_CHECKSUM_OFFSET..HEADER_CHECKSUM_OFFSET + 4]
        .copy_from_slice(&header_crc32.to_le_bytes());

    let mut bytes = Vec::with_capacity(TILE_FIXED_HEADER_LENGTH + compressed_payload_len);
    bytes.extend_from_slice(&header_bytes);
    bytes.extend_from_slice(&compressed_payload);

    let header = TileHeader {
        format_major: TILE_VERSION_MAJOR,
        tile_id: input.tile_id,
        mesh_kind: input.mesh_kind,
        dtype: input.dtype,
        endianness: input.endianness,
        compression: input.compression,
        dimensions: input.dimensions,
        no_data_kind,
        no_data_value_raw,
        no_data: input.no_data,
        payload_uncompressed_bytes: input.payload.len() as u64,
        payload_compressed_bytes: compressed_payload_len as u64,
        payload_crc32,
        header_crc32,
    };

    Ok(EncodedTile { bytes, header })
}

pub fn encode_payload_values(
    dtype: DType,
    endianness: Endianness,
    values: &[f64],
) -> Result<Vec<u8>> {
    let value_size = dtype.byte_size();
    let mut out = vec![0_u8; values.len() * value_size];

    for (idx, value) in values.iter().enumerate() {
        let start = idx * value_size;
        let end = start + value_size;
        write_numeric_value(dtype, endianness, *value, true, &mut out[start..end])?;
    }

    Ok(out)
}

fn compress_payload(mode: CompressionMode, payload: &[u8]) -> Result<Vec<u8>> {
    match mode {
        CompressionMode::None => Ok(payload.to_vec()),
        CompressionMode::DeflateRaw => {
            let mut encoder = DeflateEncoder::new(Vec::new(), flate2::Compression::best());
            encoder.write_all(payload).map_err(|err| {
                TileError::new(
                    TileErrorCode::CompressionFailed,
                    format!("Could not compress payload using deflate-raw: {err}"),
                )
            })?;
            encoder.finish().map_err(|err| {
                TileError::new(
                    TileErrorCode::CompressionFailed,
                    format!("Could not finish deflate-raw compression: {err}"),
                )
            })
        }
    }
}
