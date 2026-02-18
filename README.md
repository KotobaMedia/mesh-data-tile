# mesh-data-tile

[日本語版はこちら (README.ja.md)](README.ja.md)

Reference implementation for Mesh Tile Format v1 (`MTI1`) with a TypeScript library package and a separate CLI package.

## What are meshtiles?

Meshtiles are binary tiles for numeric grid data. Each tile stores typed values (`rows x cols x bands`) plus core metadata (dtype, endianness, compression, no-data marker, mesh kind, and tile id) inside the tile itself.

They are designed to deliver highly efficient numerical data in tiles for map/data workflows, including but not limited to XYZ tiles (for example, native JIS X0410 mesh tiles).

## Meshtiles vs the alternatives

| Topic | Meshtiles (`MTI1`) | Numerical PNG tiles | Vector tiles (MVT) |
| --- | --- | --- | --- |
| Main data model | Typed numeric raster/grid values | Image channels with numeric packing conventions | Vector geometries + feature attributes |
| Band support | Native multi-band numeric payload (`bands` in header) | Usually constrained to PNG channel model (typically RGBA) and custom packing | No native raster band model; numeric grids require conversion/workarounds |
| Metadata | Internal, self-describing tile metadata in the binary header | Commonly external/implicit metadata conventions | Layer/feature properties exist, but not a native raster tile metadata header |
| JIS mesh support | Native mesh kind + tile identity for `jis-x0410` | No native JIS mesh identity model | No native JIS mesh identity model |

- Specification details: [Mesh Tile Format v1 spec](spec/tile-format-v1.md)
- [See a demo using the MapLibre addProtocol adapter](https://kotobamedia.github.io/mesh-data-tile/)

## Prerequisites

- Node.js 20+
- `pnpm`

## Workspace packages

- `mesh-data-tile` (root): library package.
- `mesh-data-tile-cli`: CLI package.
- `mesh-data-tile-maplibre-example`: example app package.

## Help

```bash
pnpm cli --help
```

## CLI commands

- `inspect <input>`
- `decode <input> [--output <path>]`
- `encode --output <path> [options]`

### `inspect`

Prints parsed header fields as:

```text
Label: value
Label: value
```

```bash
pnpm cli inspect test/fixtures/uncompressed.tile
```

### `decode`

Decodes a tile and prints data only in CSV format.

Output format:

- Header row: `x,y,b0,b1,b2,...`
- Data rows: `X,Y,A,B,C,...`
- `X` is column index (`x`), `Y` is row index (`y`), both zero-based.
- `A,B,C,...` are band values for that pixel.

```bash
pnpm cli decode test/fixtures/uncompressed.tile
```

Write decoded CSV to a file:

```bash
pnpm cli decode test/fixtures/uncompressed.tile --output decoded.csv
```

### `encode`

Create a tile from metadata + numeric values.

Required metadata:

- `--tile-id <u64>`
- `--mesh-kind <jis-x0410|xyz>`
- `--rows <u32>`
- `--cols <u32>`
- `--bands <u8>`
- `--dtype <uint8|int8|uint16|int16|uint32|int32|float32|float64>`
- `--endianness <little|big>`

`tile_id` semantics:

- `mesh_kind=jis-x0410`: `tile_id` is the JIS mesh code integer.
- `mesh_kind=xyz`: `tile_id` is packed as `(zoom << 58) | quadkey_integer`, where `quadkey_integer` is the quadkey interpreted as base-4, and zoom max is `29`.

Optional metadata:

- `--compression <none|deflate-raw>`
- `--no-data <number|null>`

Values input:

- `--values '[1,2,3,4]'`
- or `--values-file values.json`

Example:

```bash
pnpm cli encode \
  --output out.tile \
  --tile-id 42 \
  --mesh-kind jis-x0410 \
  --rows 2 \
  --cols 2 \
  --bands 1 \
  --dtype uint16 \
  --endianness little \
  --compression none \
  --values '[10,20,30,40]'
```

## Using a metadata file

You can pass `--metadata <json_file>` and combine/override with flags.

Example `metadata.json`:

```json
{
  "tile_id": "42",
  "mesh_kind": "jis-x0410",
  "rows": 2,
  "cols": 2,
  "bands": 1,
  "dtype": "uint16",
  "endianness": "little",
  "compression": "none",
  "no_data": null
}
```

Run:

```bash
pnpm cli encode --metadata metadata.json --values-file values.json --output out.tile
```

## XYZ tile ID helpers

```ts
import { encodeXyzTileId, decodeXyzTileId } from 'mesh-data-tile';

const tileId = encodeXyzTileId({ zoom: 12, x: 3639, y: 1612 });
const decoded = decodeXyzTileId(tileId);
// decoded => { zoom: 12, x: 3639, y: 1612, quadkey_integer: ... }
```

## Library API

Use low-level byte APIs:

```ts
import { encodeTile, decodeTile, inspectTile } from 'mesh-data-tile';

const encoded = await encodeTile({
  tile_id: '42',
  mesh_kind: 'jis-x0410',
  rows: 2,
  cols: 2,
  bands: 1,
  dtype: 'uint16',
  endianness: 'little',
  compression: 'none',
  data: [10, 20, 30, 40],
});

const inspected = inspectTile(encoded.bytes);
const decoded = await decodeTile(encoded.bytes);
```

Use high-level helpers (core library is runtime-neutral; file I/O is caller-managed):

```ts
import {
  decodeTile,
  decodeTileToCsv,
  encodeTile,
  inspectTile,
} from 'mesh-data-tile';
import { readFile, writeFile } from 'node:fs/promises';

const bytes = new Uint8Array(await readFile('in.tile'));
const inspected = inspectTile(bytes);
const { csv } = await decodeTileToCsv(bytes);
const decoded = await decodeTile(bytes);
console.log(inspected.header.tile_id, csv);

const encoded = await encodeTile({
  tile_id: 99n,
  mesh_kind: 'jis-x0410',
  rows: 2,
  cols: 2,
  bands: 1,
  dtype: 'uint8',
  endianness: 'little',
  data: [1, 2, 3, 4],
});
await writeFile('out.tile', encoded.bytes);
```

For CLI-style inspect text output and file-path based operations, use `mesh-data-tile-cli`.

## MapLibre addProtocol support

```ts
import maplibregl from 'maplibre-gl';
import {
  MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME,
  createMapLibreMeshTileProtocol,
} from 'mesh-data-tile/browser';

const protocol = createMapLibreMeshTileProtocol();
maplibregl.addProtocol('meshtiles', protocol);

map.addSource('jismesh-example', {
  type: 'vector',
  url: `meshtiles://https://kotobamedia.github.io/mesh-data-tile/tiles/{jismesh-lv1}.tile`,
});

