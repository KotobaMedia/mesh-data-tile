import {
  CompressionMode,
  DType,
  Endianness,
  InspectTileResult,
  MeshKind,
  NumericArrayLike,
  TileDimensions,
  TileEncodeInput,
  TileHeader,
  DecodedTile,
} from './types.js';
import { createError } from './errors.js';
import { crc32 } from './crc32.js';
import { byteLengthForDType, decodeValues, encodeValues } from './payload.js';
import { compressPayload, decompressPayload, isCompressionModeSupported } from './compression.js';
import { assertValidXyzTileId } from './tile-id.js';

const MAGIC = new Uint8Array([0x4d, 0x54, 0x49, 0x31]); // "MTI1"
const VERSION_MAJOR = 1;
const FIXED_HEADER_LENGTH = 58;
const HEADER_CHECKSUM_OFFSET = 54;
const HEADER_CHECKSUM_INPUT_LENGTH = HEADER_CHECKSUM_OFFSET;

const OFFSET_FORMAT_MAJOR = 4;
const OFFSET_TILE_ID = 5;
const OFFSET_MESH_KIND = 13;
const OFFSET_DTYPE_ENDIAN = 14;
const OFFSET_COMPRESSION = 15;
const OFFSET_ROWS = 16;
const OFFSET_COLS = 20;
const OFFSET_BANDS = 24;
const OFFSET_NO_DATA_KIND = 25;
const OFFSET_NO_DATA_VALUE = 26;
const OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH = 34;
const OFFSET_COMPRESSED_PAYLOAD_LENGTH = 42;
const OFFSET_PAYLOAD_CHECKSUM = 50;

const MAX_U64 = (1n << 64n) - 1n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const DTYPE_TO_CODE: Record<DType, number> = {
  uint8: 0,
  int8: 1,
  uint16: 2,
  int16: 3,
  uint32: 4,
  int32: 5,
  float32: 6,
  float64: 7,
};

const CODE_TO_DTYPE: Record<number, DType> = {
  0: 'uint8',
  1: 'int8',
  2: 'uint16',
  3: 'int16',
  4: 'uint32',
  5: 'int32',
  6: 'float32',
  7: 'float64',
};

const MESH_KIND_TO_CODE: Record<MeshKind, number> = {
  'jis-x0410': 1,
  xyz: 2,
};

const CODE_TO_MESH_KIND: Record<number, MeshKind> = {
  1: 'jis-x0410',
  2: 'xyz',
};

const COMPRESSION_TO_CODE: Record<CompressionMode, number> = {
  none: 0,
  'deflate-raw': 1,
};

const CODE_TO_COMPRESSION: Record<number, CompressionMode> = {
  0: 'none',
  1: 'deflate-raw',
};

export interface EncodeResult {
  bytes: Uint8Array;
  header: TileHeader;
}

function readU64LE(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

function writeU64LE(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true);
}

function toArrayLike(values: NumericArrayLike): ArrayLike<number> {
  if (ArrayBuffer.isView(values)) {
    return values;
  }
  return Array.from(values as ArrayLike<number>);
}

function normalizeTileId(tileId: bigint | number | string): bigint {
  let parsed: bigint;
  if (typeof tileId === 'bigint') {
    parsed = tileId;
  } else if (typeof tileId === 'number') {
    if (!Number.isInteger(tileId)) {
      throw createError('INVALID_FIELD_VALUE', 'tile_id must be an integer.');
    }
    parsed = BigInt(tileId);
  } else {
    if (!/^\d+$/.test(tileId)) {
      throw createError('INVALID_FIELD_VALUE', 'tile_id string must be unsigned integer digits.');
    }
    parsed = BigInt(tileId);
  }

  if (parsed < 0n || parsed > MAX_U64) {
    throw createError('INVALID_FIELD_VALUE', `tile_id must fit u64: ${parsed.toString()}`);
  }
  return parsed;
}

function normalizeDimension(value: number, field: 'rows' | 'cols'): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw createError('INVALID_FIELD_VALUE', `${field} must be a positive integer.`);
  }
  if (value > 0xffffffff) {
    throw createError('INVALID_FIELD_VALUE', `${field} must fit u32.`);
  }
  return value;
}

function normalizeBands(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw createError('INVALID_FIELD_VALUE', 'bands must be a positive integer.');
  }
  if (value > 0xff) {
    throw createError('INVALID_FIELD_VALUE', 'bands must fit u8.');
  }
  return value;
}

