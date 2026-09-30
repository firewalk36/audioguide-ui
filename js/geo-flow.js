// @ts-check
/**
 * Map + geolocation flow: Yandex map lifecycle, visible points, the
 * geolocation watch and the geofence that fires Автозвук. State lives in
 * the shared store (js/state.js); screens are reached through `deps`.
 */
import { el, clear, toast, announce } from "./dom.js";
import { haversineMeters, pickTrigger, GeoController, loadPlayedPoints, savePlayedPoints, loadListenedPoints } from "./geo.js";
import * as player from "./player.js";
import { loadYandexMaps, resetYandexMapsLoader, GuideMap } from "./map.js";
import { routeProgress } from "./format.js";
import { store } from "./state.js";
import { openPointSheet } from "./ui/point-sheet.js";
import { updateStatusPill, syncMapModeButtons } from "./ui/settings.js";

/**
 * @typedef {Object} GeoFlowDeps
 * @property {(pointId: string) => void} openPoint
 * @property {(routeId: string) => void} openRoute
 * @property {(name: string) => void} showView
 * @property {(meta: {title: string, sub: string}) => void} setMeta
 */

/** @type {GeoFlowDeps} */
let deps = { openPoint: () => {}, openRoute: () => {}, showView: () => {}, setMeta: () => {} };
/** @type {GuideMap|null} */
let guideMap = null;
/** @type {GeoController|null} */
let geoController = null;
let centerOnNextFix = false;

// Walking-mode framing state (see frameWalk below).
/** Auto-framing is on until the visitor pans/zooms by hand; it comes back
 * when the next stop changes or they tap «Где я?». */
let autoFrame = true;
/** @type {string|null} next stop the current frame was built for */
let framedNextId = null;
/** whether the current frame included the visitor's fix */
let framedWithFix = false;
/** a frame was requested while the map was hidden (mobile tabs) */
let framePending = false;
/** @type {string|null} */
let lastWalkNextId = null;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {GeoFlowDeps} d */
export function initGeoFlow(d) {
  deps = d;
  // Re-frame whenever the walk's next stop changes (a stop triggered, a
  // route started or reset). Runs after this tick so the walk panel has
  // re-rendered and its height can be measured.
  store.subscribe(st => {
    const route = walkingRoute(st);
    const nextId = route ? walkNextId(st, route) : null;
    if (nextId === lastWalkNextId) return;
    lastWalkNextId = nextId;
    if (!route || !nextId) { framedNextId = null; return; }
    autoFrame = true;
    requestAnimationFrame(() => frameWalk());
  });
}

/** @returns {GuideMap|null} */
export function getGuideMap() {
  return guideMap;
}

/** @returns {GeoController|null} */
export function getGeoController() {
  return geoController;
}

// --- Map --------------------------------------------------------------------

export function initMap() {
  $("mapLoading").classList.remove("is-done");
  loadYandexMaps()
    .then(ymaps => {
      guideMap = new GuideMap(ymaps, "map");
      guideMap.onUserMove(() => { if (walkingRoute(store.getState())) autoFrame = false; });
      updateStatusPill("statusMaps", "ok", "Карта: готова");
      $("mapErrorState").hidden = true;
      $("mapLoading").classList.add("is-done");
      refreshMapPoints();
      if (store.getState().userFix) guideMap.setUserLocation(store.getState().userFix.coords, store.getState().userFix.accuracy);
    })
    .catch(() => {
      updateStatusPill("statusMaps", "error", "Карта: ошибка");
      $("mapLoading").classList.add("is-done");
      $("mapErrorState").hidden = false;
    });
}

export function wireMapControls() {
  document.querySelectorAll(".map-ctrl-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const near = /** @type {HTMLElement} */ (btn).dataset.mapMode === "near";
      store.setState({ nearbyEnabled: near });
      /** @type {HTMLInputElement} */ ($("nearbyToggle")).checked = near;
      syncMapModeButtons(near);
      if (near && !store.getState().geoEnabled) enableGeolocation();
      refreshMapPoints();
    });
  });
  $("mapRetryBtn").addEventListener("click", () => {
    resetYandexMapsLoader();
    updateStatusPill("statusMaps", "warn", "Карта: загрузка…");
    $("mapErrorState").hidden = true;
    initMap();
  });
  $("geoEnableBtn").addEventListener("click", () => {
    const s = store.getState();
    const walking = !!walkingRoute(s);
    // «Где я?» while walking hands the view back to auto-framing.
    if (walking) autoFrame = true;
    if (s.geoEnabled && s.userFix && !s.geoDenied) {
      if (walking) frameWalk(); else guideMap?.centerOn(s.userFix.coords);
      return;
    }
    centerOnNextFix = true;
    enableGeolocation();
  });
}

