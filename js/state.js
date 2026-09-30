// @ts-check
/**
 * The guide's single shared state container (see js/store.js).
 */
import { Store } from "./store.js";

/**
 * @typedef {Object} Point
 * @property {string} id
 * @property {string} title
 * @property {string} shortDescription
 * @property {string} description
 * @property {[number, number]} coordinates
 * @property {number} triggerRadiusM
 * @property {{url:string, durationSeconds:number|null}|null} audio
 * @property {{url:string}|null} image
 */

/**
 * @typedef {Object} Route
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {"walk"|"bike"|"car"|"transit"} transport
 * @property {number|null} durationMinutes
 * @property {number|null} distanceMeters
 * @property {{url:string}|null} cover
 * @property {{url:string, durationSeconds:number|null}|null} introAudio
 * @property {string[]} pointIds
 */

export const store = new Store({
  loadState: /** @type {"loading"|"loaded"|"error"|"empty"} */ ("loading"),
  loadError: /** @type {string|null} */ (null),
  /** @type {Point[]} */ points: [],
  /** @type {Route[]} */ routes: [],
  /** @type {Map<string,Point>} */ pointsById: new Map(),
  /** @type {Map<string,Route>} */ routesById: new Map(),
  activeRouteId: /** @type {string|null} */ (null),
  routeFilterEnabled: false,
  nearbyEnabled: false,
  distanceMeters: 1000,
  /** @type {{coords:[number,number],accuracy:number}|null} */ userFix: null,
  geoEnabled: false,
  geoDenied: false,
  activePointId: /** @type {string|null} */ (null),
  /** @type {Set<string>} */ playedPointIds: new Set(),
  // Whether a geofence hit may auto-open the point card and start playback.
  // Always starts off and is never persisted across page loads.
  autoplay: false
});