function totalSamples(dimensions: TileDimensions): number {
  const count = dimensions.rows * dimensions.cols * dimensions.bands;
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw createError('INVALID_FIELD_VALUE', 'Invalid dimensions resulting in non-safe sample count.');
  }
  return count;
}

function packDTypeEndian(dtype: DType, endianness: Endianness): number {
  const dtypeCode = DTYPE_TO_CODE[dtype];
  if (dtypeCode === undefined) {
    throw createError('INVALID_FIELD_VALUE', `Unsupported dtype "${dtype}".`);
  }
  const endianBit = endianness === 'big' ? 0x80 : 0x00;
  return endianBit | dtypeCode;
}

function unpackDTypeEndian(packed: number): { dtype: DType; endianness: Endianness } {
  const dtypeCode = packed & 0x7f;
  const dtype = CODE_TO_DTYPE[dtypeCode];
  if (!dtype) {
    throw createError('INVALID_FIELD_VALUE', `Unsupported packed dtype code ${dtypeCode}.`);
  }
  const endianness: Endianness = (packed & 0x80) !== 0 ? 'big' : 'little';
  return { dtype, endianness };
}

function u64ToSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw createError('INVALID_HEADER_LENGTH', `${label} exceeds safe integer bounds.`);
  }
  return Number(value);
}

function verifyHeaderChecksum(headerBytes: Uint8Array, expected: number): void {
  const actual = crc32(headerBytes.slice(0, HEADER_CHECKSUM_INPUT_LENGTH));
  if (actual !== expected) {
    throw createError(
      'HEADER_CHECKSUM_MISMATCH',
      `Header checksum mismatch. expected=${expected.toString(16).padStart(8, '0')} actual=${actual.toString(16).padStart(8, '0')}`
    );
  }
}

function parseEnum<T extends string>(value: number, map: Record<number, T>, label: string): T {
  const parsed = map[value];
  if (parsed === undefined) {
    throw createError('INVALID_FIELD_VALUE', `Invalid ${label} code ${value}.`);
  }
  return parsed;
}

function validateNoData(noData: number | null | undefined): number | null {
  if (noData === undefined || noData === null) {
    return null;
  }
  if (!Number.isFinite(noData)) {
    throw createError('INVALID_FIELD_VALUE', 'no_data must be finite number or null.');
  }
  return noData;
}

function encodeNoDataField(
  value: number | null,
  dtype: DType,
  littleEndian: boolean
): { kind: 0 | 1; bytes: Uint8Array } {
  const bytes = new Uint8Array(8);
  if (value === null) {
    return { kind: 0, bytes };
  }

  const encoded = encodeValues(dtype, [value], 1, littleEndian);
  if (littleEndian) {
    bytes.set(encoded, 0);
  } else {
    bytes.set(encoded, 8 - encoded.byteLength);
  }
  return { kind: 1, bytes };
}

function decodeNoDataField(kind: number, bytes: Uint8Array, dtype: DType, littleEndian: boolean): number | null {
  if (bytes.byteLength !== 8) {
    throw createError('INTERNAL_FAILURE', 'no_data field must be exactly 8 bytes.');
  }

  const valueByteLength = byteLengthForDType(dtype);
  if (kind === 0) {
    for (const byte of bytes) {
      if (byte !== 0) {
        throw createError('INVALID_FIELD_VALUE', 'no_data_value must be zero when no_data_kind=0.');
      }
    }
    return null;
  }

  if (kind !== 1) {
    throw createError('INVALID_FIELD_VALUE', `Unsupported no_data kind ${kind}.`);
  }

  const valueBytes = new Uint8Array(valueByteLength);
  if (littleEndian) {
    for (let i = valueByteLength; i < 8; i += 1) {
      if (bytes[i] !== 0) {
        throw createError('INVALID_FIELD_VALUE', 'no_data_value must pad most significant bytes with 0.');
      }
    }
    valueBytes.set(bytes.subarray(0, valueByteLength), 0);
  } else {
    const padLength = 8 - valueByteLength;
    for (let i = 0; i < padLength; i += 1) {
      if (bytes[i] !== 0) {
        throw createError('INVALID_FIELD_VALUE', 'no_data_value must pad most significant bytes with 0.');
      }
    }
    valueBytes.set(bytes.subarray(padLength), 0);
  }

  const decoded = decodeValues(dtype, valueBytes, littleEndian);
  const parsed = decoded[0];
  if (!Number.isFinite(parsed)) {
    throw createError('INVALID_FIELD_VALUE', 'no_data numeric value must be finite.');
  }
  return parsed;
}