function getVisiblePoints() {
  const s = store.getState();
  const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
  return s.points.filter(pt => {
    const byRoute = !s.routeFilterEnabled || !route || route.pointIds.includes(pt.id);
    const byNearby = !s.nearbyEnabled || !s.userFix || haversineMeters(s.userFix.coords, pt.coordinates) <= s.distanceMeters;
    return byRoute && byNearby;
  });
}

/** @param {string} routeId */
export function fitMapToRoute(routeId) {
  if (!guideMap) return;
  const s = store.getState();
  const route = s.routesById.get(routeId);
  if (!route) return;
  // Walking this route: frame "me + next stop", not the whole route.
  if (walkingRoute(s) === route && walkNextId(s, route)) {
    autoFrame = true;
    requestAnimationFrame(() => frameWalk());
    return;
  }
  const coords = route.pointIds.map(id => s.pointsById.get(id)).filter(Boolean).map(p => p.coordinates);
  if (!coords.length) return;
  // The map container may have just become visible — measure it first,
  // or setBounds zooms out to the whole region.
  guideMap.fitViewport();
  guideMap.fitToRoute(coords, s.userFix ? s.userFix.coords : null);
}

// --- Walking-mode framing ----------------------------------------------------

/** @param {any} s store state */
function walkingRoute(s) {
  return s.activeRouteId && s.routeFilterEnabled ? s.routesById.get(s.activeRouteId) || null : null;
}

/**
 * The stop the visitor walks to next: the first one that hasn't triggered.
 * @param {any} s store state
 * @param {import('./state.js').Route} route
 * @returns {string|null}
 */
function walkNextId(s, route) {
  return routeProgress(route.pointIds, id => s.pointsById.has(id), s.playedPointIds).nextId;
}

function isMapVisible() {
  const node = $("map");
  return node.offsetParent !== null && node.clientHeight > 0 && node.clientWidth > 0;
}

/**
 * The map area our overlays leave free, as [top, right, bottom, left] px
 * margins: below the filter buttons / «Где я?», above whatever covers the
 * bottom of the map (walk panel, mini-player, tab bar), plus 16px air.
 * @returns {[number, number, number, number]}
 */
function walkMargins() {
  const mapRect = $("map").getBoundingClientRect();
  let top = 16;
  for (const sel of [".map-controls", ".locate-btn"]) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r && r.height) top = Math.max(top, r.bottom - mapRect.top + 16);
  }
  let coverTop = mapRect.bottom;
  for (const node of [$("walkPanel"), document.querySelector(".miniplayer.visible"), document.querySelector(".tabbar")]) {
    if (!node || /** @type {HTMLElement} */ (node).hidden) continue;
    const r = node.getBoundingClientRect();
    if (r.height && r.top < mapRect.bottom) coverTop = Math.min(coverTop, r.top);
  }
  let bottom = Math.max(0, mapRect.bottom - coverTop) + 16;
  // Keep markers clear of the Yandex zoom buttons on the right edge.
  let right = 16;
  const zoom = document.querySelector('#map [class*="zoom__plus"]')?.parentElement?.getBoundingClientRect();
  if (zoom && zoom.width) right = Math.max(right, mapRect.right - zoom.left + 8);
  // Never ask for more margin than the map has room for.
  const room = mapRect.height - 96;
  if (top + bottom > room) {
    const k = Math.max(0, room) / (top + bottom);
    top *= k;
    bottom *= k;
  }
  return [Math.round(top), Math.round(right), Math.round(bottom), 16];
}

/**
 * Walking mode: frame the visitor's fix plus the next stop above the walk
 * panel (just the next stop until the first fix). No-op when not walking,
 * after a manual pan/zoom (autoFrame off), or when the route is done.
 */
export function frameWalk() {
  if (!guideMap || !autoFrame) return;
  const s = store.getState();
  const route = walkingRoute(s);
  const nextId = route ? walkNextId(s, route) : null;
  const next = nextId ? s.pointsById.get(nextId) : null;
  if (!next) return;
  if (!isMapVisible()) { framePending = true; return; }
  framePending = false;
  guideMap.fitViewport();
  guideMap.frameWalk(next.coordinates, s.userFix ? s.userFix.coords : null, walkMargins());
  framedNextId = next.id;
  framedWithFix = !!s.userFix;
}

/** The map just became visible (tab switch): catch up on a deferred frame. */
export function onMapShown() {
  guideMap?.fitViewport();
  if (framePending) frameWalk();
}

/** The visitor asked for something else on the map (e.g. a path): hold the frame. */
export function pauseAutoFrame() {
  autoFrame = false;
}

/**
 * On each fix while walking: frame once the first fix arrives, and again
 * whenever the visitor walks out of the free area.
 * @param {[number, number]} coords
 */
function followFix(coords) {
  if (!guideMap || !autoFrame || !walkingRoute(store.getState())) return;
  if (!isMapVisible()) { framePending = true; return; }
  if (!framedWithFix || framedNextId === null || !guideMap.isInSafeArea(coords, walkMargins())) frameWalk();
}

