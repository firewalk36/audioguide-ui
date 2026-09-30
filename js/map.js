// @ts-check
/**
 * Yandex Maps 2.1 wrapper: dynamic script loading, placemarks, user
 * marker with accuracy circle, active-route polyline, and routing.
 */
import { CONFIG } from "./config.js";
import { escapeHtml } from "./dom.js";
import { haversineMeters } from "./geo.js";

/** Max distance (metres) from a route's points for the user's own position
 * to be folded into the "fit to route" bounds. */
const FIT_USER_MAX_DISTANCE_M = 5000;

/** Smallest box (degrees of latitude, ≈ 200 m) a walking frame may shrink
 * to, so a lone stop — or a visitor standing right at it — stays at street
 * level instead of zooming in to the maximum. */
const WALK_MIN_SPAN_LAT = 0.0018;

/** @type {Record<string,string>} */
const TRANSPORT_TO_ROUTING_MODE = { walk: "pedestrian", bike: "bicycle", car: "auto", transit: "masstransit" };

/** @type {Record<string,string>} */
const TRANSPORT_TO_YANDEX_RTT = { walk: "pd", bike: "bc", car: "auto", transit: "mt" };

/** Placemark colours from the brand palette (science-step.ru). */
const MARKER_COLORS = { free: "#0051ff", route: "#111214", next: "#fe634e", played: "#8a9197" };

/** @type {Promise<any>|null} */
let scriptPromise = null;

/**
 * Set once `ymaps.route` has failed (the map API key doesn't include the
 * routing service). Cached for the session so repeated clicks don't retry
 * a call that's known to fail and can go straight to the external link.
 */
let routeApiUnavailable = false;

/** @returns {boolean} */
export function isRouteApiUnavailable() {
  return routeApiUnavailable;
}

/**
 * Build a yandex.ru/maps route link that works without our API key, as a
 * fallback for when `ymaps.route` rejects (routing isn't included in the
 * configured key).
 * @param {[number, number]|null} from - [lat, lon], or null/unknown to let Yandex fill "my location"
 * @param {[number, number]} to - [lat, lon]
 * @param {"walk"|"bike"|"car"|"transit"} transport
 * @returns {string|null} the URL, or null if `to` isn't a pair of finite coordinates
 */
export function buildExternalRouteUrl(from, to, transport) {
  if (!Array.isArray(to) || !Number.isFinite(to[0]) || !Number.isFinite(to[1])) return null;
  const fromValid = Array.isArray(from) && Number.isFinite(from[0]) && Number.isFinite(from[1]);
  const rtt = TRANSPORT_TO_YANDEX_RTT[transport] || "pd";
  const rtext = `${fromValid ? `${from[0]},${from[1]}` : ""}~${to[0]},${to[1]}`;
  return `https://yandex.ru/maps/?rtext=${encodeURIComponent(rtext)}&rtt=${rtt}`;
}

/**
 * Load the Yandex Maps API script (once) and resolve with the global
 * `ymaps` object once it is ready. Rejects if it doesn't happen within 15s.
 * @returns {Promise<any>}
 */
