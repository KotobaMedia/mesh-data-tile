import { createError } from './errors.js';
import { decodeTile } from './tile-format.js';
import type { DecodedTile } from './types.js';

export interface DecodeTileCsvResult {
  decoded: DecodedTile;
  csv: string;
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

export async function decodeTileToCsv(bytes: Uint8Array): Promise<DecodeTileCsvResult> {
  const decoded = await decodeTile(bytes);
  const { rows, cols, bands } = decoded.header.dimensions;
  return {
    decoded,
    csv: formatDecodedCsv(decoded.data, rows, cols, bands),
  };
}
