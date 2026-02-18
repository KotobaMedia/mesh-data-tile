import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import {
  MAPLIBRE_MESH_PROTOCOL_DEFAULT_SCHEME,
  MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME,
  createMapLibreMeshTileProtocol,
} from '../../src/browser.js';

type LonLat = {
  lon: number;
  lat: number;
};

const BASEMAP_STYLE_URL = 'https://tiles.kmproj.com/styles/osm-ja-light.json';
const PROTOCOL_SCHEME = MAPLIBRE_MESH_PROTOCOL_DEFAULT_SCHEME;
const MESH_SOURCE_URL = `${PROTOCOL_SCHEME}://tiles/{jismesh-lv1}.tile`;
const SOURCE_ID = 'jismesh-example';
const SOURCE_LAYER = MAPLIBRE_MESH_PROTOCOL_DEFAULT_LAYER_NAME;
const DEFAULT_CENTER: LonLat = {
  lon: 139.6917,
  lat: 35.6895,
};
const DEFAULT_ZOOM = 10;

function getStatusElement(): HTMLElement {
  const element = document.getElementById('status');
  if (!element) {
    throw new Error('status element is missing from the page.');
  }
  return element;
}

function setStatus(text: string): void {
  getStatusElement().textContent = text;
}

async function main(): Promise<void> {
  setStatus('Registering protocol...');

  maplibregl.removeProtocol(PROTOCOL_SCHEME);
  maplibregl.addProtocol(
    PROTOCOL_SCHEME,
    createMapLibreMeshTileProtocol({
      onStats: (stats) => {
        setStatus(
          `Protocol requests: ${stats.requested}, loaded: ${stats.loaded}, cache hits: ${stats.cache_hits}, in-flight: ${stats.in_flight}, failures: ${stats.failures}.`
        );
      },
    })
  );

  const map = new maplibregl.Map({
    container: 'map',
    style: BASEMAP_STYLE_URL,
    center: [DEFAULT_CENTER.lon, DEFAULT_CENTER.lat],
    zoom: DEFAULT_ZOOM,
    minZoom: 3,
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }));

  map.on('load', () => {
    map.addSource(SOURCE_ID, {
      type: 'vector',
      url: MESH_SOURCE_URL,
    });

    map.addLayer({
      id: 'jismesh-fill',
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      paint: {
        'fill-color': [
          'interpolate',
          ['linear'],
          ['get', 'value'],
          0,
          '#f7fbff',
          16384,
          '#c6dbef',
          32768,
          '#6baed6',
          49152,
          '#3182bd',
          65535,
          '#08519c',
        ],
        'fill-opacity': 0.52,
      },
    });

    map.addLayer({
      id: 'jismesh-line',
      type: 'line',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      paint: {
        'line-color': '#1f2937',
        'line-width': 0.35,
        'line-opacity': 0.75,
      },
    });

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
    });

    map.on('mousemove', 'jismesh-fill', (event) => {
      const feature = event.features?.[0];
      if (!feature) {
        return;
      }
      const props = feature.properties as Record<string, string | number | undefined>;
      map.getCanvas().style.cursor = 'pointer';
      popup
        .setLngLat(event.lngLat)
        .setHTML(
          `<strong>Mesh:</strong> ${String(props.mesh_code)}<br/>` +
            `<strong>Value:</strong> ${String(props.value)} (0x${Number(props.value).toString(16).toUpperCase().padStart(4, '0')})<br/>` +
            `<strong>Cell:</strong> row ${String(props.row)}, col ${String(props.col)}`
        )
        .addTo(map);
    });

    map.on('mouseleave', 'jismesh-fill', () => {
      map.getCanvas().style.cursor = '';
      popup.remove();
    });
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`Failed to load example: ${message}`);
  throw error;
});