function normalizeCompression(compression: CompressionMode | undefined): CompressionMode {
  const mode = compression ?? 'none';
  if (!(mode in COMPRESSION_TO_CODE)) {
    throw createError('INVALID_FIELD_VALUE', `Unsupported compression "${mode}".`);
  }
  if (mode !== 'none' && !isCompressionModeSupported(mode)) {
    throw createError('UNSUPPORTED_COMPRESSION', `Compression mode "${mode}" is not supported in this runtime.`);
  }
  return mode;
}

function validateTileIdForMeshKind(tileId: bigint, meshKind: MeshKind): bigint {
  if (meshKind === 'xyz') {
    return assertValidXyzTileId(tileId);
  }
  return tileId;
}

export function makeTileHeader(
  input: TileEncodeInput,
  payloadBytes: number,
  compressedBytes: number,
  payloadCrc32: number,
  headerCrc32: number
): TileHeader {
  return {
    format_major: VERSION_MAJOR,
    tile_id: normalizeTileId(input.tile_id),
    mesh_kind: input.mesh_kind,
    dtype: input.dtype,
    endianness: input.endianness,
    compression: input.compression ?? 'none',
    dimensions: {
      rows: input.rows,
      cols: input.cols,
      bands: input.bands,
    },
    no_data: input.no_data ?? null,
    payload: {
      compressed_bytes: compressedBytes,
      uncompressed_bytes: payloadBytes,
    },
    checksum: {
      algorithm: 'crc32',
      payload_crc32: payloadCrc32.toString(16).padStart(8, '0'),
      header_crc32: headerCrc32.toString(16).padStart(8, '0'),
    },
  };
}

function encodeFixedHeader(params: {
  tileId: bigint;
  meshKind: MeshKind;
  dtype: DType;
  endianness: Endianness;
  compression: CompressionMode;
  rows: number;
  cols: number;
  bands: number;
  noData: number | null;
  uncompressedPayloadLength: bigint;
  compressedPayloadLength: bigint;
  payloadCrc32: number;
}): Uint8Array {
  const out = new Uint8Array(FIXED_HEADER_LENGTH);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out.set(MAGIC, 0);
  view.setUint8(OFFSET_FORMAT_MAJOR, VERSION_MAJOR);

  writeU64LE(view, OFFSET_TILE_ID, params.tileId);
  view.setUint8(OFFSET_MESH_KIND, MESH_KIND_TO_CODE[params.meshKind]);
  view.setUint8(OFFSET_DTYPE_ENDIAN, packDTypeEndian(params.dtype, params.endianness));
  view.setUint8(OFFSET_COMPRESSION, COMPRESSION_TO_CODE[params.compression]);
  view.setUint32(OFFSET_ROWS, params.rows, true);
  view.setUint32(OFFSET_COLS, params.cols, true);
  view.setUint8(OFFSET_BANDS, params.bands);

  const noData = encodeNoDataField(params.noData, params.dtype, params.endianness === 'little');
  view.setUint8(OFFSET_NO_DATA_KIND, noData.kind);
  out.set(noData.bytes, OFFSET_NO_DATA_VALUE);

  writeU64LE(view, OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH, params.uncompressedPayloadLength);
  writeU64LE(view, OFFSET_COMPRESSED_PAYLOAD_LENGTH, params.compressedPayloadLength);
  view.setUint32(OFFSET_PAYLOAD_CHECKSUM, params.payloadCrc32, true);
  view.setUint32(HEADER_CHECKSUM_OFFSET, 0, true);

  const headerCrc32 = crc32(out.slice(0, HEADER_CHECKSUM_INPUT_LENGTH));
  view.setUint32(HEADER_CHECKSUM_OFFSET, headerCrc32, true);
  return out;
}

