use std::fmt;
use std::io::{Read, Write};

use crc32fast::hash as crc32;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;

pub const TILE_FIXED_HEADER_LENGTH: usize = 58;
pub const TILE_VERSION_MAJOR: u8 = 1;

const MAGIC: [u8; 4] = *b"MTI1";
const HEADER_CHECKSUM_OFFSET: usize = 54;
const HEADER_CHECKSUM_INPUT_LENGTH: usize = HEADER_CHECKSUM_OFFSET;

const OFFSET_FORMAT_MAJOR: usize = 4;
const OFFSET_TILE_ID: usize = 5;
const OFFSET_MESH_KIND: usize = 13;
const OFFSET_DTYPE_ENDIAN: usize = 14;
const OFFSET_COMPRESSION: usize = 15;
const OFFSET_ROWS: usize = 16;
const OFFSET_COLS: usize = 20;
const OFFSET_BANDS: usize = 24;
const OFFSET_NO_DATA_KIND: usize = 25;
const OFFSET_NO_DATA_VALUE: usize = 26;
const OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH: usize = 34;
const OFFSET_COMPRESSED_PAYLOAD_LENGTH: usize = 42;
const OFFSET_PAYLOAD_CHECKSUM: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshKind {
    JisX0410,
    Xyz,
}

impl MeshKind {
    fn code(self) -> u8 {
        match self {
            Self::JisX0410 => 1,
            Self::Xyz => 2,
        }
    }

