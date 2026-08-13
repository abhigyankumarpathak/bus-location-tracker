import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { theme } from './ui';

/**
 * The map, on WEB — a real one, drawn with Leaflet.
 *
 * `expo-maps` has no web implementation at all. The native `Map.tsx` imports it
 * at the top of the file, and on web that import blows up the moment the screen
 * mounts — which renders as a blank white page, because the component never gets
 * far enough to show its own fallback.
 *
 * Metro resolves this `.web.tsx` ahead of `Map.tsx` when bundling for web, so
 * `expo-maps` is never referenced on web and `leaflet` is never referenced on
 * native. (Proven, not assumed: `expo export -p ios` contains no Leaflet.) Same
 * reason `session-storage.web.ts` exists. A runtime `Platform.OS` check does NOT
 * work here: Metro resolves imports at build time.
 *
 * What used to be here was an ordered list of dots down a rail — honest, but not
 * a map, and the transport office runs on the web build. This is the same
 * component contract with an actual slippy map behind it, so a coordinator at a
 * desk can see that a hub landed on the right corner rather than in the next
 * county.
 *
 * ## Why the imports are safe
 *
 * Leaflet touches `document` at module load, which is fine because `app.json`
 * sets `web.output: "single"` — a client-rendered SPA, no prerender. **If that
 * ever becomes `"static"`, this import has to move behind a dynamic `import()`
 * inside the mount path**, or the prerender crashes.
 *
 * `leaflet.css` is imported as a global stylesheet, which Metro supports on web
 * and silently ignores on native. Its `url()` references — the default marker
 * PNGs, the layers-control sprite — do not resolve through Metro, which costs
 * nothing here because every pin is a `divIcon` and there is no layers control.
 * Do not switch to `L.marker`'s default icon expecting it to render.
 *
 * ## Where this deliberately differs from the native map
 *
 * `Map.tsx` re-points its camera whenever `center` changes. Here `center` only
 * decides the *opening* view: a browser map is something the reader pans and
 * zooms with a mouse, and a camera driven from props snatches it back every time
 * a van fix arrives. Instead the view frames the stops, then follows the van only
 * once it has left the visible area.
 */

/** Same shape as `Map.tsx`'s. The two files are one component, so this has to
 *  stay identical to the declaration there. */
export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  title: string;
  /** Buses render distinctly from stops; `pickup` is the viewer's own hub. */
  kind?: 'bus' | 'stop' | 'pickup';
  /** A short overlay drawn *on* the pin — in practice the stop's `seq`. */
  badge?: string;
}

interface MapProps {
  markers: MapMarker[];
  path?: { lat: number; lng: number }[];
  center?: { lat: number; lng: number } | null;
  zoom?: number;
  style?: object;
}

/** CARTO's dark basemap, to sit on the app's own near-black rather than fight
 *  it. Free with attribution; swap the URL and the credit together if that
 *  changes. */
const TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const CREDIT =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

const PIN_STYLES = `
.stp-pin {
  display: flex; align-items: center; justify-content: center;
  box-sizing: border-box; border-radius: 999px; position: relative;
  font: 700 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  border: 2px solid ${theme.bg};
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.55);
}
.stp-pin--stop   { width: 22px; height: 22px; background: ${theme.faint};  color: ${theme.bg}; }
.stp-pin--pickup { width: 28px; height: 28px; background: ${theme.accent}; color: ${theme.accentText};
                   border-color: ${theme.text}; }
.stp-pin--bus    { width: 30px; height: 30px; background: ${theme.bus};    color: ${theme.bg};
                   border-color: ${theme.text}; }
.stp-pin--bus::after {
  content: ''; position: absolute; inset: -7px; border-radius: 999px;
  border: 2px solid ${theme.bus}; opacity: 0.55;
  animation: stp-pulse 2s ease-out infinite;
}
@keyframes stp-pulse {
  0%   { transform: scale(0.7); opacity: 0.55; }
  100% { transform: scale(1.25); opacity: 0; }
}
.leaflet-container { background: ${theme.bg}; font-family: inherit; }
.leaflet-container .leaflet-control-attribution {
  background: rgba(11, 18, 32, 0.78); color: ${theme.faint}; font-size: 10px;
}
.leaflet-container .leaflet-control-attribution a { color: ${theme.muted}; }
.leaflet-bar a {
  background: ${theme.surface}; color: ${theme.text}; border-bottom-color: ${theme.border};
}
.leaflet-bar a:hover { background: ${theme.surfaceAlt}; color: ${theme.text}; }
`;