export async function encodeTile(input: TileEncodeInput): Promise<EncodeResult> {
  const tileId = normalizeTileId(input.tile_id);
  if (!(input.mesh_kind in MESH_KIND_TO_CODE)) {
    throw createError('MISSING_REQUIRED_FIELD', 'mesh_kind is required and must be enum value.');
  }
  validateTileIdForMeshKind(tileId, input.mesh_kind);
  if (!(input.dtype in DTYPE_TO_CODE)) {
    throw createError('MISSING_REQUIRED_FIELD', 'dtype is required and must be enum value.');
  }
  if (input.endianness !== 'little' && input.endianness !== 'big') {
    throw createError('MISSING_REQUIRED_FIELD', 'endianness is required and must be little or big.');
  }

  const rows = normalizeDimension(input.rows, 'rows');
  const cols = normalizeDimension(input.cols, 'cols');
  const bands = normalizeBands(input.bands);
  const compression = normalizeCompression(input.compression);
  const noData = validateNoData(input.no_data);

  const dimensions: TileDimensions = { rows, cols, bands };
  const elementCount = totalSamples(dimensions);
  const littleEndian = input.endianness === 'little';
  const rawPayload = encodeValues(input.dtype, toArrayLike(input.data), elementCount, littleEndian);

  const expectedRawLength = elementCount * byteLengthForDType(input.dtype);
  if (rawPayload.byteLength !== expectedRawLength) {
    throw createError(
      'INVALID_PAYLOAD_LENGTH',
      `Payload byte length mismatch. expected=${expectedRawLength} got=${rawPayload.byteLength}`
    );
  }

  const compressedPayload = await compressPayload(compression, rawPayload);
  const payloadCrc32 = crc32(rawPayload);
  const headerBytes = encodeFixedHeader({
    tileId,
    meshKind: input.mesh_kind,
    dtype: input.dtype,
    endianness: input.endianness,
    compression,
    rows,
    cols,
    bands,
    noData,
    uncompressedPayloadLength: BigInt(rawPayload.byteLength),
    compressedPayloadLength: BigInt(compressedPayload.byteLength),
    payloadCrc32,
  });

  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const headerCrc32 = view.getUint32(HEADER_CHECKSUM_OFFSET, true);
  const out = new Uint8Array(FIXED_HEADER_LENGTH + compressedPayload.byteLength);
  out.set(headerBytes, 0);
  out.set(compressedPayload, FIXED_HEADER_LENGTH);

  const header = makeTileHeader(
    {
      ...input,
      tile_id: tileId,
      compression,
      no_data: noData,
    },
    rawPayload.byteLength,
    compressedPayload.byteLength,
    payloadCrc32,
    headerCrc32
  );

  return { bytes: out, header };
}

