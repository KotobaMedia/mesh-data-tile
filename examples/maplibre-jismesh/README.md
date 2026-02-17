# MapLibre JIS Mesh Example

Run:

```bash
pnpm example:maplibre
```

Then open:

```text
http://localhost:4173
```

This example uses:

- Basemap style: `https://tiles.kmproj.com/styles/osm-ja-light.json`
- Coverage: mesh vector tiles loaded on demand by MapLibre
- Map source template: `meshtiles://tiles/{z}/{x}/{y}.mvt?template=...`
- Protocol target template: `tiles/{jismesh-lv1}.tile`
- Per-mesh raster shape: `8 x 8`
- Values: global SW->NE gradient across all LV1 meshes (`0` to `0xFFFF`)
- Prebuilt static `.tile` files generated into `public/tiles/`
- Runtime fetching/decoding/tiling through library API:
  - `createMapLibreMeshTileProtocol(...)`
  - `buildMapLibreMeshProtocolUrlTemplate(...)`
- Zoom range is unconstrained by default (optional constraints are available in protocol options).

Generate only the static tiles:

```bash
pnpm example:maplibre:tiles
```
