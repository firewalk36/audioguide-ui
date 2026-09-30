// @ts-check
/**
 * Wiring: tabs, route list, route modal, point card, filters, map, geo,
 * player. Everything else lives in the other modules; this file only
 * connects them to the DOM.
 */
import { CONFIG } from "./config.js";
import { fetchGuide, ApiError } from "./api.js";
import { el, clear, toast, announce, escapeHtml, isSafeImageUrl, setSafeBackgroundImage } from "./dom.js";
import { Store } from "./store.js";
import { haversineMeters, pickTrigger, GeoController, loadPlayedPoints, savePlayedPoints, resetPlayedPoints } from "./geo.js";
import * as player from "./player.js";
import { loadYandexMaps, resetYandexMapsLoader, GuideMap, isRouteApiUnavailable, buildExternalRouteUrl } from "./map.js";

const TRANSPORT_LABELS = { walk: "Пеший", bike: "Вело / самокат", car: "Авто", transit: "Общественный транспорт" };
const COVER_CLASSES = { walk: "cover-walk", bike: "cover-bike", car: "cover-car", transit: "cover-transit" };

/** @typedef {import('./api.js').GuideBundle} GuideBundle */

/**
 * @typedef {Object} Point
 * @property {string} id
 * @property {string} title
 * @property {string} shortDescription
 * @property {string} description
 * @property {[number, number]} coordinates
 * @property {number} triggerRadiusM
 * @property {{url:string}|null} audio
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
 * @property {{url:string}|null} introAudio
 * @property {string[]} pointIds
 */

const store = new Store({
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
  activePointId: /** @type {string|null} */ (null),
  /** @type {Set<string>} */ playedPointIds: new Set(),
  // Whether a geofence hit is allowed to auto-open the point modal and start
  // playback. Always starts off and is never persisted across page loads —
  // geolocation can be on (map/nearby) without audio auto-starting.
  autoplay: false
});

/** @type {GuideMap|null} */
let guideMap = null;
/** @type {GeoController|null} */
let geoController = null;
/** @type {{title:string, sub:string}|null} */
let lastPlayableMeta = null;

document.addEventListener("DOMContentLoaded", boot);

function boot() {
  wireTabs();
  wireFilters();
  wireRouteModal();
  wirePointModal();
  wirePlayer();
  wireMapControls();
  wireScrollTop();
  wireAutoplayToggle();
  player.subscribe(renderPlayer);
  loadData();
  initMap();
}

// --- Tabs ---------------------------------------------------------------

function wireTabs() {
  document.querySelectorAll("[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => switchTab(/** @type {HTMLElement} */(btn).dataset.tab));
  });
}

/** @param {string} tabId */
function switchTab(tabId) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll("[data-tab]").forEach(b => {
    const isActive = /** @type {HTMLElement} */ (b).dataset.tab === tabId;
    b.classList.toggle("active", isActive);
    if (isActive) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const view = document.getElementById("view" + tabId.charAt(0).toUpperCase() + tabId.slice(1));
  if (view) view.classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function wireScrollTop() {
  const btn = /** @type {HTMLElement} */ (document.getElementById("scrollTopBtn"));
  window.addEventListener("scroll", () => btn.classList.toggle("visible", window.scrollY > 300), { passive: true });
  btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}

// --- Data loading ---------------------------------------------------------

async function loadData() {
  try {
    const bundle = await fetchGuide();
    const { points, routes } = normalizeBundle(bundle);
    const pointsById = new Map(points.map(p => [p.id, p]));
    const routesById = new Map(routes.map(r => [r.id, r]));
    store.setState({
      points, routes, pointsById, routesById,
      loadState: points.length === 0 && routes.length === 0 ? "empty" : "loaded"
    });
    updateStatusPill("statusData", "ok", `Данные: ${routes.length} маршр., ${points.length} точек`);
    renderRoutes();
    renderRouteChips();
    refreshMapPoints();
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "Не удалось загрузить данные";
    store.setState({ loadState: "error", loadError: message });
    updateStatusPill("statusData", "error", "Данные: ошибка");
    renderRoutes();
    toast(message, "error");
  }
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
      audio: p.audio && p.audio.resource_type === "audio" ? { url: p.audio.url } : null,
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
    introAudio: r.intro_audio && r.intro_audio.resource_type === "audio" ? { url: r.intro_audio.url, title: r.title } : null,
    pointIds: Array.isArray(r.point_ids) ? r.point_ids : []
  }));

  return { points, routes };
}

