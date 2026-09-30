// @ts-check
/**
 * Wiring: navigation, data, map, geolocation + geofence, Автозвук, filters.
 * Screens live in js/ui/*; this file owns state and the actions they call.
 */
import { fetchGuide, ApiError } from "./api.js";
import { el, clear, toast, announce } from "./dom.js";
import { store } from "./state.js";
import { loadPlayedPoints, savePlayedPoints, resetPlayedPoints, loadListenedPoints, saveListenedPoints, resetListenedPoints, LISTENED_RATIO } from "./geo.js";
import * as player from "./player.js";
import { isRouteApiUnavailable, buildExternalRouteUrl } from "./map.js";
import { initGeoFlow, getGuideMap, getGeoController, initMap, wireMapControls, fitMapToRoute, refreshMapPoints, enableGeolocation, ensureGeoController, onMapShown, pauseAutoFrame } from "./geo-flow.js";
import { pushLayer, popLayer, isLayerOpen } from "./ui/layers.js";
import { wireRoutesView, renderRouteList, renderRouteDetail } from "./ui/routes-view.js";
import { wirePointSheet, openPointSheet, closePointSheet } from "./ui/point-sheet.js";
import { wireWalkPanel, renderWalkPanel } from "./ui/walk-panel.js";
import { wirePlayerUI } from "./ui/player-ui.js";
import { wireOnboarding, shouldShowOnboarding, showOnboarding } from "./ui/onboarding.js";
import { wireSettings, renderRouteChips, syncAutoplayControls, updateStatusPill } from "./ui/settings.js";

/** @typedef {import('./api.js').GuideBundle} GuideBundle */
/** @typedef {import('./state.js').Point} Point */

/** @type {{title:string, sub:string}|null} */
let lastPlayableMeta = null;
/** @type {string|null} */
let openRouteId = null;
let routeReturnView = "routes";
let currentView = "routes";

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const desktop = window.matchMedia("(min-width: 960px)");

document.addEventListener("DOMContentLoaded", boot);

function boot() {
  initGeoFlow({ openPoint, openRoute, showView, setMeta: meta => { lastPlayableMeta = meta; } });
  wireTabs();
  wireRoutesView({ store, openRoute, openPoint, retryLoad, resumeRoute: () => showView("map") });
  wireRouteDetail();
  wirePointSheet({ store, playPoint, routeToPoint, centerOn: c => getGuideMap()?.centerOn(c) });
  wireWalkPanel({
    store, openPoint, routeToPoint, endRoute, toggleAutoplay, enableGeolocation,
    showRoutes: () => showView("routes")
  });
  wirePlayerUI(() => lastPlayableMeta, () => getGuideMap()?.fitViewport());
  wireSettings({ store, refreshMapPoints, fitMapToRoute, enableGeolocation, toggleAutoplay, setAutoplayState, clearRoute: () => getGuideMap()?.clearRoute(), showMap: () => showView("map"), showIntro: showOnboarding });
  wireOnboarding({ onRoutes: () => showView("routes"), onMap: () => showView("map") });
  wireMapControls();
  wireAutoplayToggle();
  player.subscribe(() => { if (openRouteId) renderRouteDetail(openRouteId); });
  player.subscribe(trackListened);
  store.subscribe(() => renderWalkPanel());
  let listSignature = "";
  store.subscribe(st => {
    const sig = [st.loadState, st.activeRouteId, st.routeFilterEnabled, st.playedPointIds.size, st.listenedPointIds.size, st.routes.length, st.geoEnabled].join("|");
    if (sig === listSignature) return;
    listSignature = sig;
    renderRouteList();
    if (openRouteId) renderRouteDetail(openRouteId);
  });
  loadData();
  initMap();
  if (shouldShowOnboarding()) showOnboarding();
}

// --- Navigation -----------------------------------------------------------

