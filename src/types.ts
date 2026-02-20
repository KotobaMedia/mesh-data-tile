export type Endianness = 'little' | 'big';

export type DType =
  | 'uint8'
  | 'int8'
  | 'uint16'
  | 'int16'
  | 'uint32'
  | 'int32'
  | 'float32'
  | 'float64';

export type MeshKind = 'jis-x0410' | 'xyz';

export type CompressionMode = 'none' | 'deflate-raw';

export interface TileDimensions {
  rows: number;
  cols: number;
  bands: number;
}

export interface TilePayloadInfo {
  compressed_bytes: number;
  uncompressed_bytes: number;
}

export interface TileChecksum {
  algorithm: 'crc32';
  payload_crc32: string;
  header_crc32: string;
}

export interface TileHeader {
  format_major: number;
  tile_id: bigint;
  mesh_kind: MeshKind;
  dtype: DType;
  endianness: Endianness;
  compression: CompressionMode;
  dimensions: TileDimensions;
  no_data: number | null;
  payload: TilePayloadInfo;
  checksum: TileChecksum;
}

export interface XyzTileCoordinates {
  zoom: number;
  x: number;
  y: number;
}

export interface DecodedXyzTileId extends XyzTileCoordinates {
  quadkey_integer: bigint;
}

export type NumericArrayLike =
  | ArrayLike<number>
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

export interface TileEncodeInput {
  tile_id: bigint | number | string;
  mesh_kind: MeshKind;
  rows: number;
  cols: number;
  bands: number;
  dtype: DType;
  endianness: Endianness;
  compression?: CompressionMode;
  no_data?: number | null;
  data: NumericArrayLike;
}

export type TypedArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

export type DecodedValue = number | null;
export type DecodedValues = ArrayLike<DecodedValue>;

export interface DecodedTile {
  header: TileHeader;
  data: DecodedValues;
  payload: Uint8Array;
}

export interface InspectTileResult {
  header: TileHeader;
  header_length: number;
  payload_offset: number;
  payload_length: number;
  header_crc32: string;
}

export type TileErrorCode =
  | 'INVALID_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_HEADER_LENGTH'
  | 'INVALID_FIELD_VALUE'
  | 'MISSING_REQUIRED_FIELD'
  | 'HEADER_CHECKSUM_MISMATCH'
  | 'INVALID_PAYLOAD_LENGTH'
  | 'UNSUPPORTED_COMPRESSION'
  | 'COMPRESSION_FAILED'
  | 'DECOMPRESSION_FAILED'
  | 'PAYLOAD_CHECKSUM_MISMATCH'
  | 'INTERNAL_FAILURE';

export interface TileErrorOptions {
  code: TileErrorCode;
  message?: string;
  cause?: unknown;
}
