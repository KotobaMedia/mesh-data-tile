use std::io::Read;

use crc32fast::hash as crc32;
use flate2::read::DeflateDecoder;

use crate::common::{
    decode_no_data_field, expected_payload_length, read_numeric_value, read_u32_le, read_u64_le,
    unpack_dtype_endian, validate_tile_id_for_mesh_kind,
};
use crate::consts::{
    HEADER_CHECKSUM_INPUT_LENGTH, HEADER_CHECKSUM_OFFSET, MAGIC, OFFSET_BANDS, OFFSET_COLS,
    OFFSET_COMPRESSED_PAYLOAD_LENGTH, OFFSET_COMPRESSION, OFFSET_DTYPE_ENDIAN, OFFSET_FORMAT_MAJOR,
    OFFSET_MESH_KIND, OFFSET_NO_DATA_KIND, OFFSET_NO_DATA_VALUE, OFFSET_PAYLOAD_CHECKSUM,
    OFFSET_ROWS, OFFSET_TILE_ID, OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH, TILE_FIXED_HEADER_LENGTH,
    TILE_VERSION_MAJOR,
};
use crate::{
    CompressionMode, DType, DecodedTile, Endianness, MeshKind, Result, TileDimensions, TileError,
    TileErrorCode, TileHeader,
};

#[derive(Debug)]
struct ParsedHeader {
    header: TileHeader,
    compressed_payload_len: usize,
    uncompressed_payload_len: usize,
}

pub fn inspect_tile(bytes: &[u8]) -> Result<TileHeader> {
    let parsed = parse_header(bytes)?;
    Ok(parsed.header)
}

pub fn decode_tile_minimal(bytes: &[u8]) -> Result<DecodedTile> {
    let parsed = parse_header(bytes)?;

    let payload_end = TILE_FIXED_HEADER_LENGTH
        .checked_add(parsed.compressed_payload_len)
        .ok_or_else(|| {
            TileError::new(
                TileErrorCode::InvalidPayloadLength,
                "Compressed payload length overflow.",
            )
        })?;

    let stored_payload = &bytes[TILE_FIXED_HEADER_LENGTH..payload_end];
    let payload = decompress_payload(parsed.header.compression, stored_payload)?;

    if payload.len() != parsed.uncompressed_payload_len {
        return Err(TileError::new(
            TileErrorCode::InvalidPayloadLength,
            format!(
                "Uncompressed payload length mismatch. expected={} got={}",
                parsed.uncompressed_payload_len,
                payload.len()
            ),
        ));
    }

    let payload_crc32 = crc32(&payload);
    if payload_crc32 != parsed.header.payload_crc32 {
        return Err(TileError::new(
            TileErrorCode::PayloadChecksumMismatch,
            format!(
                "Payload checksum mismatch. expected={:08x} actual={payload_crc32:08x}",
                parsed.header.payload_crc32
            ),
        ));
    }

    let expected_uncompressed_len =
        expected_payload_length(parsed.header.dimensions, parsed.header.dtype)?;
    if payload.len() != expected_uncompressed_len {
        return Err(TileError::new(
            TileErrorCode::InvalidPayloadLength,
            format!(
                "Decoded payload length mismatch. expected={expected_uncompressed_len} got={}",
                payload.len()
            ),
        ));
    }

    Ok(DecodedTile {
        header: parsed.header,
        payload,
    })
}

pub fn decode_payload_values(
    dtype: DType,
    endianness: Endianness,
    payload: &[u8],
) -> Result<Vec<f64>> {
    let value_size = dtype.byte_size();
    if !payload.len().is_multiple_of(value_size) {
        return Err(TileError::new(
            TileErrorCode::InvalidPayloadLength,
            format!(
                "Payload byte length {} is not divisible by {value_size}",
                payload.len()
            ),
        ));
    }

    let mut values = Vec::with_capacity(payload.len() / value_size);
    for chunk in payload.chunks_exact(value_size) {
        values.push(read_numeric_value(dtype, endianness, chunk)?);
    }
    Ok(values)
}