export function loadYandexMaps() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15000);
    const existing = /** @type {any} */ (window).ymaps;
    if (existing) {
      existing.ready(() => {
        clearTimeout(timer);
        resolve(existing);
      });
      return;
    }
    const script = document.createElement("script");
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(CONFIG.yandexApiKey)}&lang=ru_RU`;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error("script-load-failed"));
    };
    script.onload = () => {
      const ymaps = /** @type {any} */ (window).ymaps;
      if (!ymaps) {
        clearTimeout(timer);
        reject(new Error("ymaps-missing"));
        return;
      }
      ymaps.ready(() => {
        clearTimeout(timer);
        resolve(ymaps);
      });
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Allow a retry after a failed load. */
export function resetYandexMapsLoader() {
  scriptPromise = null;
}

/**
 * @typedef {Object} MapPoint
 * @property {string} id
 * @property {string} title
 * @property {[number, number]} coordinates
 */

export class GuideMap {
  /**
   * @param {any} ymaps
   * @param {string} containerId
   */
  constructor(ymaps, containerId) {
    this.ymaps = ymaps;
    this.map = new ymaps.Map(containerId, {
      center: CONFIG.mapCenter,
      zoom: CONFIG.mapZoom,
      controls: []
    }, {
      // Re-measure the container whenever its size changes (tab switch,
      // mini-player appearing), so the map never renders into a stale box.
      autoFitToViewport: "always"
    });
    // Zoom sits on the right, below our own "Где я?" button, clear of the
    // top-left filter and the bottom walk panel.
    this.map.controls.add("zoomControl", { size: "small", position: { right: 12, top: 68 } });
    this.pointCollection = new ymaps.GeoObjectCollection();
    this.map.geoObjects.add(this.pointCollection);
    /** @type {any} */
    this.userPlacemark = null;
    /** @type {any} */
    this.userAccuracyCircle = null;
    /** @type {any} */
    this.routeLine = null;
    /** @type {any} */
    this.routeObject = null;
    /** True while one of our own setBounds/setCenter animations runs, so
     * it is never mistaken for the visitor moving the map. */
    this._programmatic = false;
  }

  /**
   * Call `cb` whenever the visitor pans or zooms the map by hand (drag,
   * pinch, wheel, double-tap, zoom buttons). Programmatic moves and taps on
   * placemarks don't count.
   * @param {() => void} cb
   */
  onUserMove(cb) {
    const node = this.map.container.getParentElement();
    let pointerDown = false;
    let gestureUntil = 0;
    const mark = () => { gestureUntil = Date.now() + 800; };
    const opts = { passive: true, capture: true };
    node.addEventListener("pointerdown", () => { pointerDown = true; mark(); }, opts);
    node.addEventListener("pointerup", () => { pointerDown = false; mark(); }, opts);
    node.addEventListener("pointercancel", () => { pointerDown = false; mark(); }, opts);
    node.addEventListener("wheel", mark, opts);
    this.map.events.add("actionbegin", () => {
      if (this._programmatic) return;
      if (pointerDown || Date.now() < gestureUntil) cb();
    });
  }

  /**
   * Run a programmatic view change, flagging it so `onUserMove` ignores it.
   * @param {() => any} fn returns the ymaps promise of the move (or nothing)
   */
  _move(fn) {
    this._programmatic = true;
    const done = () => { this._programmatic = false; };
    try {
      const p = fn();
      if (p && typeof p.then === "function") p.then(done, done);
      else done();
    } catch (err) {
      done();
      throw err;
    }
  }

  /**
   * @param {MapPoint[]} points
   * @param {{ activeRouteOrder?: string[]|null, onSelect: (id:string)=>void,
   *           playedIds?: Set<string>, nextId?: string|null }} opts
   */
  renderPoints(points, { activeRouteOrder = null, onSelect, playedIds = new Set(), nextId = null }) {
    this.pointCollection.removeAll();
    const orderIndex = new Map((activeRouteOrder || []).map((id, i) => [id, i + 1]));
    for (const pt of points) {
      const inRoute = orderIndex.has(pt.id);
      const played = playedIds.has(pt.id);
      const color = !inRoute ? MARKER_COLORS.free
        : pt.id === nextId ? MARKER_COLORS.next
          : played ? MARKER_COLORS.played : MARKER_COLORS.route;
      const placemark = new this.ymaps.Placemark(
        pt.coordinates,
        {
          hintContent: escapeHtml(pt.title),
          iconContent: inRoute ? String(orderIndex.get(pt.id)) : undefined
        },
        {
          preset: inRoute ? "islands#circleIcon" : "islands#circleDotIcon",
          iconColor: color,
          zIndex: pt.id === nextId ? 700 : inRoute ? 600 : 500
        }
      );
      placemark.events.add("click", () => onSelect(pt.id));
      this.pointCollection.add(placemark);
    }
    this._renderRouteLine(points, activeRouteOrder);
  }

  /** Re-measure the container (after it became visible). */
  fitViewport() {
    try {
      this.map.container.fitToViewport();
    } catch {
      /* map not attached yet */
    }
  }

  /**
   * @param {MapPoint[]} points
   * @param {string[]|null} activeRouteOrder
   */
  _renderRouteLine(points, activeRouteOrder) {
    if (this.routeLine) {
      this.map.geoObjects.remove(this.routeLine);
      this.routeLine = null;
    }
    if (!activeRouteOrder || activeRouteOrder.length < 2) return;
    const byId = new Map(points.map(p => [p.id, p]));
    const ordered = activeRouteOrder.map(id => byId.get(id)).filter(Boolean);
    if (ordered.length < 2) return;
    this.routeLine = new this.ymaps.Polyline(
      ordered.map(p => p.coordinates),
      {},
      { strokeColor: "#fe634e", strokeWidth: 5, strokeOpacity: 0.95 }
    );
    this.map.geoObjects.add(this.routeLine);
  }

  /**
   * @param {[number, number]} coords
   * @param {number} accuracyM
   */
  setUserLocation(coords, accuracyM) {
    if (this.userPlacemark) this.map.geoObjects.remove(this.userPlacemark);
    if (this.userAccuracyCircle) this.map.geoObjects.remove(this.userAccuracyCircle);
    this.userAccuracyCircle = new this.ymaps.Circle(
      [coords, Math.max(accuracyM || 0, 5)],
      {},
      { fillColor: "#0051ff22", strokeColor: "#0051ff66", strokeWidth: 1 }
    );
    this.userPlacemark = new this.ymaps.Placemark(coords, {}, { preset: "islands#geolocationIcon" });
    this.map.geoObjects.add(this.userAccuracyCircle);
    this.map.geoObjects.add(this.userPlacemark);
  }

  /** @param {[number, number]} coords */
  centerOn(coords) {
    this._move(() => this.map.setCenter(coords, Math.max(this.map.getZoom(), CONFIG.mapZoom), { duration: 300 }));
  }

  /**
   * Fit the map view to a route's points (a single point just centers on
   * it). Also folds in the user's own position, if known and within
   * `FIT_USER_MAX_DISTANCE_M` of at least one of the route's points.
   * @param {[number, number][]} pointCoords - ordered [lat, lon] pairs, at least one
   * @param {[number, number]|null} [userCoords]
   */
  fitToRoute(pointCoords, userCoords = null) {
    if (!pointCoords.length) return;
    const coordsForBounds = pointCoords.slice();
    if (userCoords && pointCoords.some(c => haversineMeters(c, userCoords) <= FIT_USER_MAX_DISTANCE_M)) {
      coordsForBounds.push(userCoords);
    }
    if (coordsForBounds.length < 2) {
      this._move(() => this.map.setCenter(coordsForBounds[0], 16, { duration: 300 }));
      return;
    }
    const lats = coordsForBounds.map(c => c[0]);
    const lons = coordsForBounds.map(c => c[1]);
    const bounds = [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)]
    ];
    this._move(() => this.map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 40 }));
  }

  /**
   * Walking-mode frame: the next stop plus the visitor's own fix (when
   * known and within `FIT_USER_MAX_DISTANCE_M` of it), fitted into the part
   * of the map that our overlays leave uncovered.
   * @param {[number, number]} nextCoords
   * @param {[number, number]|null} userCoords
   * @param {[number, number, number, number]} margin [top, right, bottom, left] px
   */
  frameWalk(nextCoords, userCoords, margin) {
    const coords = [nextCoords];
    if (userCoords && haversineMeters(nextCoords, userCoords) <= FIT_USER_MAX_DISTANCE_M) coords.push(userCoords);
    const lats = coords.map(c => c[0]);
    const lons = coords.map(c => c[1]);
    let [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    const midLat = (minLat + maxLat) / 2;
    const minSpanLon = WALK_MIN_SPAN_LAT / Math.max(0.2, Math.cos(midLat * Math.PI / 180));
    if (maxLat - minLat < WALK_MIN_SPAN_LAT) {
      minLat = midLat - WALK_MIN_SPAN_LAT / 2;
      maxLat = midLat + WALK_MIN_SPAN_LAT / 2;
    }
    if (maxLon - minLon < minSpanLon) {
      const midLon = (minLon + maxLon) / 2;
      minLon = midLon - minSpanLon / 2;
      maxLon = midLon + minSpanLon / 2;
    }
    this._move(() => this.map.setBounds([[minLat, minLon], [maxLat, maxLon]], { checkZoomRange: true, zoomMargin: margin, duration: 300 }));
  }

  /**
   * Is `coords` inside the visible map minus `margin` (the uncovered area)?
   * @param {[number, number]} coords
   * @param {[number, number, number, number]} margin [top, right, bottom, left] px
   * @returns {boolean}
   */
  isInSafeArea(coords, margin) {
    try {
      const zoom = this.map.getZoom();
      const g = this.map.options.get("projection").toGlobalPixels(coords, zoom);
      const c = this.map.getGlobalPixelCenter();
      const [w, h] = this.map.container.getSize();
      const x = g[0] - c[0] + w / 2;
      const y = g[1] - c[1] + h / 2;
      return x >= margin[3] && x <= w - margin[1] && y >= margin[0] && y <= h - margin[2];
    } catch {
      return true;
    }
  }

  clearRoute() {
    if (this.routeObject) {
      this.map.geoObjects.remove(this.routeObject);
      this.routeObject = null;
    }
  }

  /**
   * Build and draw a walking/cycling/driving/transit route on the map.
   * Throws if `ymaps.route` is unavailable (wrong/limited API key) or
   * rejects for any other reason; callers should fall back to
   * `buildExternalRouteUrl`. Once it fails, the failure is cached for the
   * session (see `isRouteApiUnavailable`) so this throws immediately on
   * later calls instead of repeating a doomed request.
   * @param {[number,number]} from
   * @param {[number,number]} to
   * @param {"walk"|"bike"|"car"|"transit"} transport
   * @returns {Promise<void>}
   */
  async routeTo(from, to, transport) {
    this.clearRoute();
    if (routeApiUnavailable) throw new Error("route-api-unavailable");
    const routingMode = TRANSPORT_TO_ROUTING_MODE[transport] || "pedestrian";
    try {
      const result = await this.ymaps.route([from, to], { mapStateAutoApply: true, routingMode });
      this.routeObject = result;
      this.map.geoObjects.add(result);
    } catch (err) {
      routeApiUnavailable = true;
      throw err;
    }
  }

  destroy() {
    this.map.destroy();
  }
}
