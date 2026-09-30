// @ts-check
/**
 * Pure formatting / progress helpers for the guide UI. No DOM, no state —
 * safe to import from Node.
 */

/** @param {number} n @param {[string, string, string]} forms "точка", "точки", "точек" */
export function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/** @param {number} n */
export function pointsLabel(n) {
  return `${n} ${plural(n, ["точка", "точки", "точек"])}`;
}

/**
 * @param {number|null|undefined} meters
 * @returns {string}
 */
export function formatDistance(meters) {
  if (meters == null || !Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} м`;
  const km = meters / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0).replace(".", ",")} км`;
}

/**
 * @param {number|null|undefined} minutes
 * @returns {string}
 */
export function formatDuration(minutes) {
  if (!minutes || !Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)} мин`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/** @param {number} seconds */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Rough pace per transport, metres per minute. */
const PACE_M_PER_MIN = { walk: 75, bike: 220, car: 450, transit: 250 };

/**
 * @param {number} meters
 * @param {"walk"|"bike"|"car"|"transit"} transport
 * @returns {string}
 */
export function formatEta(meters, transport) {
  const pace = PACE_M_PER_MIN[transport] || PACE_M_PER_MIN.walk;
  const min = Math.max(1, Math.round(meters / pace));
  return `~${min} мин`;
}

/**
 * Initial bearing from a to b, degrees clockwise from north.
 * @param {[number, number]} a [lat, lon]
 * @param {[number, number]} b [lat, lon]
 */
export function bearingDeg(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const f1 = toRad(a[0]);
  const f2 = toRad(b[0]);
  const dl = toRad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const COMPASS = ["на север", "на северо-восток", "на восток", "на юго-восток", "на юг", "на юго-запад", "на запад", "на северо-запад"];

/** @param {number} deg */
export function compassRu(deg) {
  return COMPASS[Math.round(deg / 45) % 8];
}

/**
 * Where the visitor is along a route: which stops exist, which are played,
 * which one is next (first unplayed in route order).
 * @param {string[]} pointIds route order
 * @param {(id: string) => boolean} exists
 * @param {Set<string>} played
 */
export function routeProgress(pointIds, exists, played) {
  const ids = pointIds.filter(exists);
  const playedCount = ids.filter(id => played.has(id)).length;
  const nextId = ids.find(id => !played.has(id)) || null;
  return { ids, playedCount, total: ids.length, nextId, done: ids.length > 0 && !nextId };
}
