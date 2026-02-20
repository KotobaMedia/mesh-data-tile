#![doc = include_str!("../README.md")]

use std::fmt;

mod common;
mod consts;
mod decoder;
mod encoder;

pub use consts::{TILE_FIXED_HEADER_LENGTH, TILE_VERSION_MAJOR};
pub use decoder::{decode_payload_values, decode_tile_minimal, inspect_tile};
pub use encoder::{encode_payload_values, encode_tile};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshKind {
    JisX0410,
    Xyz,
}

impl MeshKind {
    pub(crate) fn code(self) -> u8 {
        match self {
            Self::JisX0410 => 1,
            Self::Xyz => 2,
        }
    }

    pub(crate) fn from_code(code: u8) -> Result<Self> {
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
    pub(crate) fn code(self) -> u8 {
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

    pub(crate) fn from_code(code: u8) -> Result<Self> {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CompressionMode {
    #[default]
    None,
    DeflateRaw,
}

impl CompressionMode {
    pub(crate) fn code(self) -> u8 {
        match self {
            Self::None => 0,
            Self::DeflateRaw => 1,
        }
    }

    pub(crate) fn from_code(code: u8) -> Result<Self> {
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
    pub(crate) fn validate(self) -> Result<()> {
        if self.rows == 0 || self.cols == 0 || self.bands == 0 {
            return Err(TileError::new(
                TileErrorCode::InvalidFieldValue,
                "rows, cols, and bands must be > 0.",
            ));
        }
        Ok(())
    }

    pub(crate) fn total_samples(self) -> Result<u64> {
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
            decoded.header.no_data,
        )
        .expect("decode payload values");
        assert_eq!(values, vec![Some(10.0), Some(20.0), Some(30.0), Some(40.0)]);
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

    #[test]
    fn decodes_no_data_samples_to_none() {
        let payload =
            encode_payload_values(DType::Uint16, Endianness::Little, &[10.0, 20.0, 30.0, 20.0])
                .expect("encode payload values");

        let encoded = encode_tile(TileEncodeInput {
            tile_id: 2001,
            mesh_kind: MeshKind::JisX0410,
            dtype: DType::Uint16,
            endianness: Endianness::Little,
            compression: CompressionMode::None,
            dimensions: tile_dims(),
            no_data: Some(20.0),
            payload: &payload,
        })
        .expect("encode tile");

        let decoded = decode_tile_minimal(&encoded.bytes).expect("decode tile");
        let values = decode_payload_values(
            decoded.header.dtype,
            decoded.header.endianness,
            &decoded.payload,
            decoded.header.no_data,
        )
        .expect("decode payload values");

        assert_eq!(values, vec![Some(10.0), None, Some(30.0), None]);
    }
}
