import { createError } from './errors.js';
import { decodeXyzTileId } from './tile-id.js';
import { decodeTile } from './tile-format.js';
import geojsonvt from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import {
  getJisMeshCodesWithinBounds,
  resolveJisMeshPlaceholderLevel,
  toJisMeshCode,
  toJisMeshPoint,
  type JisMeshLevel,
  type JisMeshPoint,
} from './jismesh.js';
import type { DecodedTile } from './types.js';

export interface TileCoordinates {
  z: number;
  x: number;
  y: number;
}

export type GeoJsonPosition = [number, number];

export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: GeoJsonPosition[][];
}

export interface MeshTileFeature {
  type: 'Feature';
  id: string;
  geometry: GeoJsonPolygon;
  properties: Record<string, number>;
}

export interface MeshTileFeatureCollection {
  type: 'FeatureCollection';
  features: MeshTileFeature[];
}

export interface MeshTileToGeoJsonOptions {
  includeNoData?: boolean;
  bandPropertyPrefix?: string;
}

export interface MeshTileFetchOptions {
  signal?: AbortSignal;
  requestInit?: Omit<RequestInit, 'signal'>;
}

export interface MapLibreSourceHandlerOptions {
  urlTemplate: string;
  fetch?: typeof fetch;
  requestInit?: Omit<RequestInit, 'signal'>;
  jismeshPoint?: JisMeshPoint;
  geojson?: MeshTileToGeoJsonOptions;
}

export interface FetchedMeshTile {
  tile: TileCoordinates;
  request_url: string;
  decoded: DecodedTile;
  geojson: MeshTileFeatureCollection;
}

export interface MapLibreSourceHandler {
  resolveUrl(tile: TileCoordinates): string;
  fetchTile(tile: TileCoordinates, options?: MeshTileFetchOptions): Promise<FetchedMeshTile>;
}

export interface MapLibreProtocolRequestParameters {
  url: string;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST' | 'PUT';
  body?: string;
  type?: 'string' | 'json' | 'arrayBuffer' | 'image';
  credentials?: 'same-origin' | 'include';
  collectResourceTiming?: boolean;
  cache?: RequestCache;
}

export interface MapLibreProtocolResponse<TData = ArrayBuffer> {
  data: TData;
  cacheControl?: string | null;
  expires?: Date | string | null;
}

export type MapLibreAddProtocolAction = (
  requestParameters: MapLibreProtocolRequestParameters,
  abortController: AbortController
) => Promise<MapLibreProtocolResponse<any>>;

export interface MeshTileProtocolStats {
  requested: number;
  loaded: number;
  cache_hits: number;
  failures: number;
  in_flight: number;
}

export interface MeshTileProtocolOptions {
  protocol?: string;
  layerName?: string;
  fetch?: typeof fetch;
  requestInit?: Omit<RequestInit, 'signal'>;
  geojson?: MeshTileToGeoJsonOptions;
  zoom?: {
    min?: number;
    max?: number;
  };
  jismeshSamplePoints?: readonly JisMeshPoint[];
  jismeshMaxCodesPerTile?: number;
  onStats?: (stats: MeshTileProtocolStats) => void;
  vectorTile?: {
    extent?: number;
    version?: 1 | 2;
    maxZoom?: number;
    indexMaxZoom?: number;
    indexMaxPoints?: number;
    tolerance?: number;
    buffer?: number;
  };
  cache?: {
    vectorTilesMaxEntries?: number;
    meshFeaturesMaxEntries?: number;
    templatesMaxEntries?: number;
  };
}

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const TILE_POINT_TO_OFFSET: Readonly<Record<JisMeshPoint, readonly [number, number]>> = {
  sw: [0, 1],
  nw: [0, 0],
  ne: [1, 0],
  se: [1, 1],
  center: [0.5, 0.5],
};

