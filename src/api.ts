import { readFile, writeFile } from 'node:fs/promises';
import { createError } from './errors.js';
import { decodeTile, encodeTile, inspectTile } from './tile-format.js';
import { decodeXyzTileId } from './tile-id.js';
import type { EncodeResult } from './tile-format.js';
import type { DecodedTile, InspectTileResult, TileEncodeInput } from './types.js';

export interface InspectTileTextResult {
  info: InspectTileResult;
  text: string;
}

export interface DecodeTileCsvResult {
  decoded: DecodedTile;
  csv: string;
}

export function formatInspectOutput(info: InspectTileResult): string {
  const lines = [
    `Format Major: ${info.header.format_major}`,
    `Tile ID: ${info.header.tile_id.toString()}`,
    `Mesh Kind: ${info.header.mesh_kind}`,
    `DType: ${info.header.dtype}`,
    `Endianness: ${info.header.endianness}`,
    `Compression: ${info.header.compression}`,
    `Rows: ${info.header.dimensions.rows}`,
    `Cols: ${info.header.dimensions.cols}`,
    `Bands: ${info.header.dimensions.bands}`,
    `NoData: ${info.header.no_data === null ? 'null' : String(info.header.no_data)}`,
    `Uncompressed Payload Bytes: ${info.header.payload.uncompressed_bytes}`,
    `Compressed Payload Bytes: ${info.header.payload.compressed_bytes}`,
    `Payload CRC32: ${info.header.checksum.payload_crc32}`,
    `Header CRC32: ${info.header.checksum.header_crc32}`,
    `Header Length: ${info.header_length}`,
    `Payload Offset: ${info.payload_offset}`,
    `Payload Length: ${info.payload_length}`,
  ];

  if (info.header.mesh_kind === 'xyz') {
    const xyz = decodeXyzTileId(info.header.tile_id);
    lines.push(`XYZ Zoom: ${xyz.zoom}`);
    lines.push(`XYZ X: ${xyz.x}`);
    lines.push(`XYZ Y: ${xyz.y}`);
    lines.push(`XYZ Quadkey Integer: ${xyz.quadkey_integer.toString()}`);
  }

  return lines.join('\n');
}

export function formatDecodedCsv(values: ArrayLike<number>, rows: number, cols: number, bands: number): string {
  const expected = rows * cols * bands;
  if (values.length !== expected) {
    throw createError(
      'INVALID_PAYLOAD_LENGTH',
      `Decoded value count ${values.length} does not match dimensions (${rows}x${cols}x${bands}).`
    );
  }

  const header = ['x', 'y', ...Array.from({ length: bands }, (_unused, i) => `b${i}`)].join(',');
  const lines: string[] = [header];
  let index = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const bandValues: string[] = [];
      for (let band = 0; band < bands; band += 1) {
        bandValues.push(String(values[index]));
        index += 1;
      }
      lines.push(`${col},${row},${bandValues.join(',')}`);
    }
  }
  return lines.join('\n');
}

export function inspectTileToText(bytes: Uint8Array): InspectTileTextResult {
  const info = inspectTile(bytes);
  return {
    info,
    text: formatInspectOutput(info),
  };
}

export async function decodeTileToCsv(bytes: Uint8Array): Promise<DecodeTileCsvResult> {
  const decoded = await decodeTile(bytes);
  const { rows, cols, bands } = decoded.header.dimensions;
  return {
    decoded,
    csv: formatDecodedCsv(decoded.data, rows, cols, bands),
  };
}

export async function inspectTileFile(path: string): Promise<InspectTileTextResult> {
  const bytes = new Uint8Array(await readFile(path));
  return inspectTileToText(bytes);
}

export async function decodeTileFileToCsv(path: string): Promise<DecodeTileCsvResult> {
  const bytes = new Uint8Array(await readFile(path));
  return decodeTileToCsv(bytes);
}

export async function encodeTileToFile(path: string, input: TileEncodeInput): Promise<EncodeResult> {
  const encoded = await encodeTile(input);
  await writeFile(path, encoded.bytes);
  return encoded;
}
