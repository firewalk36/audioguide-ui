// @ts-check
/**
 * Настройки: Автозвук, "только рядом" + радиус, фильтр по маршруту,
 * справка и состояние сервиса.
 */
import { el, clear } from "../dom.js";
import { loadPlayedPoints, loadListenedPoints } from "../geo.js";

/**
 * @typedef {Object} SettingsCtx
 * @property {import('../store.js').Store<any>} store
 * @property {() => void} refreshMapPoints
 * @property {(routeId: string) => void} fitMapToRoute
 * @property {() => Promise<void>|void} enableGeolocation
 * @property {() => Promise<void>|void} toggleAutoplay
 * @property {(enabled: boolean) => void} setAutoplayState
 * @property {() => void} clearRoute
 * @property {() => void} showMap
 * @property {() => void} showIntro
 */

/** @type {SettingsCtx|null} */
let ctx = null;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {number} v metres */
function radiusLabel(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1).replace(".", ",")} км` : `${v} м`;
}

/** @param {SettingsCtx} context */
export function wireSettings(context) {
  ctx = context;
  const nearbyToggle = /** @type {HTMLInputElement} */ ($("nearbyToggle"));
  const distanceRange = /** @type {HTMLInputElement} */ ($("distanceRange"));
  const routeToggle = /** @type {HTMLInputElement} */ ($("routeToggle"));
  const autoplayToggle = /** @type {HTMLInputElement} */ ($("autoplaySettingToggle"));

  autoplayToggle.addEventListener("change", () => {
    // Same path as the header button, so audio unlock happens in this gesture.
    const wantOn = autoplayToggle.checked;
    if (wantOn !== ctx.store.getState().autoplay) ctx.toggleAutoplay();
  });

  nearbyToggle.addEventListener("change", () => {
    ctx.store.setState({ nearbyEnabled: nearbyToggle.checked });
    syncMapModeButtons(nearbyToggle.checked);
    if (nearbyToggle.checked && !ctx.store.getState().geoEnabled) ctx.enableGeolocation();
    ctx.refreshMapPoints();
  });
  distanceRange.addEventListener("input", () => {
    const v = Number(distanceRange.value);
    ctx.store.setState({ distanceMeters: v });
    $("distanceValue").textContent = radiusLabel(v);
    distanceRange.setAttribute("aria-valuetext", radiusLabel(v));
    if (ctx.store.getState().nearbyEnabled) ctx.refreshMapPoints();
  });
  routeToggle.addEventListener("change", () => {
    if (!routeToggle.checked) {
      ctx.store.setState({ routeFilterEnabled: false, activeRouteId: null, activePointId: null, playedPointIds: loadPlayedPoints(null), listenedPointIds: loadListenedPoints(null) });
    } else {
      ctx.store.setState({ routeFilterEnabled: true });
    }
    renderRouteChips();
    ctx.refreshMapPoints();
  });
  $("applyFiltersBtn").addEventListener("click", () => { ctx.refreshMapPoints(); ctx.showMap(); });
  $("resetFiltersBtn").addEventListener("click", () => {
    nearbyToggle.checked = false;
    routeToggle.checked = false;
    ctx.store.setState({
      nearbyEnabled: false, routeFilterEnabled: false, activeRouteId: null,
      activePointId: null, playedPointIds: loadPlayedPoints(null), listenedPointIds: loadListenedPoints(null)
    });
    syncMapModeButtons(false);
    renderRouteChips();
    ctx.refreshMapPoints();
    ctx.clearRoute();
  });
  $("showIntroBtn").addEventListener("click", () => ctx.showIntro());
}

export function renderRouteChips() {
  if (!ctx) return;
  const container = $("routeChips");
  const s = ctx.store.getState();
  clear(container);
  if (!s.routes.length) {
    container.appendChild(el("span", { class: "chip-hint" }, s.loadState === "loading" ? "Маршруты загружаются…" : "Маршрутов пока нет"));
    return;
  }
  for (const route of s.routes) {
    const active = route.id === s.activeRouteId;
    const chip = el("button", {
      class: `chip${active ? " active" : ""}`,
      type: "button",
      "aria-pressed": String(active),
      disabled: !s.routeFilterEnabled
    }, route.title);
    chip.addEventListener("click", () => {
      const cur = ctx.store.getState();
      const nextId = cur.activeRouteId === route.id ? null : route.id;
      ctx.store.setState({ activeRouteId: nextId, activePointId: null, playedPointIds: loadPlayedPoints(nextId), listenedPointIds: loadListenedPoints(nextId) });
      renderRouteChips();
      ctx.refreshMapPoints();
      if (nextId) ctx.fitMapToRoute(nextId);
    });
    container.appendChild(chip);
  }
}

/** @param {boolean} enabled */
export function syncAutoplayControls(enabled) {
  const btn = $("autoplayToggleBtn");
  btn.setAttribute("aria-pressed", String(enabled));
  $("autosoundState").textContent = enabled ? "вкл" : "выкл";
  /** @type {HTMLInputElement} */ ($("autoplaySettingToggle")).checked = enabled;
}

/** @param {boolean} near */
export function syncMapModeButtons(near) {
  document.querySelectorAll(".map-ctrl-btn").forEach(b => {
    const on = (/** @type {HTMLElement} */ (b).dataset.mapMode === "near") === near;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

/** @param {string} id @param {"ok"|"warn"|"error"} state @param {string} text */
export function updateStatusPill(id, state, text) {
  const node = document.getElementById(id);
  if (!node) return;
  node.dataset.state = state;
  clear(node);
  node.appendChild(el("span", { class: "dot" }));
  node.appendChild(document.createTextNode(text));
}
