pub const TILE_FIXED_HEADER_LENGTH: usize = 58;
pub const TILE_VERSION_MAJOR: u8 = 1;

pub(crate) const MAGIC: [u8; 4] = *b"MTI1";
pub(crate) const HEADER_CHECKSUM_OFFSET: usize = 54;
pub(crate) const HEADER_CHECKSUM_INPUT_LENGTH: usize = HEADER_CHECKSUM_OFFSET;

pub(crate) const OFFSET_FORMAT_MAJOR: usize = 4;
pub(crate) const OFFSET_TILE_ID: usize = 5;
pub(crate) const OFFSET_MESH_KIND: usize = 13;
pub(crate) const OFFSET_DTYPE_ENDIAN: usize = 14;
pub(crate) const OFFSET_COMPRESSION: usize = 15;
pub(crate) const OFFSET_ROWS: usize = 16;
pub(crate) const OFFSET_COLS: usize = 20;
pub(crate) const OFFSET_BANDS: usize = 24;
pub(crate) const OFFSET_NO_DATA_KIND: usize = 25;
pub(crate) const OFFSET_NO_DATA_VALUE: usize = 26;
pub(crate) const OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH: usize = 34;
pub(crate) const OFFSET_COMPRESSED_PAYLOAD_LENGTH: usize = 42;
pub(crate) const OFFSET_PAYLOAD_CHECKSUM: usize = 50;
