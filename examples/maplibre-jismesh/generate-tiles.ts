import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { japanmesh } from 'japanmesh';
import { toJisMeshPoint } from '../../src/jismesh.js';
import { encodeTile } from '../../src/tile-format.js';

type Bounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

const GRID_ROWS = 8;
const GRID_COLS = 8;
const OUTPUT_DIR = join(process.cwd(), 'examples', 'maplibre-jismesh', 'public', 'tiles');

function getAllLv1MeshCodes(): string[] {
  const codes = japanmesh.getCodes();
  if (!codes || codes.length === 0) {
    throw new Error('japanmesh.getCodes() returned no LV1 codes.');
  }
  return [...codes].sort();
}

function getMeshBounds(meshCode: string): Bounds {
  const sw = toJisMeshPoint(meshCode, 'sw');
  const ne = toJisMeshPoint(meshCode, 'ne');
  return {
    west: sw[1],
    south: sw[0],
    east: ne[1],
    north: ne[0],
  };
}

function computeGlobalBounds(meshCodes: string[]): { byCode: Map<string, Bounds>; global: Bounds } {
  const byCode = new Map<string, Bounds>();
  const global: Bounds = {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  };

  for (const meshCode of meshCodes) {
    const bounds = getMeshBounds(meshCode);
    byCode.set(meshCode, bounds);
    if (bounds.west < global.west) {
      global.west = bounds.west;
    }
    if (bounds.south < global.south) {
      global.south = bounds.south;
    }
    if (bounds.east > global.east) {
      global.east = bounds.east;
    }
    if (bounds.north > global.north) {
      global.north = bounds.north;
    }
  }

  return { byCode, global };
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function gradientValueAt(lon: number, lat: number, globalBounds: Bounds): number {
  const dx = globalBounds.east - globalBounds.west;
  const dy = globalBounds.north - globalBounds.south;
  if (dx <= 0 || dy <= 0) {
    throw new Error('invalid global bounds for gradient.');
  }

  const vx = lon - globalBounds.west;
  const vy = lat - globalBounds.south;
  const t = clamp01((vx * dx + vy * dy) / (dx * dx + dy * dy));
  return Math.round(t * 0xffff);
}

function buildValues(meshBounds: Bounds, globalBounds: Bounds, rows: number, cols: number): Uint16Array {
  const values = new Uint16Array(rows * cols);
  const latStep = (meshBounds.north - meshBounds.south) / rows;
  const lonStep = (meshBounds.east - meshBounds.west) / cols;

  let index = 0;
  for (let row = 0; row < rows; row += 1) {
    const latCenter = meshBounds.north - (row + 0.5) * latStep;
    for (let col = 0; col < cols; col += 1) {
      const lonCenter = meshBounds.west + (col + 0.5) * lonStep;
      values[index] = gradientValueAt(lonCenter, latCenter, globalBounds);
      index += 1;
    }
  }
  return values;
}

async function main(): Promise<void> {
  const meshCodes = getAllLv1MeshCodes();
  const { byCode, global } = computeGlobalBounds(meshCodes);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const meshCode of meshCodes) {
    const meshBounds = byCode.get(meshCode);
    if (!meshBounds) {
      throw new Error(`mesh bounds not found for ${meshCode}`);
    }
    const encoded = await encodeTile({
      tile_id: BigInt(meshCode),
      mesh_kind: 'jis-x0410',
      rows: GRID_ROWS,
      cols: GRID_COLS,
      bands: 1,
      dtype: 'uint16',
      endianness: 'little',
      compression: 'none',
      data: buildValues(meshBounds, global, GRID_ROWS, GRID_COLS),
    });
    await writeFile(join(OUTPUT_DIR, `${meshCode}.tile`), encoded.bytes);
  }

  const metadata = {
    generated_at: new Date().toISOString(),
    mesh_count: meshCodes.length,
    rows: GRID_ROWS,
    cols: GRID_COLS,
    global_bounds: global,
  };
  await writeFile(join(OUTPUT_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2));

  console.log(`Generated ${meshCodes.length} LV1 mesh tiles at ${OUTPUT_DIR}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