/** One `<style>` for the whole app, added the first time a map mounts. */
function ensurePinStyles() {
  const id = 'stp-map-styles';
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = PIN_STYLES;
  document.head.appendChild(el);
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const BUS_GLYPH =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M6 2h12a3 3 0 0 1 3 3v9a3 3 0 0 1-1.5 2.6V19a1.5 1.5 0 0 1-3 0v-1H7.5v1a1.5 1.5 0 0 1-3 0v-2.4A3 3 0 0 1 3 14V5a3 3 0 0 1 3-3Zm-.5 4v5h13V6h-13ZM7 13.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm10 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"/>' +
  '</svg>';

function iconFor(marker: MapMarker) {
  const kind = marker.kind ?? 'stop';
  const size = kind === 'bus' ? 30 : kind === 'pickup' ? 28 : 22;
  const inner = kind === 'bus' ? BUS_GLYPH : escapeHtml(marker.badge ?? '');

  return L.divIcon({
    // An empty className replaces Leaflet's own `leaflet-div-icon`, which would
    // otherwise paint a white box behind every pin.
    className: '',
    html: `<div class="stp-pin stp-pin--${kind}">${inner}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Leaflet renders popup content as HTML, and stop names are staff-entered — so
 *  the label goes in as a text node, which cannot inject anything. */
function textNode(value: string) {
  const el = document.createElement('div');
  el.textContent = value;
  el.style.color = theme.bg;
  el.style.fontWeight = '600';
  return el;
}

/** A stable empty default — a fresh `[]` per render would rebuild every layer. */
const NO_PATH: { lat: number; lng: number }[] = [];

export function Map({ markers, path = NO_PATH, center, zoom = 13, style }: MapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
  const sizeRef = useRef<ResizeObserver | null>(null);
  const framed = useRef(false);

  /** The *opening* view, captured once. Later changes must not re-frame the map. */
  const opening = useRef({ center, zoom }).current;

  const stops = useMemo(() => markers.filter((m) => m.kind !== 'bus'), [markers]);
  const van = markers.find((m) => m.kind === 'bus') ?? null;

  /** Re-frame only when the *stops* change. A van moving must not pull the view. */
  const fitKey = stops.map((s) => `${s.id}:${s.lat}:${s.lng}`).join('|');

  /**
   * Built and torn down by a ref callback rather than a mount effect.
   *
   * The container is not always rendered — with nothing to show this component
   * renders a panel instead — so "on mount" is the wrong moment. A `[]` effect
   * would run once against a container that did not exist yet and never run
   * again when the first marker arrived, leaving a permanently blank map. The
   * ref fires whenever the node actually attaches, which is the real event.
   *
   * `react-native-web`'s `View` forwards its ref to the underlying `div`, so the
   * cast below is correct — just not something TypeScript will tell you. It
   * merges refs with a plain function that ignores return values, so React 19's
   * ref-cleanup protocol does not apply: teardown arrives as a `null` node, and
   * it has to call `map.remove()`. Leaflet stamps the element with `_leaflet_id`
   * and throws "Map container is already initialized" on the next attach
   * otherwise — which React's dev-mode double invocation surfaces immediately,
   * and that is a feature.
   */
  const attach = useCallback((node: View | null) => {
    const el = node as unknown as HTMLElement | null;

    if (!el) {
      sizeRef.current?.disconnect();
      mapRef.current?.remove();
      sizeRef.current = null;
      mapRef.current = null;
      layersRef.current = null;
      framed.current = false;
      return;
    }
    if (mapRef.current) return;

    ensurePinStyles();

    const map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      // Every screen with a map on it is one long ScrollView. A map that grabs
      // the wheel traps the page, so the wheel only zooms once it is clicked.
      scrollWheelZoom: false,
    });
    map.on('click', () => map.scrollWheelZoom.enable());
    map.on('mouseout', () => map.scrollWheelZoom.disable());

    L.tileLayer(TILES, {
      attribution: CREDIT,
      subdomains: 'abcd',
      maxZoom: 20,
      detectRetina: true,
    }).addTo(map);

    map.setView(
      [opening.center?.lat ?? 0, opening.center?.lng ?? 0],
      opening.center ? opening.zoom : 2,
    );

    layersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // A flex layout can size the container after Leaflet has measured it, which
    // leaves the tiles laid out against a zero-width box.
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(el);
    sizeRef.current = observer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pins and the route line.
  useEffect(() => {
    const group = layersRef.current;
    if (!group) return;
    group.clearLayers();

    for (const marker of markers) {
      // Titles already arrive numbered from the route screen, so the label is
      // the title alone; `badge` is what goes *on* the pin.
      L.marker([marker.lat, marker.lng], {
        icon: iconFor(marker),
        title: marker.title,
        zIndexOffset: marker.kind === 'bus' ? 1000 : 0,
      })
        .bindPopup(textNode(marker.title))
        .addTo(group);
    }

    if (path.length > 1) {
      L.polyline(
        path.map((p) => [p.lat, p.lng] as L.LatLngTuple),
        { color: theme.accent, weight: 4, opacity: 0.85 },
      ).addTo(group);
    }
  }, [markers, path]);

  // Frame the stops. The *first* framing includes the van, so VanEta's two-pin
  // map — one hub, one van — opens with both in shot, which is what its `center`
  // was asking for. Every later re-frame is stops only, so a van crossing the
  // route never pulls the view around.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const points = stops.map((s) => [s.lat, s.lng] as L.LatLngTuple);
    if (!framed.current && van) points.push([van.lat, van.lng]);
    if (points.length === 0) return;

    framed.current = true;
    if (points.length === 1) {
      // No bounds to fit; honour the zoom the caller asked for.
      map.setView(points[0], zoom);
    } else {
      map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 16 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, van !== null]);

  // Follow the van, but only once it has left the view — otherwise every fix
  // yanks the map out from under whoever is reading it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !van) return;
    const at = L.latLng(van.lat, van.lng);
    if (!map.getBounds().pad(-0.15).contains(at)) map.panTo(at);
  }, [van?.lat, van?.lng]);

  // Both callers can render before their data arrives.
  if (markers.length === 0) {
    return (
      <View style={[styles.placeholder, style]}>
        <Text style={styles.muted}>No stops to show yet.</Text>
      </View>
    );
  }

  return <View ref={attach} style={[styles.map, style]} />;
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
    minHeight: 220,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    // Keeps the tiles inside the rounded corners.
    overflow: 'hidden',
    backgroundColor: theme.bg,
  },
  placeholder: {
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 16,
  },
  muted: { color: theme.faint, fontSize: 14, textAlign: 'center' },
});
