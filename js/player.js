// @ts-check
/**
 * Single shared HTMLAudioElement used for every clip in the app (point
 * audio, route intros). Exposes a tiny observable state object instead of
 * DOM nodes, so `app.js` renders whatever UI it wants from it.
 */
import { CONFIG } from "./config.js";
import { isSafeAudioUrl } from "./dom.js";

/**
 * @typedef {Object} PlayableMedia
 * @property {string} url
 */

/**
 * @typedef {Object} PlayablePoint
 * @property {string} id
 * @property {string} title
 * @property {PlayableMedia} audio
 * @property {PlayableMedia|null} [image]
 */

/**
 * @typedef {Object} PlayerState
 * @property {string|null} pointId - id of the point/track currently loaded
 * @property {boolean} playing
 * @property {boolean} blockedByAutoplay - true after a play() rejected with NotAllowedError
 * @property {number} currentTime
 * @property {number} duration
 * @property {string|null} queuedNextTitle - title of a queued track, if any
 * @property {boolean} unlocked
 * @property {string|null} endedId - id of the track that just played to its end (cleared by the next play/stop)
 */

/** @type {HTMLAudioElement|null} */
let audioEl = null;
let unlocked = false;
let currentPointId = /** @type {string|null} */ (null);
/** @type {{point: PlayablePoint, contextLabel?: string}|null} */
let queued = null;

/** @type {PlayerState} */
let state = {
  pointId: null,
  playing: false,
  blockedByAutoplay: false,
  currentTime: 0,
  duration: 0,
  queuedNextTitle: null,
  unlocked: false,
  endedId: null
};

/** @type {Set<(state: PlayerState) => void>} */
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(state);
}

/** @param {Partial<PlayerState>} patch */
function setState(patch) {
  state = { ...state, ...patch };
  notify();
}

/**
 * @param {(state: PlayerState) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

/** @returns {PlayerState} */
export function getState() {
  return state;
}

function getAudioEl() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = "none";
    audioEl.addEventListener("timeupdate", () => {
      setState({ currentTime: audioEl.currentTime, duration: audioEl.duration || 0 });
    });
    audioEl.addEventListener("loadedmetadata", () => setState({ duration: audioEl.duration || 0 }));
    audioEl.addEventListener("playing", () => setState({ playing: true, blockedByAutoplay: false }));
    audioEl.addEventListener("pause", () => {
      if (!audioEl.ended) setState({ playing: false });
    });
    audioEl.addEventListener("ended", handleEnded);
    setupMediaSessionHandlers();
  }
  return audioEl;
}

/**
 * Must be called synchronously inside a user gesture (a click handler),
 * before any programmatic play() is attempted later outside a gesture
 * (e.g. from the geofence engine). Plays+pauses a silent clip.
 * @returns {Promise<boolean>} whether the unlock succeeded
 */
export async function unlock() {
  const audio = getAudioEl();
  if (unlocked) return true;
  try {
    audio.src = CONFIG.audio.silentDataUri;
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
    unlocked = true;
    setState({ unlocked: true });
    return true;
  } catch (err) {
    console.warn("audio unlock failed", err);
    return false;
  }
}

/**
 * Play a point (or route intro, addressed via a synthetic point-like id).
 * If something else is already playing, this queues the request instead
 * (queue length 1, newest wins) and resolves once queued.
 * @param {PlayablePoint} point
 * @param {string} [contextLabel] e.g. the route title, for Media Session
 * @returns {Promise<void>}
 */
export async function play(point, contextLabel) {
  const audio = getAudioEl();
  if (state.playing && currentPointId && currentPointId !== point.id) {
    queued = { point, contextLabel };
    setState({ queuedNextTitle: point.title });
    return;
  }

  currentPointId = point.id;
  queued = null;
  const safe = isSafeAudioUrl(point.audio.url);
  if (!safe) console.warn("player: refusing unsafe audio url", point.audio.url);
  audio.src = safe ? point.audio.url : "";
  setState({
    pointId: point.id,
    blockedByAutoplay: false,
    queuedNextTitle: null,
    currentTime: 0,
    duration: 0,
    endedId: null
  });
  updateMediaSessionMetadata(point, contextLabel);
  // An unsafe url is treated as no audio at all — nothing to play.
  if (!safe) return;
  try {
    await audio.play();
  } catch {
    // Never show a "playing" state unless the `playing` event actually fires.
    setState({ blockedByAutoplay: true, playing: false });
  }
}

function handleEnded() {
  setState({ playing: false, currentTime: 0, endedId: currentPointId });
  if (queued) {
    const next = queued;
    queued = null;
    play(next.point, next.contextLabel);
  }
}

export function pause() {
  if (audioEl) audioEl.pause();
}

/** Fully stop playback and clear the "now playing" state (used by the UI's close button). */
export function stop() {
  if (audioEl) {
    audioEl.pause();
    audioEl.removeAttribute("src");
    audioEl.load();
  }
  currentPointId = null;
  queued = null;
  setState({
    pointId: null,
    playing: false,
    blockedByAutoplay: false,
    currentTime: 0,
    duration: 0,
    queuedNextTitle: null,
    endedId: null
  });
}

/** @returns {Promise<void>} */
export async function resume() {
  if (!audioEl) return;
  try {
    await audioEl.play();
  } catch {
    setState({ blockedByAutoplay: true, playing: false });
  }
}

export function togglePlayPause() {
  if (!audioEl) return;
  if (audioEl.paused) resume();
  else pause();
}

/** @param {number} seconds */
export function seekTo(seconds) {
  if (!audioEl) return;
  const max = audioEl.duration || seconds;
  audioEl.currentTime = Math.max(0, Math.min(seconds, max));
}

/** @param {number} deltaSeconds */
export function seekBy(deltaSeconds) {
  if (!audioEl) return;
  seekTo(audioEl.currentTime + deltaSeconds);
}

/** @returns {string|null} */
export function getCurrentPointId() {
  return currentPointId;
}

/** @returns {boolean} */
export function isPlaying() {
  return !!(audioEl && !audioEl.paused && !audioEl.ended);
}

/**
 * @param {PlayablePoint} point
 * @param {string} [contextLabel]
 */
function updateMediaSessionMetadata(point, contextLabel) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: point.title,
    artist: contextLabel ? `Аудиогид · ${contextLabel}` : "Аудиогид",
    artwork: point.image?.url ? [{ src: point.image.url, sizes: "800x500", type: "image/jpeg" }] : []
  });
}

function setupMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => resume());
  navigator.mediaSession.setActionHandler("pause", () => pause());
  navigator.mediaSession.setActionHandler("seekbackward", () => seekBy(-15));
  navigator.mediaSession.setActionHandler("seekforward", () => seekBy(15));
}
