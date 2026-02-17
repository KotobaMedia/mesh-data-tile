# mesh-data-tile

Reference implementation for Mesh Tile Format v1 (`MTI1`) with a TypeScript CLI.

## Prerequisites

- Node.js 20+
- `pnpm`

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

## Run tests

```bash
pnpm test
```