const JISMESH_PLACEHOLDER_PATTERN = /\{jismesh-([^}]+)\}/gi;
const SUPPORTED_JISMESH_PLACEHOLDERS = Object.freeze([
  '{jismesh-lv1}',
  '{jismesh-80000}',
  '{jismesh-lv2}',
  '{jismesh-10000}',
  '{jismesh-x5}',
  '{jismesh-5000}',
  '{jismesh-x2}',
  '{jismesh-2000}',
  '{jismesh-lv3}',
  '{jismesh-1000}',
  '{jismesh-lv4}',
  '{jismesh-500}',
  '{jismesh-lv5}',
  '{jismesh-250}',
  '{jismesh-lv6}',
  '{jismesh-125}',
]);

export const MAPLIBRE_MESH_PROTOCOL_DEFAULT_SCHEME = 'meshtiles';
export const MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME = 'mesh_cells';
export const MAPLIBRE_MESH_PROTOCOL_DEFAULT_VECTOR_EXTENT = 4096;
export const MAPLIBRE_MESH_PROTOCOL_DEFAULT_VECTOR_VERSION = 2;
export const MAPLIBRE_MESH_PROTOCOL_DEFAULT_MAX_CODES_PER_TILE = 1024;
export const MAPLIBRE_MESH_PROTOCOL_DEFAULT_SAMPLE_POINTS: readonly JisMeshPoint[] = Object.freeze([
  'center',
  'nw',
  'ne',
  'sw',
  'se',
]);

function normalizeTileCoordinates(tile: TileCoordinates): TileCoordinates {
  if (!Number.isInteger(tile.z) || tile.z < 0) {
    throw createError('INVALID_FIELD_VALUE', `z must be a non-negative integer. got=${tile.z}`);
  }
  const maxExclusive = 2 ** tile.z;
  if (!Number.isInteger(tile.x) || tile.x < 0 || tile.x >= maxExclusive) {
    throw createError(
      'INVALID_FIELD_VALUE',
      `x must be in [0, ${maxExclusive - 1}] for z=${tile.z}. got=${tile.x}`
    );
  }
  if (!Number.isInteger(tile.y) || tile.y < 0 || tile.y >= maxExclusive) {
    throw createError(
      'INVALID_FIELD_VALUE',
      `y must be in [0, ${maxExclusive - 1}] for z=${tile.z}. got=${tile.y}`
    );
  }
  return tile;
}

function tileYToLatitude(tileY: number, zoom: number): number {
  const n = 2 ** zoom;
  const latRadians = Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n)));
  return (latRadians * 180) / Math.PI;
}

function xyzTilePointToLonLat(tile: TileCoordinates, point: JisMeshPoint): { lat: number; lon: number } {
  const offset = TILE_POINT_TO_OFFSET[point];
  if (!offset) {
    throw createError('INVALID_FIELD_VALUE', `Unsupported tile point "${point}".`);
  }

  const [offsetX, offsetY] = offset;
  const n = 2 ** tile.z;
  const lon = ((tile.x + offsetX) / n) * 360 - 180;
  const lat = tileYToLatitude(tile.y + offsetY, tile.z);
  return { lat, lon };
}

function xyzTileBounds(tile: TileCoordinates): Bounds {
  const nw = xyzTilePointToLonLat(tile, 'nw');
  const se = xyzTilePointToLonLat(tile, 'se');
  return {
    west: nw.lon,
    south: se.lat,
    east: se.lon,
    north: nw.lat,
  };
}

function boundsFromDecodedTile(tile: DecodedTile): Bounds {
  if (tile.header.mesh_kind === 'xyz') {
    const xyz = decodeXyzTileId(tile.header.tile_id);
    return xyzTileBounds({ z: xyz.zoom, x: xyz.x, y: xyz.y });
  }

  const meshCode = tile.header.tile_id.toString();
  const sw = toJisMeshPoint(meshCode, 'sw');
  const ne = toJisMeshPoint(meshCode, 'ne');
  return {
    west: sw[1],
    south: sw[0],
    east: ne[1],
    north: ne[0],
  };
}