    fn from_code(code: u8) -> Result<Self> {
        match code {
            1 => Ok(Self::JisX0410),
            2 => Ok(Self::Xyz),
            _ => Err(TileError::new(
                TileErrorCode::InvalidFieldValue,
                format!("Invalid mesh_kind code {code}."),
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endianness {
    Little,
    Big,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DType {
    Uint8,
    Int8,
    Uint16,
    Int16,
    Uint32,
    Int32,
    Float32,
    Float64,
}

impl DType {
    fn code(self) -> u8 {
        match self {
            Self::Uint8 => 0,
            Self::Int8 => 1,
            Self::Uint16 => 2,
            Self::Int16 => 3,
            Self::Uint32 => 4,
            Self::Int32 => 5,
            Self::Float32 => 6,
            Self::Float64 => 7,
        }
    }

    fn from_code(code: u8) -> Result<Self> {
        match code {
            0 => Ok(Self::Uint8),
            1 => Ok(Self::Int8),
            2 => Ok(Self::Uint16),
            3 => Ok(Self::Int16),
            4 => Ok(Self::Uint32),
            5 => Ok(Self::Int32),
            6 => Ok(Self::Float32),
            7 => Ok(Self::Float64),
            _ => Err(TileError::new(
                TileErrorCode::InvalidFieldValue,
                format!("Unsupported packed dtype code {code}."),
            )),
        }
    }

    pub fn byte_size(self) -> usize {
        match self {
            Self::Uint8 | Self::Int8 => 1,
            Self::Uint16 | Self::Int16 => 2,
            Self::Uint32 | Self::Int32 | Self::Float32 => 4,
            Self::Float64 => 8,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionMode {
    None,
    DeflateRaw,
}

impl Default for CompressionMode {
    fn default() -> Self {
        Self::None
    }
}

impl CompressionMode {
    fn code(self) -> u8 {
        match self {
            Self::None => 0,
            Self::DeflateRaw => 1,
        }
    }

    fn from_code(code: u8) -> Result<Self> {
        match code {
            0 => Ok(Self::None),
            1 => Ok(Self::DeflateRaw),
            _ => Err(TileError::new(
                TileErrorCode::InvalidFieldValue,
                format!("Invalid compression code {code}."),
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileDimensions {
    pub rows: u32,
    pub cols: u32,
    pub bands: u8,
}

impl TileDimensions {
    fn validate(self) -> Result<()> {
        if self.rows == 0 || self.cols == 0 || self.bands == 0 {
            return Err(TileError::new(
                TileErrorCode::InvalidFieldValue,
                "rows, cols, and bands must be > 0.",
            ));
        }
        Ok(())
    }

    fn total_samples(self) -> Result<u64> {
        let rows = u64::from(self.rows);
        let cols = u64::from(self.cols);
        let bands = u64::from(self.bands);
        rows.checked_mul(cols)
            .and_then(|v| v.checked_mul(bands))
            .ok_or_else(|| {
                TileError::new(
                    TileErrorCode::InvalidFieldValue,
                    "Invalid dimensions resulting in overflowed sample count.",
                )
            })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TileHeader {
    pub format_major: u8,
    pub tile_id: u64,
    pub mesh_kind: MeshKind,
    pub dtype: DType,
    pub endianness: Endianness,
    pub compression: CompressionMode,
    pub dimensions: TileDimensions,
    pub no_data_kind: u8,
    pub no_data_value_raw: [u8; 8],
    pub no_data: Option<f64>,
    pub payload_uncompressed_bytes: u64,
    pub payload_compressed_bytes: u64,
    pub payload_crc32: u32,
    pub header_crc32: u32,
}

#[derive(Debug, Clone)]
pub struct TileEncodeInput<'a> {
    pub tile_id: u64,
    pub mesh_kind: MeshKind,
    pub dtype: DType,
    pub endianness: Endianness,
    pub compression: CompressionMode,
    pub dimensions: TileDimensions,
    pub no_data: Option<f64>,
    pub payload: &'a [u8],
}

#[derive(Debug, Clone, PartialEq)]
pub struct EncodedTile {
    pub bytes: Vec<u8>,
    pub header: TileHeader,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedTile {
    pub header: TileHeader,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TileErrorCode {
    InvalidMagic,
    UnsupportedVersion,
    InvalidHeaderLength,
    InvalidFieldValue,
    MissingRequiredField,
    HeaderChecksumMismatch,
    InvalidPayloadLength,
    UnsupportedCompression,
    CompressionFailed,
    DecompressionFailed,
    PayloadChecksumMismatch,
}

impl TileErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidMagic => "INVALID_MAGIC",
            Self::UnsupportedVersion => "UNSUPPORTED_VERSION",
            Self::InvalidHeaderLength => "INVALID_HEADER_LENGTH",
            Self::InvalidFieldValue => "INVALID_FIELD_VALUE",
            Self::MissingRequiredField => "MISSING_REQUIRED_FIELD",
            Self::HeaderChecksumMismatch => "HEADER_CHECKSUM_MISMATCH",
            Self::InvalidPayloadLength => "INVALID_PAYLOAD_LENGTH",
            Self::UnsupportedCompression => "UNSUPPORTED_COMPRESSION",
            Self::CompressionFailed => "COMPRESSION_FAILED",
            Self::DecompressionFailed => "DECOMPRESSION_FAILED",
            Self::PayloadChecksumMismatch => "PAYLOAD_CHECKSUM_MISMATCH",
        }
    }
}

impl fmt::Display for TileErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileError {
    pub code: TileErrorCode,
    pub message: String,
}

impl TileError {
    pub fn new(code: TileErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for TileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for TileError {}

pub type Result<T> = std::result::Result<T, TileError>;

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

pub fn decode_payload_values(
    dtype: DType,
    endianness: Endianness,
    payload: &[u8],
) -> Result<Vec<f64>> {
    let value_size = dtype.byte_size();
    if payload.len() % value_size != 0 {
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

#[derive(Debug)]
struct ParsedHeader {
    header: TileHeader,
    compressed_payload_len: usize,
    uncompressed_payload_len: usize,
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

fn expected_payload_length(dimensions: TileDimensions, dtype: DType) -> Result<usize> {
    let total_samples = dimensions.total_samples()?;
    let byte_len = total_samples
        .checked_mul(dtype.byte_size() as u64)
        .ok_or_else(|| {
            TileError::new(
                TileErrorCode::InvalidPayloadLength,
                "Payload length overflow.",
            )
        })?;

    usize::try_from(byte_len).map_err(|_| {
        TileError::new(
            TileErrorCode::InvalidPayloadLength,
            "Payload length exceeds platform usize.",
        )
    })
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    let value_bytes = bytes.get(offset..offset + 4).ok_or_else(|| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "Could not read u32 field.",
        )
    })?;
    let arr: [u8; 4] = value_bytes.try_into().map_err(|_| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "Could not parse u32 field bytes.",
        )
    })?;
    Ok(u32::from_le_bytes(arr))
}

fn read_u64_le(bytes: &[u8], offset: usize) -> Result<u64> {
    let value_bytes = bytes.get(offset..offset + 8).ok_or_else(|| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "Could not read u64 field.",
        )
    })?;
    let arr: [u8; 8] = value_bytes.try_into().map_err(|_| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "Could not parse u64 field bytes.",
        )
    })?;
    Ok(u64::from_le_bytes(arr))
}

fn pack_dtype_endian(dtype: DType, endianness: Endianness) -> u8 {
    let endian_bit = match endianness {
        Endianness::Little => 0_u8,
        Endianness::Big => 0x80_u8,
    };
    endian_bit | dtype.code()
}

fn unpack_dtype_endian(value: u8) -> Result<(DType, Endianness)> {
    let dtype = DType::from_code(value & 0x7f)?;
    let endianness = if value & 0x80 == 0 {
        Endianness::Little
    } else {
        Endianness::Big
    };
    Ok((dtype, endianness))
}

fn validate_tile_id_for_mesh_kind(tile_id: u64, mesh_kind: MeshKind) -> Result<()> {
    if mesh_kind == MeshKind::Xyz {
        assert_valid_xyz_tile_id(tile_id)?;
    }
    Ok(())
}

fn assert_valid_xyz_tile_id(tile_id: u64) -> Result<()> {
    let zoom = tile_id >> 58;
    if zoom > 29 {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("XYZ tile_id zoom must be <= 29, got {zoom}."),
        ));
    }

    let quadkey = tile_id & ((1_u64 << 58) - 1);
    let max_quadkey = 1_u128 << (2 * zoom);
    if u128::from(quadkey) >= max_quadkey {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            "XYZ tile_id quadkey_integer must be < 4^zoom.",
        ));
    }

    Ok(())
}

fn encode_no_data_field(
    no_data: Option<f64>,
    dtype: DType,
    endianness: Endianness,
) -> Result<(u8, [u8; 8])> {
    let mut out = [0_u8; 8];
    let Some(value) = no_data else {
        return Ok((0, out));
    };

    if !value.is_finite() {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            "no_data must be finite number or null.",
        ));
    }

    let value_byte_size = dtype.byte_size();
    let mut encoded = vec![0_u8; value_byte_size];
    write_numeric_value(dtype, endianness, value, false, &mut encoded)?;

    match endianness {
        Endianness::Little => out[..value_byte_size].copy_from_slice(&encoded),
        Endianness::Big => out[8 - value_byte_size..].copy_from_slice(&encoded),
    }

    Ok((1, out))
}

fn decode_no_data_field(
    kind: u8,
    no_data_value_raw: [u8; 8],
    dtype: DType,
    endianness: Endianness,
) -> Result<Option<f64>> {
    if kind == 0 {
        if no_data_value_raw.iter().any(|byte| *byte != 0) {
            return Err(TileError::new(
                TileErrorCode::InvalidFieldValue,
                "no_data_value must be zero when no_data_kind=0.",
            ));
        }
        return Ok(None);
    }

    if kind != 1 {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("Unsupported no_data kind {kind}."),
        ));
    }

    let value_size = dtype.byte_size();
    let mut value_bytes = vec![0_u8; value_size];

    match endianness {
        Endianness::Little => {
            for byte in &no_data_value_raw[value_size..] {
                if *byte != 0 {
                    return Err(TileError::new(
                        TileErrorCode::InvalidFieldValue,
                        "no_data_value must pad most significant bytes with 0.",
                    ));
                }
            }
            value_bytes.copy_from_slice(&no_data_value_raw[..value_size]);
        }
        Endianness::Big => {
            let pad = 8 - value_size;
            for byte in &no_data_value_raw[..pad] {
                if *byte != 0 {
                    return Err(TileError::new(
                        TileErrorCode::InvalidFieldValue,
                        "no_data_value must pad most significant bytes with 0.",
                    ));
                }
            }
            value_bytes.copy_from_slice(&no_data_value_raw[pad..]);
        }
    }

    let value = read_numeric_value(dtype, endianness, &value_bytes)?;
    if !value.is_finite() {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            "no_data numeric value must be finite.",
        ));
    }

    Ok(Some(value))
}

fn write_numeric_value(
    dtype: DType,
    endianness: Endianness,
    value: f64,
    allow_float_nan: bool,
    out: &mut [u8],
) -> Result<()> {
    if out.len() != dtype.byte_size() {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            "Internal numeric write with invalid output buffer length.",
        ));
    }

    match dtype {
        DType::Uint8 => {
            let v = validate_integer_range(value, 0.0, u8::MAX as f64)?;
            out[0] = v as u8;
        }
        DType::Int8 => {
            let v = validate_integer_range(value, i8::MIN as f64, i8::MAX as f64)?;
            out[0] = (v as i8).to_ne_bytes()[0];
        }
        DType::Uint16 => {
            let v = validate_integer_range(value, 0.0, u16::MAX as f64)? as u16;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Int16 => {
            let v = validate_integer_range(value, i16::MIN as f64, i16::MAX as f64)? as i16;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Uint32 => {
            let v = validate_integer_range(value, 0.0, u32::MAX as f64)? as u32;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Int32 => {
            let v = validate_integer_range(value, i32::MIN as f64, i32::MAX as f64)? as i32;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Float32 => {
            if !value.is_finite() {
                if !(allow_float_nan && value.is_nan()) {
                    return Err(TileError::new(
                        TileErrorCode::InvalidFieldValue,
                        format!("Non-finite value: {value}"),
                    ));
                }
            }
            let v = value as f32;
            if value.is_finite() && !v.is_finite() {
                return Err(TileError::new(
                    TileErrorCode::InvalidFieldValue,
                    format!("Out-of-range value for float32: {value}"),
                ));
            }
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Float64 => {
            if !value.is_finite() {
                if !(allow_float_nan && value.is_nan()) {
                    return Err(TileError::new(
                        TileErrorCode::InvalidFieldValue,
                        format!("Non-finite value: {value}"),
                    ));
                }
            }
            let v = value;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
    }

    Ok(())
}

fn read_numeric_value(dtype: DType, endianness: Endianness, bytes: &[u8]) -> Result<f64> {
    if bytes.len() != dtype.byte_size() {
        return Err(TileError::new(
            TileErrorCode::InvalidPayloadLength,
            "Payload chunk size does not match dtype width.",
        ));
    }

    let value = match dtype {
        DType::Uint8 => f64::from(bytes[0]),
        DType::Int8 => f64::from(i8::from_ne_bytes([bytes[0]])),
        DType::Uint16 => {
            let arr: [u8; 2] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse uint16 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => u16::from_le_bytes(arr),
                Endianness::Big => u16::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Int16 => {
            let arr: [u8; 2] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse int16 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => i16::from_le_bytes(arr),
                Endianness::Big => i16::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Uint32 => {
            let arr: [u8; 4] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse uint32 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => u32::from_le_bytes(arr),
                Endianness::Big => u32::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Int32 => {
            let arr: [u8; 4] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse int32 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => i32::from_le_bytes(arr),
                Endianness::Big => i32::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Float32 => {
            let arr: [u8; 4] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse float32 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => f32::from_le_bytes(arr),
                Endianness::Big => f32::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Float64 => {
            let arr: [u8; 8] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse float64 payload value.",
                )
            })?;
            match endianness {
                Endianness::Little => f64::from_le_bytes(arr),
                Endianness::Big => f64::from_be_bytes(arr),
            }
        }
    };

    Ok(value)
}

fn validate_integer_range(value: f64, min: f64, max: f64) -> Result<f64> {
    if !value.is_finite() {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("Non-finite value: {value}"),
        ));
    }
    if value.fract() != 0.0 {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("Non-integer value: {value}"),
        ));
    }
    if value < min || value > max {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("Out-of-range value: {value}"),
        ));
    }
    Ok(value)
}

fn compress_payload(mode: CompressionMode, payload: &[u8]) -> Result<Vec<u8>> {
    match mode {
        CompressionMode::None => Ok(payload.to_vec()),
        CompressionMode::DeflateRaw => {
            let mut encoder = DeflateEncoder::new(Vec::new(), flate2::Compression::default());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tile_dims() -> TileDimensions {
        TileDimensions {
            rows: 2,
            cols: 2,
            bands: 1,
        }
    }

    #[test]
    fn roundtrip_uncompressed_payload() {
        let payload =
            encode_payload_values(DType::Uint16, Endianness::Little, &[10.0, 20.0, 30.0, 40.0])
                .expect("encode payload values");

        let encoded = encode_tile(TileEncodeInput {
            tile_id: 42,
            mesh_kind: MeshKind::JisX0410,
            dtype: DType::Uint16,
            endianness: Endianness::Little,
            compression: CompressionMode::None,
            dimensions: tile_dims(),
            no_data: None,
            payload: &payload,
        })
        .expect("encode tile");

        let decoded = decode_tile_minimal(&encoded.bytes).expect("decode tile");
        assert_eq!(decoded.header.tile_id, 42);
        assert_eq!(decoded.header.compression, CompressionMode::None);
        assert_eq!(decoded.payload, payload);

        let values = decode_payload_values(
            decoded.header.dtype,
            decoded.header.endianness,
            &decoded.payload,
        )
        .expect("decode payload values");
        assert_eq!(values, vec![10.0, 20.0, 30.0, 40.0]);
    }

    #[test]
    fn roundtrip_deflate_payload() {
        let payload =
            encode_payload_values(DType::Uint16, Endianness::Little, &[1.0, 2.0, 3.0, 4.0])
                .expect("encode payload values");

        let encoded = encode_tile(TileEncodeInput {
            tile_id: 1004,
            mesh_kind: MeshKind::JisX0410,
            dtype: DType::Uint16,
            endianness: Endianness::Little,
            compression: CompressionMode::DeflateRaw,
            dimensions: tile_dims(),
            no_data: None,
            payload: &payload,
        })
        .expect("encode tile");

        let decoded = decode_tile_minimal(&encoded.bytes).expect("decode tile");
        assert_eq!(decoded.header.compression, CompressionMode::DeflateRaw);
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn rejects_invalid_magic() {
        let payload =
            encode_payload_values(DType::Uint8, Endianness::Little, &[1.0, 2.0, 3.0, 4.0])
                .expect("encode payload values");

        let encoded = encode_tile(TileEncodeInput {
            tile_id: 1,
            mesh_kind: MeshKind::JisX0410,
            dtype: DType::Uint8,
            endianness: Endianness::Little,
            compression: CompressionMode::None,
            dimensions: tile_dims(),
            no_data: None,
            payload: &payload,
        })
        .expect("encode tile");

        let mut malformed = encoded.bytes;
        malformed[1] = 0;
        let error = decode_tile_minimal(&malformed).expect_err("should fail");
        assert_eq!(error.code, TileErrorCode::InvalidMagic);
    }

    #[test]
    fn rejects_invalid_xyz_tile_id() {
        let payload =
            encode_payload_values(DType::Uint8, Endianness::Little, &[1.0, 2.0, 3.0, 4.0])
                .expect("encode payload values");

        let bad_tile_id = (1_u64 << 58) | 16_u64;
        let error = encode_tile(TileEncodeInput {
            tile_id: bad_tile_id,
            mesh_kind: MeshKind::Xyz,
            dtype: DType::Uint8,
            endianness: Endianness::Little,
            compression: CompressionMode::None,
            dimensions: tile_dims(),
            no_data: None,
            payload: &payload,
        })
        .expect_err("should reject bad xyz tile id");

        assert_eq!(error.code, TileErrorCode::InvalidFieldValue);
    }
}