/** @param {string} id @param {"ok"|"warn"|"error"} state @param {string} text */
function updateStatusPill(id, state, text) {
  const node = document.getElementById(id);
  if (!node) return;
  node.dataset.state = state;
  clear(node);
  node.appendChild(el("span", { class: "dot" }));
  node.appendChild(document.createTextNode(text));
}

// --- Routes view ----------------------------------------------------------

function renderRoutes() {
  const grid = /** @type {HTMLElement} */ (document.getElementById("routeGrid"));
  const s = store.getState();
  clear(grid);

  if (s.loadState === "error") {
    grid.appendChild(buildMessageState({
      title: "Не удалось загрузить маршруты",
      text: s.loadError || "Проверьте подключение и попробуйте снова.",
      actionLabel: "Повторить",
      onAction: () => { store.setState({ loadState: "loading" }); loadData(); }
    }));
    return;
  }
  if (s.loadState === "empty" || (s.loadState === "loaded" && s.routes.length === 0)) {
    grid.appendChild(buildMessageState({
      title: "Пока нет маршрутов",
      text: "Маршруты появятся здесь после публикации."
    }));
    return;
  }
  if (s.loadState === "loading") return; // keep skeletons from index.html

  for (const route of s.routes) {
    grid.appendChild(buildRouteCard(route));
  }
}

/** @param {{title:string, text:string, actionLabel?:string, onAction?:()=>void}} opts */
function buildMessageState({ title, text, actionLabel, onAction }) {
  return el("div", { class: "empty-state" },
    el("div", { class: "empty-icon" }, buildIcon("circle")),
    el("h3", {}, title),
    el("p", {}, text),
    actionLabel ? el("button", { class: "btn btn-primary", type: "button", onclick: onAction }, actionLabel) : null
  );
}

function buildIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "9");
  svg.appendChild(circle);
  return svg;
}

/** @param {Route} route */
function buildRouteCard(route) {
  const cover = el("div", { class: `route-cover ${COVER_CLASSES[route.transport]}` },
    el("div", { class: "route-cover-badge" }, TRANSPORT_LABELS[route.transport])
  );
  if (route.cover) setSafeBackgroundImage(cover, route.cover.url);
  const durationText = route.durationMinutes ? `${route.durationMinutes} мин` : "—";
  const distanceText = route.distanceMeters ? `${(route.distanceMeters / 1000).toFixed(1)} км` : "—";
  const card = el("button", { class: "route-card", type: "button" },
    cover,
    el("div", { class: "route-body" },
      el("h3", {}, route.title),
      el("p", { class: "desc" }, route.description),
      el("div", { class: "route-meta" },
        el("span", { class: "route-tag" }, durationText),
        el("span", { class: "route-tag" }, distanceText)
      )
    )
  );
  card.addEventListener("click", () => openRouteModal(route.id));
  return card;
}

document.getElementById("routeSearch")?.addEventListener("input", e => {
  const q = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase();
  document.querySelectorAll(".route-card").forEach(card => {
    /** @type {HTMLElement} */ (card).style.display = card.textContent.toLowerCase().includes(q) ? "" : "none";
  });
});

// --- Filters view -----------------------------------------------------