function replaceXyzPlaceholders(template: string, tile: TileCoordinates): string {
  return template
    .replaceAll('{z}', String(tile.z))
    .replaceAll('{x}', String(tile.x))
    .replaceAll('{y}', String(tile.y));
}

function replaceJisMeshPlaceholdersForLonLat(template: string, lat: number, lon: number): string {
  return template.replace(JISMESH_PLACEHOLDER_PATTERN, (_match, rawLevel: string) => {
    const level = resolveJisMeshPlaceholderLevel(rawLevel);
    if (level === null) {
      throw createError(
        'INVALID_FIELD_VALUE',
        `Unsupported JIS mesh placeholder "{jismesh-${rawLevel}}". Supported: ${SUPPORTED_JISMESH_PLACEHOLDERS.join(', ')}`
      );
    }
    return toJisMeshCode(lat, lon, level);
  });
}

function renderMeshTileUrlTemplateAtLonLat(template: string, tile: TileCoordinates, lat: number, lon: number): string {
  return replaceJisMeshPlaceholdersForLonLat(replaceXyzPlaceholders(template, tile), lat, lon);
}

function extractJisMeshPlaceholderLevels(template: string): JisMeshLevel[] {
  const matches = template.matchAll(/\{jismesh-([^}]+)\}/gi);
  const levels = new Set<JisMeshLevel>();
  for (const match of matches) {
    const rawLevel = match[1];
    const level = resolveJisMeshPlaceholderLevel(rawLevel);
    if (level === null) {
      throw createError(
        'INVALID_FIELD_VALUE',
        `Unsupported JIS mesh placeholder "{jismesh-${rawLevel}}". Supported: ${SUPPORTED_JISMESH_PLACEHOLDERS.join(', ')}`
      );
    }
    levels.add(level);
  }
  return Array.from(levels.values());
}

export function renderMeshTileUrlTemplate(
  template: string,
  tile: TileCoordinates,
  jismeshPoint: JisMeshPoint = 'center'
): string {
  const normalized = normalizeTileCoordinates(tile);
  const point = xyzTilePointToLonLat(normalized, jismeshPoint);
  return renderMeshTileUrlTemplateAtLonLat(template, normalized, point.lat, point.lon);
}