function wireTabs() {
  document.querySelectorAll("[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = /** @type {HTMLElement} */ (btn).dataset.tab;
      if (openRouteId) popLayer("route");
      showView(tab);
    });
  });
  desktop.addEventListener("change", () => { showView(currentView); getGuideMap()?.fitViewport(); });
}

/**
 * Show one of: routes | route | settings | map. On desktop the map is
 * always visible on the right, so "map" keeps the current left pane.
 * @param {string} name
 */
function showView(name) {
  const paneView = desktop.matches && name === "map" ? (currentView === "map" ? "routes" : currentView) : name;
  currentView = desktop.matches && name === "map" ? paneView : name;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const view = $("view" + paneView.charAt(0).toUpperCase() + paneView.slice(1));
  if (view) view.classList.add("active");
  const tabName = paneView === "route" ? "routes" : name === "map" && !desktop.matches ? "map" : paneView;
  document.querySelectorAll("[data-tab]").forEach(b => {
    const on = /** @type {HTMLElement} */ (b).dataset.tab === tabName;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  if (name === "map" || desktop.matches) requestAnimationFrame(() => onMapShown());
  if (!desktop.matches) window.scrollTo({ top: 0 });
}

// --- Data -----------------------------------------------------------------

async function loadData() {
  try {
    const bundle = await fetchGuide();
    const { points, routes } = normalizeBundle(bundle);
    store.setState({
      points, routes,
      pointsById: new Map(points.map(p => [p.id, p])),
      routesById: new Map(routes.map(r => [r.id, r])),
      loadState: points.length === 0 && routes.length === 0 ? "empty" : "loaded",
      loadError: null
    });
    updateStatusPill("statusData", "ok", `Данные: ${routes.length} маршр., ${points.length} точек`);
    $("mapNotice").hidden = true;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "Не удалось загрузить данные";
    store.setState({ loadState: "error", loadError: message });
    updateStatusPill("statusData", "error", "Данные: ошибка");
    showDataNotice(message);
    toast(message, "error");
  }
  renderRouteList();
  renderRouteChips();
  refreshMapPoints();
}

function retryLoad() {
  store.setState({ loadState: "loading" });
  updateStatusPill("statusData", "warn", "Данные: загрузка…");
  loadData();
}

/** @param {string} message */
function showDataNotice(message) {
  const notice = $("mapNotice");
  clear(notice);
  notice.append(
    el("p", {}, el("strong", {}, "Точки не загрузились. "), message),
    el("button", { class: "btn btn-outline btn-sm", type: "button", onclick: retryLoad }, "Повторить")
  );
  notice.hidden = false;
}

/** @param {GuideBundle} bundle */
function normalizeBundle(bundle) {
  const points = (bundle.points || [])
    .map(p => ({
      id: p.id,
      title: p.title || "Точка",
      shortDescription: p.short_description || "",
      description: p.description || "",
      coordinates: /** @type {[number,number]} */ ([Number(p.lat), Number(p.lon)]),
      triggerRadiusM: typeof p.trigger_radius_m === "number" && p.trigger_radius_m > 0 ? p.trigger_radius_m : 50,
      audio: p.audio && p.audio.resource_type === "audio" ? { url: p.audio.url, durationSeconds: p.audio.duration_seconds ?? null } : null,
      image: p.image && p.image.resource_type === "image" ? { url: p.image.url } : null
    }))
    .filter(p => Number.isFinite(p.coordinates[0]) && Number.isFinite(p.coordinates[1]));

  const routes = (bundle.routes || []).map(r => ({
    id: r.id,
    title: r.title || "Маршрут",
    description: r.description || "",
    transport: /** @type {"walk"|"bike"|"car"|"transit"} */ (
      ["walk", "bike", "car", "transit"].includes(r.transport) ? r.transport : "walk"
    ),
    durationMinutes: r.duration_minutes ?? null,
    distanceMeters: r.distance_meters ?? null,
    cover: r.cover && r.cover.resource_type === "image" ? { url: r.cover.url } : null,
    introAudio: r.intro_audio && r.intro_audio.resource_type === "audio"
      ? { url: r.intro_audio.url, durationSeconds: r.intro_audio.duration_seconds ?? null } : null,
    pointIds: Array.isArray(r.point_ids) ? r.point_ids : []
  }));

  return { points, routes };
}

// --- Route page -----------------------------------------------------------

function wireRouteDetail() {
  $("closeRouteModalBtn").addEventListener("click", closeRoute);
  $("startRouteBtn").addEventListener("click", async () => {
    const routeId = openRouteId;
    if (!routeId) return;
    const s = store.getState();
    if (s.activeRouteId === routeId && s.routeFilterEnabled) {
      routeReturnView = "map";
      closeRoute();
      fitMapToRoute(routeId);
      return;
    }
    // unlock() plays a silent clip — it must run inside this click.
    await player.unlock();
    ensureGeoController();
    store.setState({
      activeRouteId: routeId, routeFilterEnabled: true, activePointId: null,
      geoEnabled: true, geoDenied: false, playedPointIds: loadPlayedPoints(routeId),
      listenedPointIds: loadListenedPoints(routeId)
    });
    getGeoController().start();
    updateStatusPill("statusGeo", "ok", "Геолокация: включена");
    $("geoEnableBtn").classList.add("is-on");
    setAutoplayState(true);
    /** @type {HTMLInputElement} */ ($("routeToggle")).checked = true;
    renderRouteChips();
    refreshMapPoints();
    routeReturnView = "map";
    closeRoute();
    fitMapToRoute(routeId);
    renderRouteList();
  });

  $("resetPlayedBtn").addEventListener("click", () => {
    if (!openRouteId) return;
    // Clears both sets: "triggered" (geofence memory) and "listened" (UI marks).
    resetPlayedPoints(openRouteId);
    resetListenedPoints(openRouteId);
    if (store.getState().activeRouteId === openRouteId) {
      store.setState({ playedPointIds: new Set(), listenedPointIds: new Set(), activePointId: null });
      refreshMapPoints();
    }
    renderRouteDetail(openRouteId);
    renderRouteList();
    toast("Прослушанное сброшено", "success");
  });

  $("routeModalIntroBtn").addEventListener("click", () => {
    const route = openRouteId && store.getState().routesById.get(openRouteId);
    if (!route || !route.introAudio) return;
    const p = player.getState();
    if (p.pointId === `intro:${route.id}`) {
      if (p.blockedByAutoplay) player.resume(); else player.togglePlayPause();
      return;
    }
    lastPlayableMeta = { title: "Вступление", sub: route.title };
    player.play({ id: `intro:${route.id}`, title: "Вступление", audio: route.introAudio, image: route.cover }, route.title);
  });
}

/** @param {string} routeId */
function openRoute(routeId) {
  if (!store.getState().routesById.has(routeId)) return;
  openRouteId = routeId;
  routeReturnView = desktop.matches || currentView !== "map" ? "routes" : "map";
  renderRouteDetail(routeId);
  showView("route");
  pushLayer("route", hideRoute);
  $("closeRouteModalBtn").focus();
  if (desktop.matches) fitMapToRoute(routeId);
}

function hideRoute() {
  if (!openRouteId) return;
  openRouteId = null;
  // On desktop the map is always visible, so the left pane goes back to the list.
  showView(desktop.matches ? "routes" : routeReturnView);
  routeReturnView = "routes";
}

function closeRoute() {
  popLayer("route");
  hideRoute();
}

// --- Автозвук ---------------------------------------------------------------

function wireAutoplayToggle() {
  $("autoplayToggleBtn").addEventListener("click", toggleAutoplay);
}

async function toggleAutoplay() {
  if (store.getState().autoplay) {
    setAutoplayState(false);
    return;
  }
  // unlock() must run synchronously inside this gesture, before any await.
  await player.unlock();
  if (!store.getState().geoEnabled) await enableGeolocation();
  setAutoplayState(true);
}

/** @param {boolean} enabled */
function setAutoplayState(enabled) {
  store.setState({ autoplay: enabled });
  syncAutoplayControls(enabled);
  announce(enabled ? "Автозвук включён" : "Автозвук выключен");
}

// --- Actions shared by the screens --------------------------------------------

/** @param {string} pointId */
function openPoint(pointId) {
  openPointSheet(pointId);
}

/** @param {Point} point */
function playPoint(point) {
  const s = store.getState();
  const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
  const contextLabel = route ? route.title : undefined;
  lastPlayableMeta = { title: point.title, sub: contextLabel || "Аудиогид" };
  player.play({ id: point.id, title: point.title, audio: point.audio, image: point.image }, contextLabel);
  if (!s.playedPointIds.has(point.id)) {
    const played = new Set(s.playedPointIds);
    played.add(point.id);
    store.setState({ playedPointIds: played });
    savePlayedPoints(s.activeRouteId, played);
    refreshMapPoints();
    if (openRouteId) renderRouteDetail(openRouteId);
  }
}

/**
 * Mark a point as *listened* once its story reached LISTENED_RATIO of its
 * length or ended. Only this set drives the «Прослушано» marks; the
 * geofence's playedPointIds (= triggered) is untouched here.
 * @param {import('./player.js').PlayerState} p
 */
function trackListened(p) {
  const id = p.endedId || p.pointId;
  if (!id || id.startsWith("intro:")) return;
  const reached = p.endedId === id
    || (p.pointId === id && Number.isFinite(p.duration) && p.duration > 0 && p.currentTime / p.duration >= LISTENED_RATIO);
  if (!reached) return;
  const s = store.getState();
  if (s.listenedPointIds.has(id) || !s.pointsById.has(id)) return;
  const listened = new Set(s.listenedPointIds);
  listened.add(id);
  store.setState({ listenedPointIds: listened });
  saveListenedPoints(s.activeRouteId, listened);
}

/** @param {string} pointId */
async function routeToPoint(pointId) {
  const s = store.getState();
  const point = s.pointsById.get(pointId);
  if (!point) return;
  const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
  const transport = route ? route.transport : "walk";

  if (!isRouteApiUnavailable()) {
    if (!s.userFix) { await enableGeolocation(); toast("Определяем, где вы… Нажмите ещё раз через пару секунд."); return; }
    const guideMap = getGuideMap();
    if (guideMap) {
      try {
        await guideMap.routeTo(s.userFix.coords, point.coordinates, transport);
        pauseAutoFrame(); // the path is what the visitor asked to see now
        if (isLayerOpen("point")) closePointSheet();
        showView("map");
        return;
      } catch {
        // ymaps.route failed (the key doesn't include routing) — fall back
        // to an external Yandex Maps link below.
      }
    }
  }
  openExternalRoute(s.userFix ? s.userFix.coords : null, point.coordinates, transport);
  if (isLayerOpen("point")) closePointSheet();
}

/**
 * @param {[number,number]|null} from
 * @param {[number,number]} to
 * @param {"walk"|"bike"|"car"|"transit"} transport
 */
function openExternalRoute(from, to, transport) {
  const url = buildExternalRouteUrl(from, to, transport);
  if (!url) { toast("Не удалось построить путь", "error"); return; }
  window.open(url, "_blank", "noopener");
  toast("Путь откроется в Яндекс Картах");
}

function endRoute() {
  /** @type {HTMLInputElement} */ ($("routeToggle")).checked = false;
  store.setState({ routeFilterEnabled: false, activeRouteId: null, activePointId: null, playedPointIds: loadPlayedPoints(null), listenedPointIds: loadListenedPoints(null) });
  getGuideMap()?.clearRoute();
  renderRouteChips();
  refreshMapPoints();
  renderRouteList();
  toast("Маршрут завершён");
}