fn parse_header(bytes: &[u8]) -> Result<ParsedHeader> {
    if bytes.len() < TILE_FIXED_HEADER_LENGTH {
        return Err(TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "File shorter than fixed header.",
        ));
    }

    if bytes[0..4] != MAGIC {
        return Err(TileError::new(
            TileErrorCode::InvalidMagic,
            "Invalid file magic.",
        ));
    }

    let format_major = bytes[OFFSET_FORMAT_MAJOR];
    if format_major != TILE_VERSION_MAJOR {
        return Err(TileError::new(
            TileErrorCode::UnsupportedVersion,
            format!("Unsupported major version {format_major}."),
        ));
    }

    let expected_header_crc32 = read_u32_le(bytes, HEADER_CHECKSUM_OFFSET)?;
    let actual_header_crc32 = crc32(&bytes[..HEADER_CHECKSUM_INPUT_LENGTH]);
    if expected_header_crc32 != actual_header_crc32 {
        return Err(TileError::new(
            TileErrorCode::HeaderChecksumMismatch,
            format!(
                "Header checksum mismatch. expected={expected_header_crc32:08x} actual={actual_header_crc32:08x}"
            ),
        ));
    }

    let tile_id = read_u64_le(bytes, OFFSET_TILE_ID)?;
    let mesh_kind = MeshKind::from_code(bytes[OFFSET_MESH_KIND])?;
    validate_tile_id_for_mesh_kind(tile_id, mesh_kind)?;

    let (dtype, endianness) = unpack_dtype_endian(bytes[OFFSET_DTYPE_ENDIAN])?;
    let compression = CompressionMode::from_code(bytes[OFFSET_COMPRESSION])?;

    let dimensions = TileDimensions {
        rows: read_u32_le(bytes, OFFSET_ROWS)?,
        cols: read_u32_le(bytes, OFFSET_COLS)?,
        bands: bytes[OFFSET_BANDS],
    };
    dimensions.validate()?;

    let no_data_kind = bytes[OFFSET_NO_DATA_KIND];
    let mut no_data_value_raw = [0_u8; 8];
    no_data_value_raw.copy_from_slice(&bytes[OFFSET_NO_DATA_VALUE..OFFSET_NO_DATA_VALUE + 8]);
    let no_data = decode_no_data_field(no_data_kind, no_data_value_raw, dtype, endianness)?;

    let uncompressed_payload_u64 = read_u64_le(bytes, OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH)?;
    let compressed_payload_u64 = read_u64_le(bytes, OFFSET_COMPRESSED_PAYLOAD_LENGTH)?;
    let payload_crc32 = read_u32_le(bytes, OFFSET_PAYLOAD_CHECKSUM)?;

    let uncompressed_payload_len = usize::try_from(uncompressed_payload_u64).map_err(|_| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "uncompressed payload length exceeds platform usize.",
        )
    })?;
    let compressed_payload_len = usize::try_from(compressed_payload_u64).map_err(|_| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "compressed payload length exceeds platform usize.",
        )
    })?;

    let payload_end = TILE_FIXED_HEADER_LENGTH
        .checked_add(compressed_payload_len)
        .ok_or_else(|| {
            TileError::new(
                TileErrorCode::InvalidPayloadLength,
                "Compressed payload length overflow.",
            )
        })?;

    if bytes.len() < payload_end {
        return Err(TileError::new(
            TileErrorCode::InvalidPayloadLength,
            "File shorter than declared compressed payload length.",
        ));
    }

    let header = TileHeader {
        format_major,
        tile_id,
        mesh_kind,
        dtype,
        endianness,
        compression,
        dimensions,
        no_data_kind,
        no_data_value_raw,
        no_data,
        payload_uncompressed_bytes: uncompressed_payload_u64,
        payload_compressed_bytes: compressed_payload_u64,
        payload_crc32,
        header_crc32: expected_header_crc32,
    };

    Ok(ParsedHeader {
        header,
        compressed_payload_len,
        uncompressed_payload_len,
    })
}

fn decompress_payload(mode: CompressionMode, payload: &[u8]) -> Result<Vec<u8>> {
    match mode {
        CompressionMode::None => Ok(payload.to_vec()),
        CompressionMode::DeflateRaw => {
            let mut decoder = DeflateDecoder::new(payload);
            let mut out = Vec::new();
            decoder.read_to_end(&mut out).map_err(|err| {
                TileError::new(
                    TileErrorCode::DecompressionFailed,
                    format!("Could not decompress payload using deflate-raw: {err}"),
                )
            })?;
            Ok(out)
        }
    }
}
