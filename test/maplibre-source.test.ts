import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import {
  JIS_MESH_LEVELS,
  MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME,
  MAPLIBRE_MESH_PROTOCOL_DEFAULT_VECTOR_EXTENT,
  MAPLIBRE_MESH_PROTOCOL_DEFAULT_VECTOR_VERSION,
  buildMapLibreMeshProtocolUrlTemplate,
  createMapLibreMeshTileProtocol,
  createMapLibreSourceHandler,
  decodeTile,
  decodedMeshTileToGeoJson,
  getJisMeshCodesWithinBounds,
  renderMeshTileUrlTemplate,
  toJisMeshCode,
  toJisMeshLevel,
  toJisMeshPoint,
} from '../src/index.js';

function assertAlmostEqual(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected=${expected} actual=${actual}`);
}

function tileYToLat(tileY: number, zoom: number): number {
  const n = 2 ** zoom;
  const latRadians = Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n)));
  return (latRadians * 180) / Math.PI;
}

function xyzTileCenter(tile: { z: number; x: number; y: number }): { lat: number; lon: number } {
  const n = 2 ** tile.z;
  const lon = ((tile.x + 0.5) / n) * 360 - 180;
  const lat = tileYToLat(tile.y + 0.5, tile.z);
  return { lat, lon };
}

describe('maplibre source helpers', () => {
  it('uses japanmesh-backed toJisMeshCode for supported levels', () => {
    const lat = 35.70078;
    const lon = 139.71475;
    assert.equal(toJisMeshCode(lat, lon, JIS_MESH_LEVELS.lv1), '5339');
    assert.equal(toJisMeshCode(lat, lon, JIS_MESH_LEVELS.lv2), '533945');
    assert.equal(toJisMeshCode(lat, lon, JIS_MESH_LEVELS.x5), '5339452');
    assert.equal(toJisMeshCode(lat, lon, JIS_MESH_LEVELS.x2), '533945465');
    assert.equal(toJisMeshCode(lat, lon, JIS_MESH_LEVELS.lv3), '53394547');
    assert.equal(toJisMeshCode(lat, lon, JIS_MESH_LEVELS.lv4), '533945471');
    assert.equal(toJisMeshCode(lat, lon, JIS_MESH_LEVELS.lv5), '5339454711');
    assert.equal(toJisMeshCode(lat, lon, JIS_MESH_LEVELS.lv6), '53394547112');
  });

  it('uses japanmesh-backed toJisMeshLevel for supported levels', () => {
    assert.equal(toJisMeshLevel('5339'), JIS_MESH_LEVELS.lv1);
    assert.equal(toJisMeshLevel('533945'), JIS_MESH_LEVELS.lv2);
    assert.equal(toJisMeshLevel('5339452'), JIS_MESH_LEVELS.x5);
    assert.equal(toJisMeshLevel('533945465'), JIS_MESH_LEVELS.x2);
    assert.equal(toJisMeshLevel('53394547'), JIS_MESH_LEVELS.lv3);
    assert.equal(toJisMeshLevel('533945471'), JIS_MESH_LEVELS.lv4);
    assert.equal(toJisMeshLevel('5339454711'), JIS_MESH_LEVELS.lv5);
    assert.equal(toJisMeshLevel('53394547112'), JIS_MESH_LEVELS.lv6);
    assert.equal(toJisMeshLevel('9999'), null);
  });

  it('uses japanmesh-backed toJisMeshPoint', () => {
    const sw = toJisMeshPoint('53394547', 'sw');
    const nw = toJisMeshPoint('53394547', 'nw');
    const ne = toJisMeshPoint('53394547', 'ne');
    const se = toJisMeshPoint('53394547', 'se');
    const center = toJisMeshPoint('53394547', 'center');

    assertAlmostEqual(sw[0], 35.7);
    assertAlmostEqual(sw[1], 139.7125);
    assertAlmostEqual(nw[0], 35.70833333333333);
    assertAlmostEqual(nw[1], 139.7125);
    assertAlmostEqual(ne[0], 35.70833333333333);
    assertAlmostEqual(ne[1], 139.725);
    assertAlmostEqual(se[0], 35.7);
    assertAlmostEqual(se[1], 139.725);
    assertAlmostEqual(center[0], 35.704166666666666);
    assertAlmostEqual(center[1], 139.71875);
  });

  it('resolves japanmesh codes within bounds', () => {
    const codes = getJisMeshCodesWithinBounds(
      {
        north: 36.0,
        east: 140.0,
        south: 35.0,
        west: 139.0,
      },
      JIS_MESH_LEVELS.lv1
    );
    assert.ok(codes.includes('5339'));
    assert.ok(codes.length >= 1);
  });

  it('renders XYZ placeholders in URL templates', () => {
    const rendered = renderMeshTileUrlTemplate('https://tiles.example/{z}/{x}/{y}.tile', {
      z: 12,
      x: 3639,
      y: 1612,
    });
    assert.equal(rendered, 'https://tiles.example/12/3639/1612.tile');
  });

  it('renders supported JIS placeholders in URL templates', () => {
    const tile = { z: 12, x: 3639, y: 1612 };
    const center = xyzTileCenter(tile);
    const lv1 = toJisMeshCode(center.lat, center.lon, JIS_MESH_LEVELS.lv1);
    const x5 = toJisMeshCode(center.lat, center.lon, JIS_MESH_LEVELS.x5);
    const lv3 = toJisMeshCode(center.lat, center.lon, JIS_MESH_LEVELS.lv3);
    const rendered = renderMeshTileUrlTemplate(
      'https://mesh.example/{jismesh-lv1}/{jismesh-x5}/{jismesh-lv3}/{z}/{x}/{y}.tile',
      tile
    );
    assert.equal(rendered, `https://mesh.example/${lv1}/${x5}/${lv3}/12/3639/1612.tile`);
  });

  it('renders numeric japanmesh placeholders in URL templates', () => {
    const tile = { z: 12, x: 3639, y: 1612 };
    const center = xyzTileCenter(tile);
    const lv1 = toJisMeshCode(center.lat, center.lon, JIS_MESH_LEVELS.lv1);
    const x5 = toJisMeshCode(center.lat, center.lon, JIS_MESH_LEVELS.x5);
    const lv3 = toJisMeshCode(center.lat, center.lon, JIS_MESH_LEVELS.lv3);
    const rendered = renderMeshTileUrlTemplate(
      'https://mesh.example/{jismesh-80000}/{jismesh-5000}/{jismesh-1000}/{z}/{x}/{y}.tile',
      tile
    );
    assert.equal(rendered, `https://mesh.example/${lv1}/${x5}/${lv3}/12/3639/1612.tile`);
  });

  it('rejects unsupported JIS placeholders', () => {
    assert.throws(
      () =>
        renderMeshTileUrlTemplate('https://mesh.example/{jismesh-x40}/{z}/{x}/{y}.tile', {
          z: 12,
          x: 3639,
          y: 1612,
        }),
      /Unsupported JIS mesh placeholder/
    );
  });

  it('converts decoded XYZ mesh tile to GeoJSON polygons', async () => {
    const fixturePath = join(process.cwd(), 'test', 'fixtures', 'xyz-uncompressed.tile');
    const bytes = new Uint8Array(await fs.readFile(fixturePath));
    const decoded = await decodeTile(bytes);
    const geojson = decodedMeshTileToGeoJson(decoded);

    assert.equal(geojson.type, 'FeatureCollection');
    assert.equal(geojson.features.length, 4);
    assert.deepEqual(geojson.features[0].properties, {
      row: 0,
      col: 0,
      b0: 10,
      b1: 110,
      b2: 210,
    });
    assert.deepEqual(geojson.features[3].properties, {
      row: 1,
      col: 1,
      b0: 40,
      b1: 140,
      b2: 240,
    });
  });

  it('fetches, decodes, and converts tiles via maplibre source handler', async () => {
    const fixturePath = join(process.cwd(), 'test', 'fixtures', 'xyz-uncompressed.tile');
    const bytes = new Uint8Array(await fs.readFile(fixturePath));
    const payload = new Uint8Array(bytes.length);
    payload.set(bytes);
    const requestedUrls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(payload.buffer, { status: 200 });
    };

    const handler = createMapLibreSourceHandler({
      urlTemplate: 'https://tiles.example/{z}/{x}/{y}.tile',
      fetch: fetchStub,
    });

    const fetched = await handler.fetchTile({ z: 12, x: 3639, y: 1612 });
    assert.equal(requestedUrls.length, 1);
    assert.equal(requestedUrls[0], 'https://tiles.example/12/3639/1612.tile');
    assert.equal(fetched.request_url, 'https://tiles.example/12/3639/1612.tile');
    assert.equal(fetched.geojson.features.length, 4);
  });

  it('builds protocol tile URL templates', () => {
    const template = buildMapLibreMeshProtocolUrlTemplate('https://tiles.example/{jismesh-lv1}.tile', {
      protocol: 'meshtiles',
    });
    assert.equal(
      template,
      'meshtiles://tiles/{z}/{x}/{y}.mvt?template=https%3A%2F%2Ftiles.example%2F%7Bjismesh-lv1%7D.tile'
    );
  });

  it('creates a protocol handler that returns transferable array buffers', async () => {
    const fixturePath = join(process.cwd(), 'test', 'fixtures', 'xyz-uncompressed.tile');
    const bytes = new Uint8Array(await fs.readFile(fixturePath));
    const payload = new Uint8Array(bytes.length);
    payload.set(bytes);

    const requestedUrls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(payload.slice().buffer, { status: 200 });
    };

    const protocol = createMapLibreMeshTileProtocol({
      protocol: 'meshtiles',
      fetch: fetchStub,
    });
    const requestUrl = buildMapLibreMeshProtocolUrlTemplate('https://tiles.example/{jismesh-lv1}.tile', {
      protocol: 'meshtiles',
    })
      .replace('{z}', '10')
      .replace('{x}', '909')
      .replace('{y}', '403');

    const first = await protocol({ url: requestUrl }, new AbortController());
    const second = await protocol({ url: requestUrl }, new AbortController());

    assert.ok(first.data instanceof ArrayBuffer);
    assert.ok(second.data instanceof ArrayBuffer);
    assert.notEqual(first.data, second.data);
    assert.ok(first.data.byteLength > 0);
    assert.ok(requestedUrls.length >= 1);
  });

  it('does not drop shared mesh data when another overlapping request aborts', async () => {
    const fixturePath = join(process.cwd(), 'test', 'fixtures', 'xyz-uncompressed.tile');
    const bytes = new Uint8Array(await fs.readFile(fixturePath));
    const payload = new Uint8Array(bytes.length);
    payload.set(bytes);

    const emptyBytes = fromGeojsonVt(
      { [MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME]: { features: [] } as never },
      {
        extent: MAPLIBRE_MESH_PROTOCOL_DEFAULT_VECTOR_EXTENT,
        version: MAPLIBRE_MESH_PROTOCOL_DEFAULT_VECTOR_VERSION,
      }
    );

    const requestedUrls: string[] = [];
    let resolveFirstFetchStart!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      resolveFirstFetchStart = resolve;
    });
    let releaseFetch!: () => void;
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let didStartFirstFetch = false;

    const fetchStub: typeof fetch = async (input, init) => {
      requestedUrls.push(String(input));
      if (!didStartFirstFetch) {
        didStartFirstFetch = true;
        resolveFirstFetchStart();
      }

      const signal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          cleanup();
          reject(signal?.reason ?? new Error('aborted'));
        };
        const onRelease = (): void => {
          cleanup();
          resolve();
        };
        const cleanup = (): void => {
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
        };

        if (signal) {
          if (signal.aborted) {
            cleanup();
            reject(signal.reason ?? new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }

        fetchRelease.then(onRelease, reject);
      });

      return new Response(payload.slice().buffer, { status: 200 });
    };

    const protocol = createMapLibreMeshTileProtocol({
      protocol: 'meshtiles',
      fetch: fetchStub,
      jismeshSamplePoints: ['center'],
    });

    const template = buildMapLibreMeshProtocolUrlTemplate('https://tiles.example/static.tile', {
      protocol: 'meshtiles',
    });
    const firstRequestUrl = template.replace('{z}', '12').replace('{x}', '3638').replace('{y}', '1612');
    const secondRequestUrl = template.replace('{z}', '12').replace('{x}', '3639').replace('{y}', '1612');
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();

    const firstPromise = protocol({ url: firstRequestUrl }, firstAbortController);
    await firstFetchStarted;

    const secondPromise = protocol({ url: secondRequestUrl }, secondAbortController);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    firstAbortController.abort();
    releaseFetch();

    const [, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(requestedUrls.length, 1);
    assert.notDeepEqual(new Uint8Array(second.data), emptyBytes);
  });

  it('resolves multiple lv1 mesh tiles for low zoom requests', async () => {
    const fixturePath = join(process.cwd(), 'test', 'fixtures', 'xyz-uncompressed.tile');
    const bytes = new Uint8Array(await fs.readFile(fixturePath));
    const payload = new Uint8Array(bytes.length);
    payload.set(bytes);

    const requestedUrls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(payload.slice().buffer, { status: 200 });
    };

    const protocol = createMapLibreMeshTileProtocol({
      protocol: 'meshtiles',
      fetch: fetchStub,
      jismeshSamplePoints: ['center'],
    });

    const requestUrl = buildMapLibreMeshProtocolUrlTemplate('https://tiles.example/{jismesh-lv1}.tile', {
      protocol: 'meshtiles',
    })
      .replace('{z}', '3')
      .replace('{x}', '7')
      .replace('{y}', '3');

    const result = await protocol({ url: requestUrl }, new AbortController());
    assert.ok(result.data.byteLength > 0);
    assert.ok(requestedUrls.length > 1);
  });

  it('is unconstrained by default for zoom range', async () => {
    const fixturePath = join(process.cwd(), 'test', 'fixtures', 'xyz-uncompressed.tile');
    const bytes = new Uint8Array(await fs.readFile(fixturePath));
    const payload = new Uint8Array(bytes.length);
    payload.set(bytes);

    const requestedUrls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(payload.slice().buffer, { status: 200 });
    };

    const protocol = createMapLibreMeshTileProtocol({
      protocol: 'meshtiles',
      fetch: fetchStub,
    });
    const requestUrl = buildMapLibreMeshProtocolUrlTemplate('https://tiles.example/{jismesh-lv1}.tile', {
      protocol: 'meshtiles',
    })
      .replace('{z}', '15')
      .replace('{x}', '29088')
      .replace('{y}', '12896');

    const result = await protocol({ url: requestUrl }, new AbortController());
    assert.ok(result.data.byteLength > 0);
    assert.ok(requestedUrls.length >= 1);
  });

  it('supports optional min/max zoom constraints', async () => {
    const requestedUrls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(new ArrayBuffer(0), { status: 200 });
    };

    const protocol = createMapLibreMeshTileProtocol({
      protocol: 'meshtiles',
      fetch: fetchStub,
      zoom: {
        min: 4,
        max: 8,
      },
    });
    const requestUrl = buildMapLibreMeshProtocolUrlTemplate('https://tiles.example/{jismesh-lv1}.tile', {
      protocol: 'meshtiles',
    })
      .replace('{z}', '10')
      .replace('{x}', '909')
      .replace('{y}', '403');

    const result = await protocol({ url: requestUrl }, new AbortController());
    assert.ok(result.data.byteLength > 0);
    assert.equal(requestedUrls.length, 0);
  });
});
