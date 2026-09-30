// @ts-check
/**
 * Map + geolocation flow: Yandex map lifecycle, visible points, the
 * geolocation watch and the geofence that fires Автозвук. State lives in
 * the shared store (js/state.js); screens are reached through `deps`.
 */
import { el, clear, toast, announce } from "./dom.js";
import { haversineMeters, pickTrigger, GeoController, loadPlayedPoints, savePlayedPoints } from "./geo.js";
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

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {GeoFlowDeps} d */
export function initGeoFlow(d) {
  deps = d;
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
    if (s.geoEnabled && s.userFix && !s.geoDenied) { guideMap?.centerOn(s.userFix.coords); return; }
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
  const coords = route.pointIds.map(id => s.pointsById.get(id)).filter(Boolean).map(p => p.coordinates);
  if (!coords.length) return;
  // The map container may have just become visible — measure it first,
  // or setBounds zooms out to the whole region.
  guideMap.fitViewport();
  guideMap.fitToRoute(coords, s.userFix ? s.userFix.coords : null);
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
  store.setState({ geoEnabled: true, geoDenied: false, playedPointIds: loadPlayedPoints(s.activeRouteId) });
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