export function decodedMeshTileToGeoJson(
  tile: DecodedTile,
  options: MeshTileToGeoJsonOptions = {}
): MeshTileFeatureCollection {
  const bounds = boundsFromDecodedTile(tile);
  const { rows, cols, bands } = tile.header.dimensions;
  const lonStep = (bounds.east - bounds.west) / cols;
  const latStep = (bounds.north - bounds.south) / rows;
  const includeNoData = options.includeNoData ?? true;
  const bandPrefix = options.bandPropertyPrefix ?? 'b';
  const noData = tile.header.no_data;

  const features: MeshTileFeature[] = [];
  let dataIndex = 0;

  for (let row = 0; row < rows; row += 1) {
    const north = bounds.north - row * latStep;
    const south = north - latStep;
    for (let col = 0; col < cols; col += 1) {
      const west = bounds.west + col * lonStep;
      const east = west + lonStep;

      const bandValues: number[] = [];
      let isNoData = noData !== null;
      for (let band = 0; band < bands; band += 1) {
        const value = Number(tile.data[dataIndex]);
        dataIndex += 1;
        bandValues.push(value);
        if (isNoData && !Object.is(value, noData)) {
          isNoData = false;
        }
      }

      if (!includeNoData && isNoData) {
        continue;
      }

      const properties: Record<string, number> = {
        row,
        col,
      };
      for (let band = 0; band < bands; band += 1) {
        properties[`${bandPrefix}${band}`] = bandValues[band];
      }
      if (bands === 1) {
        properties.value = bandValues[0];
      }

      features.push({
        type: 'Feature',
        id: `${row}:${col}`,
        geometry: {
          type: 'Polygon',
          coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        },
        properties,
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

export function createMapLibreSourceHandler(options: MapLibreSourceHandlerOptions): MapLibreSourceHandler {
  if (!options.urlTemplate || options.urlTemplate.trim() === '') {
    throw createError('MISSING_REQUIRED_FIELD', 'urlTemplate is required.');
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw createError('INTERNAL_FAILURE', 'A fetch implementation is required in this runtime.');
  }

  return {
    resolveUrl(tile: TileCoordinates): string {
      return renderMeshTileUrlTemplate(options.urlTemplate, tile, options.jismeshPoint ?? 'center');
    },
    async fetchTile(tile: TileCoordinates, requestOptions: MeshTileFetchOptions = {}): Promise<FetchedMeshTile> {
      const normalized = normalizeTileCoordinates(tile);
      const requestUrl = renderMeshTileUrlTemplate(options.urlTemplate, normalized, options.jismeshPoint ?? 'center');
      const response = await fetchImpl(requestUrl, {
        ...(options.requestInit ?? {}),
        ...(requestOptions.requestInit ?? {}),
        signal: requestOptions.signal,
      });

      if (!response.ok) {
        throw createError(
          'INTERNAL_FAILURE',
          `Failed to fetch mesh data tile (${response.status} ${response.statusText}) from ${requestUrl}.`
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const decoded = await decodeTile(bytes);
      const geojson = decodedMeshTileToGeoJson(decoded, options.geojson);
      return {
        tile: normalized,
        request_url: requestUrl,
        decoded,
        geojson,
      };
    },
  };
}

interface MeshProtocolRequestContext {
  kind: 'source' | 'tile';
  tile_url_template: string;
  request_url: string;
  tile?: TileCoordinates;
}

interface MeshProtocolResolvedCandidate {
  url: string;
  handler: MapLibreSourceHandler;
}

function toDisplayFeatures(entry: FetchedMeshTile): MeshTileFeature[] {
  const meshCode = Number(entry.decoded.header.tile_id);
  return entry.geojson.features.map((feature) => ({
    ...feature,
    id: `${meshCode}:${feature.id}`,
    properties: {
      ...feature.properties,
      mesh_code: meshCode,
    },
  }));
}

function cloneBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const clone = new Uint8Array(bytes.length);
  clone.set(bytes);
  return clone.buffer;
}

function makeEmptyVectorTileBytes(layerName: string, extent: number, version: 1 | 2): Uint8Array {
  return fromGeojsonVt(
    { [layerName]: { features: [] } as never },
    {
      extent,
      version,
    }
  );
}

function getFromLru<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) {
    return undefined;
  }
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setToLru<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);

  if (cache.size <= maxEntries) {
    return;
  }

  const oldestKey = cache.keys().next().value as K | undefined;
  if (oldestKey !== undefined) {
    cache.delete(oldestKey);
  }
}

function assertProtocolName(protocol: string): string {
  const normalized = protocol.toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(normalized)) {
    throw createError('INVALID_FIELD_VALUE', `Invalid protocol name "${protocol}".`);
  }
  return normalized;
}

function normalizeOptionalZoomLevel(label: string, value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw createError('INVALID_FIELD_VALUE', `${label} must be a non-negative integer. got=${value}`);
  }
  return value;
}

function clampGeoJsonVtMaxZoom(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 24) {
    return 24;
  }
  return value;
}

function decodePercentEncodedValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function deriveMeshTileUrlTemplateFromProtocolRequest(parsed: URL, encodedTemplatePath: string): string {
  const scheme = parsed.host.toLowerCase();
  let tileUrlTemplate: string;

  if (scheme === 'http' || scheme === 'https') {
    if (encodedTemplatePath.startsWith('//')) {
      tileUrlTemplate = `${scheme}:${encodedTemplatePath}`;
    } else {
      tileUrlTemplate = `${scheme}://${encodedTemplatePath.replace(/^\/+/, '')}`;
    }
  } else {
    const encodedRelativePath = encodedTemplatePath.replace(/^\/+/, '');
    const pieces = [parsed.host, encodedRelativePath].filter((piece) => piece.length > 0);
    tileUrlTemplate = pieces.join('/');
  }

  return decodePercentEncodedValue(tileUrlTemplate);
}

function buildTileJsonTileRequestTemplate(protocol: string, tileUrlTemplate: string): string {
  return `${protocol}://tiles/{z}/{x}/{y}.mvt?template=${encodeURIComponent(tileUrlTemplate)}`;
}

function awaitWithAbortSignal<T>(loading: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error('Operation aborted.'));
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    loading.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function parseMapLibreMeshProtocolRequestUrl(requestUrl: string, protocol: string): MeshProtocolRequestContext {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch (error) {
    throw createError('INVALID_FIELD_VALUE', `Invalid protocol request URL "${requestUrl}".`, error);
  }

  if (parsed.protocol !== `${protocol}:`) {
    throw createError(
      'INVALID_FIELD_VALUE',
      `Protocol mismatch for "${requestUrl}". expected="${protocol}://" got="${parsed.protocol}"`
    );
  }

  const tilePathMatch = parsed.pathname.match(/^(.*)\/(\d+)\/(\d+)\/(\d+)(?:\.[a-z0-9]+)?$/i);

  let tileUrlTemplate = parsed.searchParams.get('template') ?? '';
  if (tileUrlTemplate === '') {
    const encodedTemplatePath = tilePathMatch?.[1] ?? parsed.pathname;
    tileUrlTemplate = deriveMeshTileUrlTemplateFromProtocolRequest(parsed, encodedTemplatePath);
  }

  if (tileUrlTemplate.trim() === '') {
    throw createError(
      'MISSING_REQUIRED_FIELD',
      `Missing mesh tile URL template in "${requestUrl}". Use "meshtiles://{relative path}" or "meshtiles://https://{absolute path}" for source URLs, or append "/{z}/{x}/{y}.mvt" for tile requests.`
    );
  }

  if (!tilePathMatch) {
    return {
      kind: 'source',
      tile_url_template: tileUrlTemplate,
      request_url: requestUrl,
    };
  }

  return {
    kind: 'tile',
    tile_url_template: tileUrlTemplate,
    tile: normalizeTileCoordinates({
      z: Number(tilePathMatch[2]),
      x: Number(tilePathMatch[3]),
      y: Number(tilePathMatch[4]),
    }),
    request_url: requestUrl,
  };
}

