// @ts-check
/**
 * Fetches the published guide bundle from the backend, with If-None-Match
 * / ETag caching in sessionStorage. In `?demo=1` mode, loads the bundled
 * sample instead of calling the network.
 */
import { CONFIG } from "./config.js";

/**
 * @typedef {"network"|"http"|"parse"} ApiErrorKind
 */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {ApiErrorKind} kind
   * @param {number} [status]
   */
  constructor(message, kind, status) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * @typedef {Object} MediaRef
 * @property {string} id
 * @property {string} url
 * @property {"image"|"audio"} resource_type
 * @property {string} format
 * @property {number|null} duration_seconds
 */

/**
 * @typedef {Object} RouteDto
 * @property {string} id
 * @property {string} title
 * @property {string|null} description
 * @property {"walk"|"bike"|"car"|"transit"} transport
 * @property {number} duration_minutes
 * @property {number} distance_meters
 * @property {MediaRef|null} cover
 * @property {MediaRef|null} intro_audio
 * @property {string[]} point_ids
 */

/**
 * @typedef {Object} PointDto
 * @property {string} id
 * @property {string} title
 * @property {string|null} short_description
 * @property {string|null} description
 * @property {number} lat
 * @property {number} lon
 * @property {number} trigger_radius_m
 * @property {MediaRef|null} audio
 * @property {MediaRef|null} image
 */

/**
 * @typedef {Object} GuideBundle
 * @property {string} generated_at
 * @property {RouteDto[]} routes
 * @property {PointDto[]} points
 */

const ETAG_KEY = "ag_guide_etag";
const CACHE_KEY = "ag_guide_cache";

function isDemoMode() {
  try {
    return new URLSearchParams(window.location.search).get("demo") === "1";
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<GuideBundle>}
 */
export async function fetchGuide() {
  if (isDemoMode()) return fetchDemoGuide();

  const url = `${CONFIG.apiBase}/public/guide`;
  /** @type {Record<string,string>} */
  const headers = {};
  const cachedEtag = safeSessionGet(ETAG_KEY);
  if (cachedEtag) headers["If-None-Match"] = cachedEtag;

  const res = await safeFetch(url, { headers });

  if (res.status === 304) {
    const cached = readCache();
    if (cached) return cached;
    return parseAndCache(await safeFetch(url));
  }

  if (!res.ok) {
    throw new ApiError(`Сервер вернул ошибку ${res.status}`, "http", res.status);
  }

  return parseAndCache(res);
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function safeFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError("Не удалось связаться с сервером", "network");
  }
}

/**
 * @param {Response} res
 * @returns {Promise<GuideBundle>}
 */
async function parseAndCache(res) {
  if (!res.ok) throw new ApiError(`Сервер вернул ошибку ${res.status}`, "http", res.status);
  /** @type {GuideBundle} */
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError("Некорректный ответ сервера", "parse");
  }
  const etag = res.headers.get("ETag");
  if (etag) safeSessionSet(ETAG_KEY, etag);
  safeSessionSet(CACHE_KEY, JSON.stringify(data));
  return data;
}

/** @returns {GuideBundle|null} */
function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** @param {string} key @returns {string|null} */
function safeSessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** @param {string} key @param {string} value */
function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable; caching is best-effort */
  }
}

/** @returns {Promise<GuideBundle>} */
async function fetchDemoGuide() {
  const res = await safeFetch("dev/guide.sample.json");
  if (!res.ok) throw new ApiError(`Демо-файл не найден (${res.status})`, "http", res.status);
  try {
    return await res.json();
  } catch {
    throw new ApiError("Некорректный демо-файл", "parse");
  }
}
