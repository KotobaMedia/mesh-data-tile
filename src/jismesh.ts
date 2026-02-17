import { LatLngBounds, japanmesh } from 'japanmesh';
import { createError } from './errors.js';

export const JIS_MESH_LEVELS = {
  lv1: 80000,
  lv2: 10000,
  x5: 5000,
  x2: 2000,
  lv3: 1000,
  lv4: 500,
  lv5: 250,
  lv6: 125,
} as const;

export type JisMeshLevel = (typeof JIS_MESH_LEVELS)[keyof typeof JIS_MESH_LEVELS];

export type JisMeshPoint = 'sw' | 'nw' | 'ne' | 'se' | 'center';
export interface JisMeshBounds {
  north: number;
  east: number;
  south: number;
  west: number;
}

const JIS_MESH_LEVEL_SET = new Set<number>(Object.values(JIS_MESH_LEVELS));

export const JIS_MESH_PLACEHOLDER_LEVELS: Readonly<Record<string, JisMeshLevel>> = Object.freeze({
  lv1: JIS_MESH_LEVELS.lv1,
  '80000': JIS_MESH_LEVELS.lv1,
  lv2: JIS_MESH_LEVELS.lv2,
  '10000': JIS_MESH_LEVELS.lv2,
  x5: JIS_MESH_LEVELS.x5,
  '5000': JIS_MESH_LEVELS.x5,
  x2: JIS_MESH_LEVELS.x2,
  '2000': JIS_MESH_LEVELS.x2,
  lv3: JIS_MESH_LEVELS.lv3,
  '1000': JIS_MESH_LEVELS.lv3,
  lv4: JIS_MESH_LEVELS.lv4,
  '500': JIS_MESH_LEVELS.lv4,
  lv5: JIS_MESH_LEVELS.lv5,
  '250': JIS_MESH_LEVELS.lv5,
  lv6: JIS_MESH_LEVELS.lv6,
  '125': JIS_MESH_LEVELS.lv6,
});

function normalizeMeshCode(meshCode: bigint | number | string): string {
  if (typeof meshCode === 'bigint') {
    if (meshCode < 0n) {
      throw createError('INVALID_FIELD_VALUE', 'meshcode must be non-negative.');
    }
    return meshCode.toString();
  }

  if (typeof meshCode === 'number') {
    if (!Number.isSafeInteger(meshCode) || meshCode < 0) {
      throw createError('INVALID_FIELD_VALUE', 'meshcode number must be a non-negative safe integer.');
    }
    return String(meshCode);
  }

  if (!/^\d+$/.test(meshCode)) {
    throw createError('INVALID_FIELD_VALUE', 'meshcode string must contain only digits.');
  }
  return meshCode;
}

export function toJisMeshLevel(meshCode: bigint | number | string): JisMeshLevel | null {
  const code = normalizeMeshCode(meshCode);
  if (!japanmesh.isValidCode(code)) {
    return null;
  }
  const level = japanmesh.getLevel(code);
  return JIS_MESH_LEVEL_SET.has(level) ? (level as JisMeshLevel) : null;
}

export function toJisMeshCode(latitude: number, longitude: number, level: JisMeshLevel): string {
  if (!JIS_MESH_LEVEL_SET.has(level)) {
    throw createError('INVALID_FIELD_VALUE', `Unsupported JIS mesh level ${level}.`);
  }

  try {
    return japanmesh.toCode(latitude, longitude, level);
  } catch (error) {
    throw createError('INVALID_FIELD_VALUE', `Failed to calculate JIS mesh code: ${(error as Error).message}`, error);
  }
}

export function toJisMeshPoint(
  meshCode: bigint | number | string,
  point: JisMeshPoint = 'sw',
  level?: JisMeshLevel
): [number, number] {
  const code = normalizeMeshCode(meshCode);
  const detectedLevel = toJisMeshLevel(code);
  if (detectedLevel === null) {
    throw createError('INVALID_FIELD_VALUE', `Invalid JIS mesh code "${code}".`);
  }
  if (level !== undefined && level !== detectedLevel) {
    throw createError(
      'INVALID_FIELD_VALUE',
      `mesh code "${code}" is level ${detectedLevel}, but level ${level} was requested.`
    );
  }

  let bounds;
  try {
    bounds = japanmesh.toLatLngBounds(code);
  } catch (error) {
    throw createError('INVALID_FIELD_VALUE', `Failed to get JIS mesh bounds: ${(error as Error).message}`, error);
  }

  switch (point) {
    case 'sw': {
      const p = bounds.getSouthWest();
      return [p.lat, p.lng];
    }
    case 'nw': {
      const p = bounds.getNorthWest();
      return [p.lat, p.lng];
    }
    case 'ne': {
      const p = bounds.getNorthEast();
      return [p.lat, p.lng];
    }
    case 'se': {
      const p = bounds.getSouthEast();
      return [p.lat, p.lng];
    }
    case 'center': {
      const p = bounds.getCenter();
      return [p.lat, p.lng];
    }
    default:
      throw createError('INVALID_FIELD_VALUE', `Unsupported JIS mesh point "${point as string}".`);
  }
}

export function getJisMeshCodesWithinBounds(bounds: JisMeshBounds, level: JisMeshLevel): string[] {
  if (!JIS_MESH_LEVEL_SET.has(level)) {
    throw createError('INVALID_FIELD_VALUE', `Unsupported JIS mesh level ${level}.`);
  }

  try {
    return japanmesh.getCodesWithinBounds(
      new LatLngBounds(bounds.north, bounds.east, bounds.south, bounds.west),
      level
    );
  } catch (error) {
    throw createError(
      'INVALID_FIELD_VALUE',
      `Failed to resolve JIS mesh codes within bounds: ${(error as Error).message}`,
      error
    );
  }
}

export function resolveJisMeshPlaceholderLevel(placeholderName: string): JisMeshLevel | null {
  const normalized = placeholderName.toLowerCase();
  return JIS_MESH_PLACEHOLDER_LEVELS[normalized] ?? null;
}