export function createMapLibreMeshTileProtocol(options: MeshTileProtocolOptions = {}): MapLibreAddProtocolAction {
  const protocol = assertProtocolName(options.protocol ?? MAPLIBRE_MESH_PROTOCOL_DEFAULT_SCHEME);
  const layerName = options.layerName ?? MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME;
  const minZoomConstraint = normalizeOptionalZoomLevel('zoom.min', options.zoom?.min);
  const maxZoomConstraint = normalizeOptionalZoomLevel('zoom.max', options.zoom?.max);
  if (minZoomConstraint !== undefined && maxZoomConstraint !== undefined && minZoomConstraint > maxZoomConstraint) {
    throw createError(
      'INVALID_FIELD_VALUE',
      `zoom.min must be less than or equal to zoom.max. got min=${minZoomConstraint}, max=${maxZoomConstraint}`
    );
  }

  const samplePoints =
    options.jismeshSamplePoints && options.jismeshSamplePoints.length > 0
      ? options.jismeshSamplePoints
      : MAPLIBRE_MESH_PROTOCOL_DEFAULT_SAMPLE_POINTS;

  const vectorExtent = options.vectorTile?.extent ?? MAPLIBRE_MESH_PROTOCOL_DEFAULT_VECTOR_EXTENT;
  const vectorVersion = options.vectorTile?.version ?? MAPLIBRE_MESH_PROTOCOL_DEFAULT_VECTOR_VERSION;
  const configuredVectorMaxZoom = normalizeOptionalZoomLevel('vectorTile.maxZoom', options.vectorTile?.maxZoom);
  const configuredVectorIndexMaxZoom = options.vectorTile?.indexMaxZoom ?? 5;
  const vectorIndexMaxPoints = options.vectorTile?.indexMaxPoints ?? 100000;
  const vectorTolerance = options.vectorTile?.tolerance ?? 0;
  const vectorBuffer = options.vectorTile?.buffer ?? 64;

  const vectorTilesMaxEntries = options.cache?.vectorTilesMaxEntries ?? 1024;
  const meshFeaturesMaxEntries = options.cache?.meshFeaturesMaxEntries ?? 256;
  const templatesMaxEntries = options.cache?.templatesMaxEntries ?? 32;
  const jismeshMaxCodesPerTile = options.jismeshMaxCodesPerTile ?? MAPLIBRE_MESH_PROTOCOL_DEFAULT_MAX_CODES_PER_TILE;

  const handlersByTemplate = new Map<string, Record<JisMeshPoint, MapLibreSourceHandler>>();
  const handlersByResolvedUrl = new Map<string, MapLibreSourceHandler>();
  const vectorTileCache = new Map<string, Uint8Array>();
  const vectorTileInFlight = new Map<string, Promise<Uint8Array>>();
  const meshFeaturesCache = new Map<string, MeshTileFeature[]>();
  const meshFeaturesInFlight = new Map<string, Promise<MeshTileFeature[]>>();
  const emptyVectorTileBytes = makeEmptyVectorTileBytes(layerName, vectorExtent, vectorVersion);

  const stats: MeshTileProtocolStats = {
    requested: 0,
    loaded: 0,
    cache_hits: 0,
    failures: 0,
    in_flight: 0,
  };

  const emitStats = (): void => {
    options.onStats?.({ ...stats });
  };

  const getHandlersForTemplate = (tileUrlTemplate: string): Record<JisMeshPoint, MapLibreSourceHandler> => {
    const cached = getFromLru(handlersByTemplate, tileUrlTemplate);
    if (cached) {
      return cached;
    }

    const next: Record<JisMeshPoint, MapLibreSourceHandler> = {
      center: createMapLibreSourceHandler({
        urlTemplate: tileUrlTemplate,
        fetch: options.fetch,
        requestInit: options.requestInit,
        geojson: options.geojson,
        jismeshPoint: 'center',
      }),
      nw: createMapLibreSourceHandler({
        urlTemplate: tileUrlTemplate,
        fetch: options.fetch,
        requestInit: options.requestInit,
        geojson: options.geojson,
        jismeshPoint: 'nw',
      }),
      ne: createMapLibreSourceHandler({
        urlTemplate: tileUrlTemplate,
        fetch: options.fetch,
        requestInit: options.requestInit,
        geojson: options.geojson,
        jismeshPoint: 'ne',
      }),
      sw: createMapLibreSourceHandler({
        urlTemplate: tileUrlTemplate,
        fetch: options.fetch,
        requestInit: options.requestInit,
        geojson: options.geojson,
        jismeshPoint: 'sw',
      }),
      se: createMapLibreSourceHandler({
        urlTemplate: tileUrlTemplate,
        fetch: options.fetch,
        requestInit: options.requestInit,
        geojson: options.geojson,
        jismeshPoint: 'se',
      }),
    };

    setToLru(handlersByTemplate, tileUrlTemplate, next, templatesMaxEntries);
    return next;
  };

  const getHandlerForResolvedUrl = (resolvedUrl: string): MapLibreSourceHandler => {
    const cached = getFromLru(handlersByResolvedUrl, resolvedUrl);
    if (cached) {
      return cached;
    }

    const handler = createMapLibreSourceHandler({
      urlTemplate: resolvedUrl,
      fetch: options.fetch,
      requestInit: options.requestInit,
      geojson: options.geojson,
      jismeshPoint: 'center',
    });
    setToLru(handlersByResolvedUrl, resolvedUrl, handler, Math.max(meshFeaturesMaxEntries, templatesMaxEntries));
    return handler;
  };

  const resolveMeshCandidatesFromSamplePoints = (
    tileUrlTemplate: string,
    tile: TileCoordinates
  ): MeshProtocolResolvedCandidate[] => {
    const handlers = getHandlersForTemplate(tileUrlTemplate);
    const byUrl = new Map<string, MeshProtocolResolvedCandidate>();

    for (const point of samplePoints) {
      const handler = handlers[point];
      if (!handler) {
        continue;
      }

      try {
        const url = handler.resolveUrl(tile);
        if (!byUrl.has(url)) {
          byUrl.set(url, {
            url,
            handler,
          });
        }
      } catch {
        // Outside of supported JIS mesh area for this sample point.
      }
    }

    return Array.from(byUrl.values());
  };

  const resolveMeshCandidatesFromJisMeshBounds = (
    tileUrlTemplate: string,
    tile: TileCoordinates,
    levels: readonly JisMeshLevel[]
  ): MeshProtocolResolvedCandidate[] => {
    const resolutionLevel = Math.min(...levels) as JisMeshLevel;
    const bounds = xyzTileBounds(tile);

    let meshCodes: string[];
    try {
      meshCodes = getJisMeshCodesWithinBounds(bounds, resolutionLevel);
    } catch {
      return [];
    }

    if (meshCodes.length > jismeshMaxCodesPerTile) {
      return resolveMeshCandidatesFromSamplePoints(tileUrlTemplate, tile);
    }

    const byUrl = new Map<string, MeshProtocolResolvedCandidate>();
    for (const meshCode of meshCodes) {
      try {
        const [lat, lon] = toJisMeshPoint(meshCode, 'center', resolutionLevel);
        const resolvedUrl = renderMeshTileUrlTemplateAtLonLat(tileUrlTemplate, tile, lat, lon);
        if (!byUrl.has(resolvedUrl)) {
          byUrl.set(resolvedUrl, {
            url: resolvedUrl,
            handler: getHandlerForResolvedUrl(resolvedUrl),
          });
        }
      } catch {
        // Skip malformed or out-of-coverage codes.
      }
    }
    return Array.from(byUrl.values());
  };

  const resolveMeshCandidates = (tileUrlTemplate: string, tile: TileCoordinates): MeshProtocolResolvedCandidate[] => {
    const levels = extractJisMeshPlaceholderLevels(tileUrlTemplate);
    if (levels.length === 0) {
      return resolveMeshCandidatesFromSamplePoints(tileUrlTemplate, tile);
    }
    return resolveMeshCandidatesFromJisMeshBounds(tileUrlTemplate, tile, levels);
  };

  const getMeshFeatures = async (
    tile: TileCoordinates,
    candidate: MeshProtocolResolvedCandidate,
    signal: AbortSignal
  ): Promise<MeshTileFeature[]> => {
    const cached = getFromLru(meshFeaturesCache, candidate.url);
    if (cached) {
      return cached;
    }

    let loading = meshFeaturesInFlight.get(candidate.url);
    if (!loading) {
      const started = candidate.handler.fetchTile(tile).then((entry) => {
        const features = toDisplayFeatures(entry);
        setToLru(meshFeaturesCache, candidate.url, features, meshFeaturesMaxEntries);
        return features;
      });
      loading = started.finally(() => {
        meshFeaturesInFlight.delete(candidate.url);
      });
      meshFeaturesInFlight.set(candidate.url, loading);
    }

    return await awaitWithAbortSignal(loading, signal);
  };

  emitStats();

  return async (requestParameters: MapLibreProtocolRequestParameters, abortController: AbortController) => {
    stats.requested += 1;
    const parsed = parseMapLibreMeshProtocolRequestUrl(requestParameters.url, protocol);

    if (parsed.kind === 'source') {
      emitStats();
      return {
        data: {
          tilejson: '3.0.0',
          scheme: 'xyz',
          tiles: [buildTileJsonTileRequestTemplate(protocol, parsed.tile_url_template)],
          minzoom: minZoomConstraint ?? 0,
          maxzoom: maxZoomConstraint ?? 24,
        },
      };
    }

    const tile = parsed.tile as TileCoordinates;

    const cached = getFromLru(vectorTileCache, parsed.request_url);
    if (cached) {
      stats.cache_hits += 1;
      emitStats();
      return { data: cloneBytesToArrayBuffer(cached) };
    }

    const inFlight = vectorTileInFlight.get(parsed.request_url);
    if (inFlight) {
      stats.cache_hits += 1;
      emitStats();
      const bytes = await inFlight;
      return { data: cloneBytesToArrayBuffer(bytes) };
    }

    const loadPromise = (async (): Promise<Uint8Array> => {
      abortController.signal.throwIfAborted();

      if (
        (minZoomConstraint !== undefined && tile.z < minZoomConstraint) ||
        (maxZoomConstraint !== undefined && tile.z > maxZoomConstraint)
      ) {
        return emptyVectorTileBytes;
      }

      const candidates = resolveMeshCandidates(parsed.tile_url_template, tile);
      if (candidates.length === 0) {
        return emptyVectorTileBytes;
      }

      const featureGroups = await Promise.all(
        candidates.map(async (candidate) => {
          try {
            return await getMeshFeatures(tile, candidate, abortController.signal);
          } catch {
            stats.failures += 1;
            return [] as MeshTileFeature[];
          }
        })
      );

      const features = featureGroups.flat();
      if (features.length === 0) {
        return emptyVectorTileBytes;
      }

      abortController.signal.throwIfAborted();

      const vectorMaxZoom = clampGeoJsonVtMaxZoom(configuredVectorMaxZoom ?? tile.z);
      const vectorIndexMaxZoom = Math.min(configuredVectorIndexMaxZoom, vectorMaxZoom);
      const index = geojsonvt(
        {
          type: 'FeatureCollection',
          features,
        },
        {
          maxZoom: vectorMaxZoom,
          indexMaxZoom: vectorIndexMaxZoom,
          indexMaxPoints: vectorIndexMaxPoints,
          tolerance: vectorTolerance,
          buffer: vectorBuffer,
          extent: vectorExtent,
        }
      );

      const vectorTile = index.getTile(tile.z, tile.x, tile.y);
      const bytes = vectorTile
        ? fromGeojsonVt(
            { [layerName]: vectorTile },
            {
              extent: vectorExtent,
              version: vectorVersion,
            }
          )
        : emptyVectorTileBytes;

      setToLru(vectorTileCache, parsed.request_url, bytes, vectorTilesMaxEntries);
      return bytes;
    })();

    vectorTileInFlight.set(parsed.request_url, loadPromise);
    stats.in_flight = vectorTileInFlight.size;
    emitStats();

    try {
      const bytes = await loadPromise;
      stats.loaded += 1;
      return { data: cloneBytesToArrayBuffer(bytes) };
    } catch (error) {
      stats.failures += 1;
      vectorTileCache.clear();
      meshFeaturesCache.clear();
      throw error;
    } finally {
      vectorTileInFlight.delete(parsed.request_url);
      stats.in_flight = vectorTileInFlight.size;
      emitStats();
    }
  };
}