function wireFilters() {
  const nearbyToggle = /** @type {HTMLInputElement} */ (document.getElementById("nearbyToggle"));
  const distanceRange = /** @type {HTMLInputElement} */ (document.getElementById("distanceRange"));
  const routeToggle = /** @type {HTMLInputElement} */ (document.getElementById("routeToggle"));

  nearbyToggle.addEventListener("change", () => {
    store.setState({ nearbyEnabled: nearbyToggle.checked });
    if (nearbyToggle.checked && !store.getState().geoEnabled) enableGeolocation();
    refreshMapPoints();
  });
  distanceRange.addEventListener("input", () => {
    const v = Number(distanceRange.value);
    store.setState({ distanceMeters: v });
    document.getElementById("distanceValue").textContent = v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} км` : `${v} м`;
    if (store.getState().nearbyEnabled) refreshMapPoints();
  });
  routeToggle.addEventListener("change", () => {
    if (!routeToggle.checked) {
      store.setState({ routeFilterEnabled: false, activeRouteId: null, activePointId: null, playedPointIds: loadPlayedPoints(null) });
    } else {
      store.setState({ routeFilterEnabled: true });
    }
    renderRouteChips();
    refreshMapPoints();
  });
  document.getElementById("applyFiltersBtn").addEventListener("click", () => { refreshMapPoints(); switchTab("map"); });
  document.getElementById("resetFiltersBtn").addEventListener("click", () => {
    nearbyToggle.checked = false; routeToggle.checked = false;
    store.setState({
      nearbyEnabled: false, routeFilterEnabled: false, activeRouteId: null,
      activePointId: null, playedPointIds: loadPlayedPoints(null)
    });
    renderRouteChips();
    refreshMapPoints();
    if (guideMap) guideMap.clearRoute();
  });
}

function renderRouteChips() {
  const container = /** @type {HTMLElement} */ (document.getElementById("routeChips"));
  const s = store.getState();
  clear(container);
  if (!s.routes.length) {
    container.appendChild(el("span", { style: "font-size:var(--text-xs);color:var(--color-text-faint)" }, "Маршруты загружаются…"));
    return;
  }
  for (const route of s.routes) {
    const chip = el("button", {
      class: `chip ${route.id === s.activeRouteId ? "active" : ""}`,
      type: "button",
      disabled: !s.routeFilterEnabled
    }, route.title);
    chip.addEventListener("click", () => {
      const cur = store.getState();
      const nextId = cur.activeRouteId === route.id ? null : route.id;
      store.setState({ activeRouteId: nextId, activePointId: null, playedPointIds: loadPlayedPoints(nextId) });
      renderRouteChips();
      refreshMapPoints();
      if (nextId && guideMap) fitMapToRoute(nextId);
    });
    container.appendChild(chip);
  }
}

// --- Map --------------------------------------------------------------

function initMap() {
  loadYandexMaps()
    .then(ymaps => {
      guideMap = new GuideMap(ymaps, "map");
      updateStatusPill("statusMaps", "ok", "Яндекс.Карты: готово");
      document.getElementById("mapErrorState").hidden = true;
      refreshMapPoints();
    })
    .catch(() => {
      updateStatusPill("statusMaps", "error", "Яндекс.Карты: ошибка");
      document.getElementById("mapErrorState").hidden = false;
    });
}

function wireMapControls() {
  document.querySelectorAll(".map-ctrl-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".map-ctrl-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = /** @type {HTMLElement} */ (btn).dataset.mapMode;
      const nearbyToggle = /** @type {HTMLInputElement} */ (document.getElementById("nearbyToggle"));
      if (mode === "near") {
        store.setState({ nearbyEnabled: true });
        nearbyToggle.checked = true;
        if (!store.getState().geoEnabled) enableGeolocation();
      } else {
        store.setState({ nearbyEnabled: false });
        nearbyToggle.checked = false;
      }
      refreshMapPoints();
    });
  });
  document.getElementById("mapRetryBtn").addEventListener("click", () => {
    resetYandexMapsLoader();
    updateStatusPill("statusMaps", "warn", "Яндекс.Карты: загрузка…");
    initMap();
  });
  document.getElementById("geoEnableBtn").addEventListener("click", enableGeolocation);
}

function getVisiblePoints() {
  const s = store.getState();
  return s.points.filter(pt => {
    const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
    const byRoute = !s.routeFilterEnabled || !route || route.pointIds.includes(pt.id);
    const byNearby = !s.nearbyEnabled || !s.userFix || haversineMeters(s.userFix.coords, pt.coordinates) <= s.distanceMeters;
    return byRoute && byNearby;
  });
}

/**
 * Fit the map view to a route's points (plus the user's position, if
 * known and nearby). Used when a route is started or selected.
 * @param {string} routeId
 */
function fitMapToRoute(routeId) {
  if (!guideMap) return;
  const s = store.getState();
  const route = s.routesById.get(routeId);
  if (!route) return;
  const coords = route.pointIds.map(id => s.pointsById.get(id)).filter(Boolean).map(p => p.coordinates);
  if (!coords.length) return;
  guideMap.fitToRoute(coords, s.userFix ? s.userFix.coords : null);
}

function refreshMapPoints() {
  if (!guideMap) return;
  const s = store.getState();
  const route = s.routeFilterEnabled && s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
  guideMap.renderPoints(getVisiblePoints(), {
    activeRouteOrder: route ? route.pointIds : null,
    onSelect: id => openPointModal(id)
  });
}

// --- Autoplay toggle ------------------------------------------------------

function wireAutoplayToggle() {
  const btn = /** @type {HTMLElement} */ (document.getElementById("autoplayToggleBtn"));
  btn.addEventListener("click", async () => {
    if (store.getState().autoplay) {
      setAutoplayState(false);
    } else {
      // unlock() must run synchronously inside this gesture, before any
      // await, so it counts as a user-initiated play for the browser.
      await player.unlock();
      if (!store.getState().geoEnabled) await enableGeolocation();
      setAutoplayState(true);
    }
  });
}

/** @param {boolean} enabled */
function setAutoplayState(enabled) {
  store.setState({ autoplay: enabled });
  const btn = document.getElementById("autoplayToggleBtn");
  if (btn) btn.setAttribute("aria-pressed", String(enabled));
  announce(enabled ? "Автовоспроизведение включено" : "Автовоспроизведение выключено");
}

// --- Geolocation --------------------------------------------------------

async function enableGeolocation() {
  await player.unlock();
  ensureGeoController();
  const s = store.getState();
  store.setState({ geoEnabled: true, playedPointIds: loadPlayedPoints(s.activeRouteId) });
  geoController.start();
  updateStatusPill("statusGeo", "ok", "Геолокация: включена");
  document.getElementById("geoEnableBtn").setAttribute("hidden", "");
}

function ensureGeoController() {
  if (geoController) return;
  geoController = new GeoController({
    onFix: handleGeoFix,
    onError: handleGeoError,
    isAudioPlaying: () => player.isPlaying()
  });
}

/** @param {import('./geo.js').GeoFix} fix */
function handleGeoFix(fix) {
  store.setState({ userFix: fix });
  if (guideMap) {
    guideMap.setUserLocation(fix.coords, fix.accuracy);
    if (!store.getState().activeRouteId) guideMap.centerOn(fix.coords);
  }
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

  const point = s.pointsById.get(decision.id);
  if (!point) return;
  openPointModal(point.id, { auto: true });
  const contextLabel = route ? route.title : undefined;
  lastPlayableMeta = { title: point.title, sub: contextLabel ? `Аудиогид · ${contextLabel}` : "Аудиогид" };
  player.play({ id: point.id, title: point.title, audio: point.audio, image: point.image }, contextLabel);
}

/** @param {"denied"|"unavailable"|"transient"} kind */
function handleGeoError(kind) {
  if (kind === "denied") {
    updateStatusPill("statusGeo", "error", "Геолокация: доступ запрещён");
    showGeoBanner();
    announce("Доступ к геолокации запрещён");
  } else if (kind === "unavailable") {
    toast("Геолокация не поддерживается этим браузером", "error");
  } else {
    toast("Не удалось определить местоположение, повторяем…", "error");
  }
}

function showGeoBanner() {
  const banner = /** @type {HTMLElement} */ (document.getElementById("geoBanner"));
  clear(banner);
  banner.appendChild(el("strong", {}, "Доступ к геолокации запрещён"));
  banner.appendChild(el("p", {}, "Разрешите доступ к местоположению в настройках браузера для этого сайта, затем обновите страницу."));
  banner.appendChild(el("button", {
    class: "btn btn-secondary btn-sm", type: "button",
    onclick: () => banner.classList.remove("visible")
  }, "Понятно"));
  banner.classList.add("visible");
}

// --- Route modal --------------------------------------------------------

let routeModalPreviouslyFocused = /** @type {HTMLElement|null} */ (null);
let selectedRouteModalId = /** @type {string|null} */ (null);

function wireRouteModal() {
  const backdrop = /** @type {HTMLElement} */ (document.getElementById("routeModalBackdrop"));
  document.getElementById("closeRouteModalBtn").addEventListener("click", closeRouteModal);
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closeRouteModal(); });
  backdrop.addEventListener("keydown", e => trapFocus(e, backdrop, closeRouteModal));

  document.getElementById("startRouteBtn").addEventListener("click", async () => {
    if (!selectedRouteModalId) return;
    await player.unlock();
    ensureGeoController();
    store.setState({
      activeRouteId: selectedRouteModalId, routeFilterEnabled: true, activePointId: null,
      geoEnabled: true, playedPointIds: loadPlayedPoints(selectedRouteModalId)
    });
    geoController.start();
    updateStatusPill("statusGeo", "ok", "Геолокация: включена");
    document.getElementById("geoEnableBtn").setAttribute("hidden", "");
    setAutoplayState(true);
    /** @type {HTMLInputElement} */ (document.getElementById("routeToggle")).checked = true;
    renderRouteChips();
    refreshMapPoints();
    closeRouteModal();
    switchTab("map");
    fitMapToRoute(selectedRouteModalId);
  });

  document.getElementById("resetPlayedBtn").addEventListener("click", () => {
    resetPlayedPoints(selectedRouteModalId);
    if (store.getState().activeRouteId === selectedRouteModalId) {
      store.setState({ playedPointIds: new Set(), activePointId: null });
    }
    toast("Прослушанное сброшено", "success");
  });

  document.getElementById("routeModalIntroBtn").addEventListener("click", () => {
    const route = selectedRouteModalId && store.getState().routesById.get(selectedRouteModalId);
    if (!route || !route.introAudio) return;
    lastPlayableMeta = { title: "Аудио-введение", sub: `Аудиогид · ${route.title}` };
    player.play({ id: `intro:${route.id}`, title: "Аудио-введение", audio: route.introAudio, image: route.cover }, route.title);
  });
}

/** @param {string} routeId */
function openRouteModal(routeId) {
  const route = store.getState().routesById.get(routeId);
  if (!route) return;
  selectedRouteModalId = routeId;

  document.getElementById("routeModalPillText").textContent = TRANSPORT_LABELS[route.transport];
  document.getElementById("routeModalTitle").textContent = route.title;
  document.getElementById("routeModalDescription").textContent = route.description || "Описание появится позже.";
  document.getElementById("routeModalDuration").textContent = route.durationMinutes ? `${route.durationMinutes} мин` : "—";
  document.getElementById("routeModalDistance").textContent = route.distanceMeters ? `${(route.distanceMeters / 1000).toFixed(1)} км` : "—";
  document.getElementById("routeModalTransport").textContent = TRANSPORT_LABELS[route.transport];

  const coverWrap = /** @type {HTMLElement} */ (document.getElementById("routeModalCoverWrap"));
  clear(coverWrap);
  if (route.cover && isSafeImageUrl(route.cover.url)) {
    const img = el("img", { alt: route.title, width: "960", height: "540", loading: "lazy" });
    img.src = route.cover.url;
    coverWrap.appendChild(el("div", { class: "modal-cover" }, img));
  } else {
    coverWrap.appendChild(el("div", { class: `modal-cover-gradient ${COVER_CLASSES[route.transport]}` }));
  }

  document.getElementById("routeModalIntroWrap").hidden = !route.introAudio;

  const backdrop = /** @type {HTMLElement} */ (document.getElementById("routeModalBackdrop"));
  routeModalPreviouslyFocused = /** @type {HTMLElement} */ (document.activeElement);
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  /** @type {HTMLElement} */ (document.getElementById("closeRouteModalBtn")).focus();
}

function closeRouteModal() {
  const backdrop = /** @type {HTMLElement} */ (document.getElementById("routeModalBackdrop"));
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  routeModalPreviouslyFocused?.focus();
}

// --- Point modal ----------------------------------------------------------

let selectedPointModalId = /** @type {string|null} */ (null);
let pointModalPreviouslyFocused = /** @type {HTMLElement|null} */ (null);

function wirePointModal() {
  const backdrop = /** @type {HTMLElement} */ (document.getElementById("pointModalBackdrop"));
  document.getElementById("closePointModalBtn").addEventListener("click", closePointModal);
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closePointModal(); });
  backdrop.addEventListener("keydown", e => trapFocus(e, backdrop, closePointModal));

  document.getElementById("pointModalDescToggle").addEventListener("click", () => {
    const full = /** @type {HTMLElement} */ (document.getElementById("pointModalFullDesc"));
    const btn = /** @type {HTMLElement} */ (document.getElementById("pointModalDescToggle"));
    const show = full.hidden;
    full.hidden = !show;
    btn.textContent = show ? "Свернуть" : "Читать полностью";
  });

  document.getElementById("pointModalPlayBtn").addEventListener("click", () => {
    const s = store.getState();
    const point = selectedPointModalId && s.pointsById.get(selectedPointModalId);
    if (!point || !point.audio) return;
    const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
    const contextLabel = route ? route.title : undefined;
    lastPlayableMeta = { title: point.title, sub: contextLabel ? `Аудиогид · ${contextLabel}` : "Аудиогид" };
    player.play({ id: point.id, title: point.title, audio: point.audio, image: point.image }, contextLabel);
    if (!s.playedPointIds.has(point.id)) {
      const played = new Set(s.playedPointIds);
      played.add(point.id);
      store.setState({ playedPointIds: played });
      savePlayedPoints(s.activeRouteId, played);
    }
  });

  document.getElementById("pointModalRouteToBtn").addEventListener("click", async () => {
    const s = store.getState();
    const point = selectedPointModalId && s.pointsById.get(selectedPointModalId);
    if (!point) return;
    const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
    const transport = route ? route.transport : "walk";

    if (!isRouteApiUnavailable()) {
      if (!s.userFix) { await enableGeolocation(); toast("Определяем местоположение…"); return; }
      if (guideMap) {
        try {
          await guideMap.routeTo(s.userFix.coords, point.coordinates, transport);
          closePointModal();
          switchTab("map");
          return;
        } catch {
          // ymaps.route failed (e.g. key doesn't include routing) — fall
          // back to an external Yandex Maps link below.
        }
      }
    }

    openExternalRoute(s.userFix ? s.userFix.coords : null, point.coordinates, transport);
    closePointModal();
  });

  document.getElementById("pointModalNextBtn").addEventListener("click", () => {
    const s = store.getState();
    const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
    if (!route || !selectedPointModalId) return;
    const idx = route.pointIds.indexOf(selectedPointModalId);
    const nextId = route.pointIds.slice(idx + 1).find(id => !s.playedPointIds.has(id)) || route.pointIds[idx + 1];
    if (nextId) {
      openPointModal(nextId);
      const next = s.pointsById.get(nextId);
      if (next && guideMap) guideMap.centerOn(next.coordinates);
    }
  });
}

/**
 * Open an external Yandex Maps route link in a new tab — used when
 * `ymaps.route` isn't usable with the configured API key.
 * @param {[number,number]|null} from
 * @param {[number,number]} to
 * @param {"walk"|"bike"|"car"|"transit"} transport
 */
function openExternalRoute(from, to, transport) {
  const url = buildExternalRouteUrl(from, to, transport);
  if (!url) { toast("Не удалось построить маршрут", "error"); return; }
  window.open(url, "_blank", "noopener");
  toast("Маршрут откроется в Яндекс Картах");
}

/** @param {string} pointId @param {{auto?:boolean}} [opts] */
function openPointModal(pointId, opts = {}) {
  const s = store.getState();
  const point = s.pointsById.get(pointId);
  if (!point) return;
  selectedPointModalId = pointId;

  document.getElementById("pointModalTitle").textContent = point.title;
  document.getElementById("pointModalShortDesc").textContent = point.shortDescription || point.description || "Описание скоро появится.";

  const fullDesc = /** @type {HTMLElement} */ (document.getElementById("pointModalFullDesc"));
  const toggle = /** @type {HTMLElement} */ (document.getElementById("pointModalDescToggle"));
  const hasFull = !!point.description && point.description !== point.shortDescription;
  fullDesc.textContent = point.description;
  fullDesc.hidden = true;
  toggle.hidden = !hasFull;
  toggle.textContent = "Читать полностью";

  const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
  const routePill = /** @type {HTMLElement} */ (document.getElementById("pointModalRoutePill"));
  routePill.hidden = !route;
  if (route) document.getElementById("pointModalRouteText").textContent = route.title;

  const coverWrap = /** @type {HTMLElement} */ (document.getElementById("pointModalCoverWrap"));
  clear(coverWrap);
  if (point.image && isSafeImageUrl(point.image.url)) {
    const img = el("img", { alt: point.title, width: "960", height: "540", loading: "lazy" });
    img.src = point.image.url;
    coverWrap.appendChild(el("div", { class: "modal-cover" }, img));
  }

  const playBtn = /** @type {HTMLElement} */ (document.getElementById("pointModalPlayBtn"));
  playBtn.hidden = !point.audio;

  const nextBtn = /** @type {HTMLElement} */ (document.getElementById("pointModalNextBtn"));
  nextBtn.hidden = !route;

  updatePointModalPlayLabel();

  const backdrop = /** @type {HTMLElement} */ (document.getElementById("pointModalBackdrop"));
  pointModalPreviouslyFocused = /** @type {HTMLElement} */ (document.activeElement);
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  if (!opts.auto) /** @type {HTMLElement} */ (document.getElementById("closePointModalBtn")).focus();
}

function closePointModal() {
  const backdrop = /** @type {HTMLElement} */ (document.getElementById("pointModalBackdrop"));
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  pointModalPreviouslyFocused?.focus();
}

function updatePointModalPlayLabel() {
  const label = document.getElementById("pointModalPlayLabel");
  if (!label) return;
  const pState = player.getState();
  const isThis = selectedPointModalId && pState.pointId === selectedPointModalId;
  if (isThis && pState.blockedByAutoplay) label.textContent = "Нажмите, чтобы слушать";
  else if (isThis && pState.playing) label.textContent = "Пауза";
  else label.textContent = "Слушать";
}

/**
 * Minimal focus trap for a modal: Tab/Shift+Tab cycle within it, Escape closes.
 * @param {KeyboardEvent} e
 * @param {HTMLElement} backdrop
 * @param {() => void} onClose
 */
function trapFocus(e, backdrop, onClose) {
  if (e.key === "Escape") { onClose(); return; }
  if (e.key !== "Tab") return;
  const focusable = backdrop.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = /** @type {HTMLElement} */ (focusable[0]);
  const last = /** @type {HTMLElement} */ (focusable[focusable.length - 1]);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// --- Player UI (mini-player) --------------------------------------------

function wirePlayer() {
  const playBtn = /** @type {HTMLElement} */ (document.getElementById("playerPlayBtn"));
  playBtn.addEventListener("click", () => player.togglePlayPause());
  document.getElementById("playerCloseBtn").addEventListener("click", () => player.stop());
  document.getElementById("playerUnlockBtn").addEventListener("click", () => player.resume());

  const seekBar = /** @type {HTMLElement} */ (document.getElementById("playerSeekBar"));
  let dragging = false;
  const ratioFromEvent = e => {
    const rect = seekBar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  seekBar.addEventListener("pointerdown", e => {
    dragging = true;
    seekBar.setPointerCapture(e.pointerId);
    const duration = player.getState().duration || 0;
    player.seekTo(ratioFromEvent(e) * duration);
  });
  seekBar.addEventListener("pointermove", e => {
    if (!dragging) return;
    const duration = player.getState().duration || 0;
    player.seekTo(ratioFromEvent(e) * duration);
  });
  seekBar.addEventListener("pointerup", () => { dragging = false; });
  seekBar.addEventListener("keydown", e => {
    if (e.key === "ArrowRight") { player.seekBy(5); e.preventDefault(); }
    if (e.key === "ArrowLeft") { player.seekBy(-5); e.preventDefault(); }
  });
}

/** @param {import('./player.js').PlayerState} pState */
function renderPlayer(pState) {
  const miniplayer = /** @type {HTMLElement} */ (document.getElementById("miniplayer"));
  const hasTrack = !!pState.pointId;
  miniplayer.classList.toggle("visible", hasTrack);
  document.body.classList.toggle("has-player", hasTrack);
  updatePointModalPlayLabel();
  if (!hasTrack) return;

  document.getElementById("playerTitle").textContent = lastPlayableMeta?.title || "";
  document.getElementById("playerSub").textContent = lastPlayableMeta?.sub || "";

  const nextChip = /** @type {HTMLElement} */ (document.getElementById("playerNextChip"));
  nextChip.hidden = !pState.queuedNextTitle;
  nextChip.textContent = pState.queuedNextTitle ? `Далее: ${pState.queuedNextTitle}` : "";

  const playBtn = document.getElementById("playerPlayBtn");
  playBtn.querySelector(".icon-play").toggleAttribute("hidden", pState.playing);
  playBtn.querySelector(".icon-pause").toggleAttribute("hidden", !pState.playing);
  playBtn.setAttribute("aria-label", pState.playing ? "Пауза" : "Воспроизвести");

  const unlockBtn = /** @type {HTMLElement} */ (document.getElementById("playerUnlockBtn"));
  const progressWrap = /** @type {HTMLElement} */ (document.getElementById("playerProgressWrap"));
  unlockBtn.hidden = !pState.blockedByAutoplay;
  playBtn.hidden = pState.blockedByAutoplay;
  progressWrap.style.display = pState.blockedByAutoplay ? "none" : "";

  const pct = pState.duration ? (pState.currentTime / pState.duration) * 100 : 0;
  document.getElementById("playerFill").style.width = pct + "%";
  document.getElementById("playerSeekBar").setAttribute("aria-valuenow", String(Math.round(pct)));
  document.getElementById("playerTimeCurrent").textContent = formatTime(pState.currentTime);
  document.getElementById("playerTimeDuration").textContent = formatTime(pState.duration);
}

/** @param {number} seconds */
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
