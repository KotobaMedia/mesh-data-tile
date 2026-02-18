# mesh-data-tile

[English version (README.md)](README.md)

Mesh Tile Format v1 (`MTI1`) のリファレンス実装です。TypeScript のライブラリパッケージと、別パッケージの CLI を含みます。

## meshtiles とは？

meshtiles は、数値グリッドデータ向けのバイナリタイルです。各タイルには、型付き値（`rows x cols x bands`）に加えて、主要メタデータ（dtype、endianness、compression、no-data マーカー、mesh kind、tile id）がタイル内部に格納されます。

map/data ワークフローで高効率に数値データをタイル配信するために設計されており、XYZ タイルに限定されません（例: JIS X0410 メッシュタイルをネイティブに扱えます）。

## Meshtiles と代替手法の比較

| 項目 | Meshtiles (`MTI1`) | Numerical PNG tiles | Vector tiles (MVT) |
| --- | --- | --- | --- |
| 主なデータモデル | 型付きの数値ラスタ/グリッド値 | 数値パック前提の画像チャネル | ベクター形状 + フィーチャ属性 |
| バンド対応 | マルチバンド数値ペイロードをネイティブ対応（ヘッダーの `bands`） | 通常は PNG のチャネルモデル（一般に RGBA）と独自パッキングに制約される | ラスタバンドモデルはネイティブ非対応。数値グリッドは変換や回避策が必要 |
| メタデータ | バイナリヘッダー内で自己記述的に保持 | 外部定義や暗黙ルールに依存しがち | レイヤー/フィーチャ属性はあるが、ラスタタイル向けのネイティブヘッダーはない |
| JIS メッシュ対応 | `jis-x0410` の mesh kind と tile identity をネイティブ表現 | JIS メッシュ identity モデルはネイティブ非対応 | JIS メッシュ identity モデルはネイティブ非対応 |

仕様の詳細: [Mesh Tile Format v1 spec](spec/tile-format-v1.md)

## 前提条件

- Node.js 20+
- `pnpm`

## ワークスペースパッケージ

- `mesh-data-tile`（root）: ライブラリパッケージ
- `mesh-data-tile-cli`: CLI パッケージ
- `mesh-data-tile-maplibre-example`: サンプルアプリパッケージ

## ヘルプ

```bash
pnpm cli --help
```

## CLI コマンド

- `inspect <input>`
- `decode <input> [--output <path>]`
- `encode --output <path> [options]`

### `inspect`

パース済みヘッダーフィールドを以下形式で出力します:

```text
Label: value
Label: value
```

```bash
pnpm cli inspect test/fixtures/uncompressed.tile
```

### `decode`

タイルをデコードし、データを CSV 形式でのみ出力します。

出力形式:

- ヘッダー行: `x,y,b0,b1,b2,...`
- データ行: `X,Y,A,B,C,...`
- `X` は列インデックス（`x`）、`Y` は行インデックス（`y`）で、どちらも 0 始まりです。
- `A,B,C,...` はそのピクセルの各バンド値です。

```bash
pnpm cli decode test/fixtures/uncompressed.tile
```

デコードした CSV をファイルに書き出す場合:

```bash
pnpm cli decode test/fixtures/uncompressed.tile --output decoded.csv
```

### `encode`

メタデータ + 数値値からタイルを作成します。

必須メタデータ:

- `--tile-id <u64>`
- `--mesh-kind <jis-x0410|xyz>`
- `--rows <u32>`
- `--cols <u32>`
- `--bands <u8>`
- `--dtype <uint8|int8|uint16|int16|uint32|int32|float32|float64>`
- `--endianness <little|big>`

`tile_id` の意味:

- `mesh_kind=jis-x0410`: `tile_id` は JIS メッシュコード整数です。
- `mesh_kind=xyz`: `tile_id` は `(zoom << 58) | quadkey_integer` でパックされます。`quadkey_integer` は quadkey を base-4 整数として解釈した値で、zoom の最大値は `29` です。

任意メタデータ:

- `--compression <none|deflate-raw>`
- `--no-data <number|null>`

値の入力:

- `--values '[1,2,3,4]'`
- または `--values-file values.json`

例:

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

## メタデータファイルを使う

`--metadata <json_file>` を渡し、フラグとの併用/上書きができます。

`metadata.json` の例:

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

実行:

```bash
pnpm cli encode --metadata metadata.json --values-file values.json --output out.tile
```

## XYZ tile ID ヘルパー

```ts
import { encodeXyzTileId, decodeXyzTileId } from 'mesh-data-tile';

const tileId = encodeXyzTileId({ zoom: 12, x: 3639, y: 1612 });
const decoded = decodeXyzTileId(tileId);
// decoded => { zoom: 12, x: 3639, y: 1612, quadkey_integer: ... }
```

## Library API

低レベルのバイト API を使う場合:

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

CLI 出力相当の高レベルヘルパーを使う場合:

```ts
import {
  decodeTile,
  decodeTileToCsv,
  decodeTileFileToCsv,
  encodeTileToFile,
  inspectTileFile,
  inspectTileToText,
} from 'mesh-data-tile';
import { readFile } from 'node:fs/promises';

const inspectResult = await inspectTileFile('in.tile');
console.log(inspectResult.text);

const { csv } = await decodeTileFileToCsv('in.tile');
console.log(csv);

const bytes = new Uint8Array(await readFile('in.tile'));
const fromBytes = inspectTileToText(bytes);
const csvFromBytes = await decodeTileToCsv(bytes);
const decoded = await decodeTile(bytes);

await encodeTileToFile('out.tile', {
  tile_id: 99n,
  mesh_kind: 'jis-x0410',
  rows: 2,
  cols: 2,
  bands: 1,
  dtype: 'uint8',
  endianness: 'little',
  data: [1, 2, 3, 4],
});
```

## MapLibre addProtocol 対応

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

プロトコルオプションでズーム制約を設定できます:

```ts
createMapLibreMeshTileProtocol({
  zoom: { min: 4, max: 12 },
});
```

デフォルトではズーム制約はありません。

## Browser CDN build

このパッケージは、ランタイム依存（`@maplibre/geojson-vt`、`@maplibre/vt-pbf`、`japanmesh`）を同梱したブラウザバンドルを提供します。

- ESM: `mesh-data-tile/cdn`
- IIFE/global: `mesh-data-tile/cdn/iife`（グローバル名: `MeshDataTile`）

npm CDN からの ESM 利用例:

```html
<script type="module">
  import { createMapLibreMeshTileProtocol } from 'https://unpkg.com/mesh-data-tile/dist/browser/mesh-data-tile-browser.es.js';
  console.log(typeof createMapLibreMeshTileProtocol);
</script>
```

## テスト実行

```bash
pnpm test
```

## サンプルアプリ

MapLibre + JIS メッシュのサンプルアプリを実行:

```bash
pnpm example:maplibre
```

その後、以下を開きます:

```text
http://localhost:4173
```

静的サンプルタイルのみ生成する場合:

```bash
pnpm example:maplibre:tiles
```

サンプル用の GitHub Pages デプロイ設定:

```text
.github/workflows/pages.yml
```

このサンプルは `createMapLibreMeshTileProtocol(...)` を使い、直接プロトコルソース URL（`meshtiles://{relative path}` または `meshtiles://https://{absolute path}`）を利用します。ハンドラーは TileJSON を返し、タイルバイトを内部的に配信するため、タイルの取得/デコード/タイル化はすべてライブラリのプロトコルハンドラー内で完結します。
