// @ts-check
/**
 * Geolocation watch lifecycle + geofence engine.
 *
 * The pure functions (`haversineMeters`, `pickTrigger`) and the storage
 * helpers never touch `window`/`document` at import time — only inside
 * function bodies — so this module can be imported under plain Node for
 * testing (see tests/geo.test.html).
 */
import { CONFIG } from "./config.js";

/**
 * @typedef {Object} GeoFix
 * @property {[number, number]} coords - [lat, lon]
 * @property {number} accuracy - metres
 * @property {number} [timestamp]
 */

/**
 * @typedef {Object} TriggerCandidate
 * @property {string} id
 * @property {[number, number]} coords
 * @property {number} triggerRadiusM
 */

/**
 * @typedef {Object} PickTriggerState
 * @property {string|null} activePointId
 * @property {Set<string>} playedPointIds
 */

/**
 * Great-circle distance between two [lat, lon] points, in metres.
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number}
 */
export function haversineMeters(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/**
 * Decide which point (if any) should become/stay the "active" trigger for
 * a given fix. Pure: no I/O, no mutation of its arguments.
 *
 * - Fixes less accurate than CONFIG.geo.maxAccuracyM never trigger anything.
 * - The currently active point (if still present in `candidates`) keeps
 *   playing until the user moves past `triggerRadiusM * hysteresisFactor +
 *   hysteresisExtraM`.
 * - Otherwise, the nearest not-yet-played candidate within its own
 *   trigger radius wins.
 *
 * @param {PickTriggerState} state
 * @param {GeoFix} fix
 * @param {TriggerCandidate[]} candidates
 * @returns {TriggerCandidate|null}
 */
export function pickTrigger(state, fix, candidates) {
  if (fix.accuracy > CONFIG.geo.maxAccuracyM) return null;

  if (state.activePointId) {
    const active = candidates.find(c => c.id === state.activePointId);
    if (active) {
      const dist = haversineMeters(fix.coords, active.coords);
      const releaseDist =
        active.triggerRadiusM * CONFIG.geo.hysteresisFactor + CONFIG.geo.hysteresisExtraM;
      if (dist <= releaseDist) return active;
    }
  }

  let best = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    if (state.playedPointIds.has(candidate.id)) continue;
    const dist = haversineMeters(fix.coords, candidate.coords);
    if (dist <= candidate.triggerRadiusM && dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

// --- localStorage persistence for played points -----------------------

/** @param {string|null} routeId @returns {string} */
function playedStorageKey(routeId) {
  return `ag_played_${routeId || "free"}`;
}

/**
 * @param {string|null} routeId
 * @returns {Set<string>}
 */
export function loadPlayedPoints(routeId) {
  try {
    const raw = localStorage.getItem(playedStorageKey(routeId));
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/**
 * @param {string|null} routeId
 * @param {Set<string>} playedPointIds
 */
export function savePlayedPoints(routeId, playedPointIds) {
  try {
    localStorage.setItem(playedStorageKey(routeId), JSON.stringify([...playedPointIds]));
  } catch {
    /* storage unavailable (private mode, quota); non-fatal */
  }
}

/** @param {string|null} routeId */
export function resetPlayedPoints(routeId) {
  try {
    localStorage.removeItem(playedStorageKey(routeId));
  } catch {
    /* ignore */
  }
}

// --- Browser watch lifecycle --------------------------------------------

/**
 * Wraps navigator.geolocation.watchPosition with the lifecycle rules from
 * the spec: never auto-starts, stops on pagehide, and while the tab is
 * hidden keeps watching only if audio is currently playing.
 */
export class GeoController {
  /**
   * @param {Object} opts
   * @param {(fix: GeoFix) => void} opts.onFix
   * @param {(kind: "denied"|"unavailable"|"transient") => void} opts.onError
   * @param {() => boolean} opts.isAudioPlaying
   */
  constructor({ onFix, onError, isAudioPlaying }) {
    this._onFix = onFix;
    this._onError = onError;
    this._isAudioPlaying = isAudioPlaying;
    /** @type {number|null} */
    this.watchId = null;
    this._onVisibility = this._handleVisibility.bind(this);
    this._onPageHide = this.stop.bind(this);
  }

  get isActive() {
    return this.watchId != null;
  }

  start() {
    if (this.watchId != null) return;
    if (!("geolocation" in navigator)) {
      this._onError("unavailable");
      return;
    }
    this._beginWatch();
    document.addEventListener("visibilitychange", this._onVisibility);
    window.addEventListener("pagehide", this._onPageHide);
  }

  stop() {
    this._endWatch();
    document.removeEventListener("visibilitychange", this._onVisibility);
    window.removeEventListener("pagehide", this._onPageHide);
  }

  _beginWatch() {
    if (this.watchId != null) return;
    this.watchId = navigator.geolocation.watchPosition(
      pos => this._onFix({
        coords: [pos.coords.latitude, pos.coords.longitude],
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp
      }),
      err => this._handlePositionError(err),
      CONFIG.geo.watchOptions
    );
  }

  _endWatch() {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  /** @param {GeolocationPositionError} err */
  _handlePositionError(err) {
    if (err.code === 1) this._onError("denied");
    else this._onError("transient");
  }

  _handleVisibility() {
    if (document.hidden) {
      if (!this._isAudioPlaying()) this._endWatch();
    } else {
      this._beginWatch();
    }
  }
}
