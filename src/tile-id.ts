import { createError } from './errors.js';
import { DecodedXyzTileId, XyzTileCoordinates } from './types.js';

const U64_BITS = 64n;
const ZOOM_BITS = 6n;
const QUADKEY_BITS = U64_BITS - ZOOM_BITS;
const ZOOM_SHIFT = QUADKEY_BITS;
const QUADKEY_MASK = (1n << QUADKEY_BITS) - 1n;
const MAX_U64 = (1n << U64_BITS) - 1n;
const MAX_ZOOM = Number(QUADKEY_BITS / 2n); // 29

function normalizeUnsignedU64(value: bigint | number | string, label: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_U64) {
      throw createError('INVALID_FIELD_VALUE', `${label} must fit u64: ${value.toString()}`);
    }
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw createError('INVALID_FIELD_VALUE', `${label} number must be a non-negative safe integer.`);
    }
    return BigInt(value);
  }

  if (!/^\d+$/.test(value)) {
    throw createError('INVALID_FIELD_VALUE', `${label} string must be unsigned integer digits.`);
  }

  const parsed = BigInt(value);
  if (parsed < 0n || parsed > MAX_U64) {
    throw createError('INVALID_FIELD_VALUE', `${label} must fit u64: ${parsed.toString()}`);
  }
  return parsed;
}

function normalizeZoom(zoom: number): number {
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_ZOOM) {
    throw createError('INVALID_FIELD_VALUE', `zoom must be an integer in [0, ${MAX_ZOOM}].`);
  }
  return zoom;
}

function normalizeCoordinate(value: number, label: 'x' | 'y', zoom: number): number {
  const maxExclusive = 2 ** zoom;
  if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
    throw createError(
      'INVALID_FIELD_VALUE',
      `${label} must be an integer in [0, ${maxExclusive - 1}] for zoom ${zoom}.`
    );
  }
  return value;
}

export const XYZ_TILE_ID_ZOOM_BITS = Number(ZOOM_BITS);
export const XYZ_TILE_ID_QUADKEY_BITS = Number(QUADKEY_BITS);
export const XYZ_TILE_ID_MAX_ZOOM = MAX_ZOOM;

export function encodeXyzTileId(tile: XyzTileCoordinates): bigint {
  const zoom = normalizeZoom(tile.zoom);
  const x = normalizeCoordinate(tile.x, 'x', zoom);
  const y = normalizeCoordinate(tile.y, 'y', zoom);

  let quadkeyInteger = 0n;
  for (let bit = zoom - 1; bit >= 0; bit -= 1) {
    const xBit = (x >> bit) & 1;
    const yBit = (y >> bit) & 1;
    const digit = xBit | (yBit << 1);
    quadkeyInteger = (quadkeyInteger << 2n) | BigInt(digit);
  }

  return (BigInt(zoom) << ZOOM_SHIFT) | quadkeyInteger;
}

export function decodeXyzTileId(tileId: bigint | number | string): DecodedXyzTileId {
  const normalized = normalizeUnsignedU64(tileId, 'tile_id');

  const zoom = Number(normalized >> ZOOM_SHIFT);
  if (zoom > MAX_ZOOM) {
    throw createError('INVALID_FIELD_VALUE', `xyz tile_id zoom must be <= ${MAX_ZOOM}; got ${zoom}.`);
  }

  const quadkeyInteger = normalized & QUADKEY_MASK;
  const quadkeyBitsUsed = BigInt(zoom * 2);
  if (quadkeyBitsUsed < QUADKEY_BITS) {
    const unusedBits = quadkeyInteger >> quadkeyBitsUsed;
    if (unusedBits !== 0n) {
      throw createError('INVALID_FIELD_VALUE', 'xyz tile_id has non-zero quadkey bits above the zoom length.');
    }
  }

  let x = 0;
  let y = 0;
  for (let level = 0; level < zoom; level += 1) {
    const shift = BigInt((zoom - level - 1) * 2);
    const digit = Number((quadkeyInteger >> shift) & 0x3n);
    x = (x << 1) | (digit & 0b01);
    y = (y << 1) | ((digit & 0b10) >> 1);
  }

  return {
    zoom,
    x,
    y,
    quadkey_integer: quadkeyInteger,
  };
}

export function assertValidXyzTileId(tileId: bigint | number | string): bigint {
  const normalized = normalizeUnsignedU64(tileId, 'tile_id');
  decodeXyzTileId(normalized);
  return normalized;
}