map.addLayer({
  id: 'jismesh-fill',
  type: 'fill',
  source: 'jismesh-example',
  'source-layer': MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME,
});
```

Optional zoom constraints can be set in the protocol options:

```ts
createMapLibreMeshTileProtocol({
  zoom: { min: 4, max: 12 },
});
```

By default, zoom is unconstrained.

## Browser CDN build

The package ships a browser bundle with vendored runtime deps (`@maplibre/geojson-vt`, `@maplibre/vt-pbf`, and `japanmesh`):

- ESM: `mesh-data-tile/cdn`
- IIFE/global: `mesh-data-tile/cdn/iife` (global name: `MeshDataTile`)

Example ESM usage from an npm CDN:

```html
<script type="module">
  import { createMapLibreMeshTileProtocol } from 'https://unpkg.com/mesh-data-tile/dist/browser/mesh-data-tile-browser.es.js';
  console.log(typeof createMapLibreMeshTileProtocol);
</script>
```

## Run tests

```bash
pnpm test
```

## Example app

Run the MapLibre + JIS mesh example app:

```bash
pnpm example:maplibre
```

Then open:

```text
http://localhost:4173
```

Generate only static example tiles:

```bash
pnpm example:maplibre:tiles
```

GitHub Pages deployment for the example is configured in:

```text
.github/workflows/pages.yml
```

The example uses `createMapLibreMeshTileProtocol(...)` with direct protocol source URLs (`meshtiles://{relative path}` or `meshtiles://https://{absolute path}`). The handler returns TileJSON and serves tile bytes internally, so tile fetching/decoding/tiling all happen inside the library protocol handler.