export function refreshMapPoints() {
  if (!guideMap) return;
  const s = store.getState();
  const route = s.routeFilterEnabled && s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
  const prog = route ? routeProgress(route.pointIds, id => s.pointsById.has(id), s.playedPointIds) : null;
  guideMap.renderPoints(getVisiblePoints(), {
    activeRouteOrder: route ? route.pointIds : null,
    onSelect: id => deps.openPoint(id),
    playedIds: s.playedPointIds,
    nextId: prog ? prog.nextId : null
  });
}

// --- Geolocation ------------------------------------------------------------

export async function enableGeolocation() {
  await player.unlock();
  ensureGeoController();
  const s = store.getState();
  if (!s.userFix) centerOnNextFix = true;
  store.setState({
    geoEnabled: true, geoDenied: false,
    playedPointIds: loadPlayedPoints(s.activeRouteId), listenedPointIds: loadListenedPoints(s.activeRouteId)
  });
  geoController.start();
  updateStatusPill("statusGeo", "ok", "Геолокация: включена");
  $("geoEnableBtn").classList.add("is-on");
}

export function ensureGeoController() {
  if (geoController) return;
  geoController = new GeoController({
    onFix: handleGeoFix,
    onError: handleGeoError,
    isAudioPlaying: () => player.isPlaying()
  });
}

/** @param {import('./geo.js').GeoFix} fix */
function handleGeoFix(fix) {
  store.setState({ userFix: fix, geoDenied: false });
  if (guideMap) {
    guideMap.setUserLocation(fix.coords, fix.accuracy);
    if (centerOnNextFix && !store.getState().activeRouteId) guideMap.centerOn(fix.coords);
  }
  centerOnNextFix = false;
  followFix(fix.coords);
  if (store.getState().nearbyEnabled) refreshMapPoints();
  runGeofence(fix);
}

/** @param {import('./geo.js').GeoFix} fix */
function runGeofence(fix) {
  const s = store.getState();
  if (!s.autoplay) return;
  const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
  const candidatePoints = (route ? route.pointIds.map(id => s.pointsById.get(id)).filter(Boolean) : s.points)
    .filter(pt => pt.audio);
  const candidates = candidatePoints.map(pt => ({ id: pt.id, coords: pt.coordinates, triggerRadiusM: pt.triggerRadiusM }));

  const decision = pickTrigger({ activePointId: s.activePointId, playedPointIds: s.playedPointIds }, fix, candidates);

  if (!decision) {
    if (s.activePointId) store.setState({ activePointId: null });
    return;
  }
  if (decision.id === s.activePointId) return;

  const played = new Set(s.playedPointIds);
  played.add(decision.id);
  store.setState({ activePointId: decision.id, playedPointIds: played });
  savePlayedPoints(s.activeRouteId, played);
  refreshMapPoints();

  const point = s.pointsById.get(decision.id);
  if (!point) return;
  openPointSheet(point.id, { auto: true });
  const contextLabel = route ? route.title : undefined;
  deps.setMeta({ title: point.title, sub: contextLabel || "Аудиогид" });
  player.play({ id: point.id, title: point.title, audio: point.audio, image: point.image }, contextLabel);
}

/** @param {"denied"|"unavailable"|"transient"} kind */
function handleGeoError(kind) {
  if (kind === "denied") {
    store.setState({ geoDenied: true });
    updateStatusPill("statusGeo", "error", "Геолокация: доступ запрещён");
    $("geoEnableBtn").classList.remove("is-on");
    showGeoBanner();
    announce("Доступ к геолокации запрещён");
  } else if (kind === "unavailable") {
    toast("Этот браузер не умеет определять местоположение", "error");
  } else {
    toast("Не получается определить местоположение, пробуем ещё…", "error");
  }
}

function showGeoBanner() {
  const banner = $("geoBanner");
  const hide = () => banner.classList.remove("visible");
  const s = store.getState();
  clear(banner);
  banner.append(
    el("strong", {}, "Нет доступа к геолокации"),
    el("p", {}, "Без неё гид не знает, где вы. Рассказы всё равно можно слушать: открывайте точки сами."),
    el("ol", {},
      el("li", {}, "Нажмите на значок замка или «Аа» в адресной строке."),
      el("li", {}, "Откройте «Геолокация» или «Настройки сайта» → «Разрешить»."),
      el("li", {}, "Вернитесь сюда и нажмите «Попробовать снова».")
    ),
    el("div", { class: "banner-actions" },
      el("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => { hide(); retryGeolocation(); } }, "Попробовать снова"),
      el("button", {
        class: "btn btn-outline btn-sm", type: "button",
        onclick: () => { hide(); if (s.activeRouteId) deps.openRoute(s.activeRouteId); else deps.showView("routes"); }
      }, "Точки списком"),
      el("button", { class: "btn btn-quiet", type: "button", onclick: hide }, "Скрыть")
    )
  );
  banner.classList.add("visible");
}

function retryGeolocation() {
  if (geoController) geoController.stop();
  enableGeolocation();
}