export function inspectTile(bytes: Uint8Array): InspectTileResult {
  if (bytes.length < FIXED_HEADER_LENGTH) {
    throw createError('INVALID_HEADER_LENGTH', 'File shorter than fixed header.');
  }

  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2] || bytes[3] !== MAGIC[3]) {
    throw createError('INVALID_MAGIC', 'Invalid file magic.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatMajor = view.getUint8(OFFSET_FORMAT_MAJOR);
  if (formatMajor !== VERSION_MAJOR) {
    throw createError('UNSUPPORTED_VERSION', `Unsupported major version ${formatMajor}.`);
  }

  const headerBytes = bytes.slice(0, FIXED_HEADER_LENGTH);
  const headerCrc32 = view.getUint32(HEADER_CHECKSUM_OFFSET, true);
  verifyHeaderChecksum(headerBytes, headerCrc32);

  const tileId = readU64LE(view, OFFSET_TILE_ID);
  const meshKind = parseEnum(view.getUint8(OFFSET_MESH_KIND), CODE_TO_MESH_KIND, 'mesh_kind');
  validateTileIdForMeshKind(tileId, meshKind);
  const packedDType = view.getUint8(OFFSET_DTYPE_ENDIAN);
  const { dtype, endianness } = unpackDTypeEndian(packedDType);
  const compression = parseEnum(view.getUint8(OFFSET_COMPRESSION), CODE_TO_COMPRESSION, 'compression');
  const rows = view.getUint32(OFFSET_ROWS, true);
  const cols = view.getUint32(OFFSET_COLS, true);
  const bands = view.getUint8(OFFSET_BANDS);
  const noDataKind = view.getUint8(OFFSET_NO_DATA_KIND);
  const noDataValueBytes = bytes.slice(OFFSET_NO_DATA_VALUE, OFFSET_NO_DATA_VALUE + 8);

  const uncompressedPayloadLengthU64 = readU64LE(view, OFFSET_UNCOMPRESSED_PAYLOAD_LENGTH);
  const compressedPayloadLengthU64 = readU64LE(view, OFFSET_COMPRESSED_PAYLOAD_LENGTH);
  const payloadCrc32 = view.getUint32(OFFSET_PAYLOAD_CHECKSUM, true);

  if (rows === 0 || cols === 0 || bands === 0) {
    throw createError('INVALID_FIELD_VALUE', 'rows, cols, and bands must be > 0.');
  }

  const noData = decodeNoDataField(noDataKind, noDataValueBytes, dtype, endianness === 'little');

  const compressedPayloadLength = u64ToSafeNumber(compressedPayloadLengthU64, 'compressed payload length');
  const uncompressedPayloadLength = u64ToSafeNumber(uncompressedPayloadLengthU64, 'uncompressed payload length');
  if (bytes.length < FIXED_HEADER_LENGTH + compressedPayloadLength) {
    throw createError('INVALID_PAYLOAD_LENGTH', 'File shorter than declared compressed payload length.');
  }

  const payloadOffset = FIXED_HEADER_LENGTH;
  const header: TileHeader = {
    format_major: formatMajor,
    tile_id: tileId,
    mesh_kind: meshKind,
    dtype,
    endianness,
    compression,
    dimensions: {
      rows,
      cols,
      bands,
    },
    no_data: noData,
    payload: {
      compressed_bytes: compressedPayloadLength,
      uncompressed_bytes: uncompressedPayloadLength,
    },
    checksum: {
      algorithm: 'crc32',
      payload_crc32: payloadCrc32.toString(16).padStart(8, '0'),
      header_crc32: headerCrc32.toString(16).padStart(8, '0'),
    },
  };

  return {
    header,
    header_length: FIXED_HEADER_LENGTH,
    payload_offset: payloadOffset,
    payload_length: compressedPayloadLength,
    header_crc32: header.checksum.header_crc32,
  };
}

export async function decodeTile(bytes: Uint8Array): Promise<DecodedTile> {
  const info = inspectTile(bytes);
  const header = info.header;

  if (header.compression !== 'none' && !isCompressionModeSupported(header.compression)) {
    throw createError(
      'UNSUPPORTED_COMPRESSION',
      `Compression mode "${header.compression}" is not supported in this runtime.`
    );
  }

  const payload = bytes.slice(info.payload_offset, info.payload_offset + info.payload_length);
  if (payload.length !== info.payload_length) {
    throw createError('INVALID_PAYLOAD_LENGTH', 'Payload length does not match fixed header metadata.');
  }

  const decompressed = await decompressPayload(header.compression, payload);
  if (decompressed.byteLength !== header.payload.uncompressed_bytes) {
    throw createError(
      'INVALID_PAYLOAD_LENGTH',
      `Uncompressed payload length mismatch. expected=${header.payload.uncompressed_bytes} got=${decompressed.byteLength}`
    );
  }

  const payloadCrc32 = crc32(decompressed);
  const expectedPayloadCrc32 = Number(BigInt('0x' + header.checksum.payload_crc32));
  if (payloadCrc32 !== expectedPayloadCrc32) {
    throw createError('PAYLOAD_CHECKSUM_MISMATCH', 'Payload checksum does not match header.');
  }

  const sampleCount = totalSamples(header.dimensions);
  const expectedDecodedBytes = sampleCount * byteLengthForDType(header.dtype);
  if (decompressed.byteLength !== expectedDecodedBytes) {
    throw createError(
      'INVALID_PAYLOAD_LENGTH',
      `Decoded payload length mismatch. expected=${expectedDecodedBytes} got=${decompressed.byteLength}`
    );
  }

  const data = decodeValues(header.dtype, decompressed, header.endianness === 'little');
  return {
    header,
    data,
    payload: decompressed,
  };
}

export const TILE_FIXED_HEADER_LENGTH = FIXED_HEADER_LENGTH;
export const TILE_PAYLOAD_OFFSET = FIXED_HEADER_LENGTH;
export const TILE_VERSION_MAJOR = VERSION_MAJOR;
export const TILE_HEADER_CHECKSUM_INPUT_LENGTH = HEADER_CHECKSUM_INPUT_LENGTH;
export const TILE_DTYPE_CODES: Readonly<Record<DType, number>> = DTYPE_TO_CODE;
export const TILE_MESH_KIND_CODES: Readonly<Record<MeshKind, number>> = MESH_KIND_TO_CODE;
export const TILE_COMPRESSION_CODES: Readonly<Record<CompressionMode, number>> = COMPRESSION_TO_CODE;

export function encodePackedDTypeEndianness(dtype: DType, endianness: Endianness): number {
  return packDTypeEndian(dtype, endianness);
}

export function decodePackedDTypeEndianness(packed: number): { dtype: DType; endianness: Endianness } {
  return unpackDTypeEndian(packed);
}
