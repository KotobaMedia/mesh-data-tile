# MapLibre JIS Mesh Example

Run:

```bash
pnpm --filter mesh-data-tile-maplibre-example run dev
```

Then open:

```text
http://localhost:4173
```

This example uses:

- Basemap style: `https://tiles.kmproj.com/styles/osm-ja-light.json`
- Coverage: mesh vector tiles loaded on demand by MapLibre
- Map source URL: `meshtiles://tiles/{jismesh-lv1}.tile`
- Protocol target template: `tiles/{jismesh-lv1}.tile`
- Per-mesh raster shape: `8 x 8`
- Values: global SW->NE gradient across all LV1 meshes (`0` to `0xFFFF`)
- Prebuilt static `.tile` files generated into `public/tiles/`
- Runtime fetching/decoding/tiling through library API:
  - `createMapLibreMeshTileProtocol(...)`
- Zoom range is unconstrained by default (optional constraints are available in protocol options).

Use the example data in your own map:

```ts
import maplibregl from 'maplibre-gl';
import {
  MAPLIBRE_MESH_PROTOCOL_DEFAULT_SCHEME,
  MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME,
  createMapLibreMeshTileProtocol,
} from 'mesh-data-tile/browser';

const protocol = MAPLIBRE_MESH_PROTOCOL_DEFAULT_SCHEME;
maplibregl.addProtocol(protocol, createMapLibreMeshTileProtocol());

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.kmproj.com/styles/osm-ja-light.json',
  center: [139.6917, 35.6895],
  zoom: 10,
});

map.on('load', () => {
  map.addSource('mesh', {
    type: 'vector',
    url: `${protocol}://tiles/{jismesh-lv1}.tile`,
  });

  map.addLayer({
    id: 'mesh-fill',
    type: 'fill',
    source: 'mesh',
    'source-layer': MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME,
    paint: {
      'fill-color': '#2563eb',
      'fill-opacity': 0.35,
    },
  });
});
```

Generate only the static tiles:

```bash
pnpm --filter mesh-data-tile-maplibre-example run generate:tiles
```
