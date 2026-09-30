// @ts-check
/**
 * Point card as a bottom sheet: photo, title, one big "listen" action,
 * description, "how to get there" and "next stop".
 */
import { el, clear, isSafeImageUrl } from "../dom.js";
import { formatTime, routeProgress } from "../format.js";
import * as player from "../player.js";
import { pushLayer, popLayer, trapFocus } from "./layers.js";

/**
 * @typedef {Object} PointSheetCtx
 * @property {import('../store.js').Store<any>} store
 * @property {(point: any) => void} playPoint
 * @property {(pointId: string) => void} routeToPoint
 * @property {(coords: [number, number]) => void} centerOn
 */

/** @type {PointSheetCtx|null} */
let ctx = null;
/** @type {string|null} */
let selectedId = null;
/** @type {HTMLElement|null} */
let previouslyFocused = null;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {PointSheetCtx} context */
export function wirePointSheet(context) {
  ctx = context;
  const backdrop = $("pointModalBackdrop");
  $("closePointModalBtn").addEventListener("click", closePointSheet);
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closePointSheet(); });
  backdrop.addEventListener("keydown", e => trapFocus(e, backdrop, closePointSheet));

  $("pointModalDescToggle").addEventListener("click", () => {
    const full = $("pointModalFullDesc");
    const btn = $("pointModalDescToggle");
    const show = full.hidden;
    full.hidden = !show;
    btn.textContent = show ? "Свернуть" : "Читать полностью";
    btn.setAttribute("aria-expanded", String(show));
  });

  $("pointModalPlayBtn").addEventListener("click", () => {
    const s = ctx.store.getState();
    const point = selectedId && s.pointsById.get(selectedId);
    if (!point || !point.audio) return;
    const p = player.getState();
    // The same track: pause/resume instead of restarting it from zero.
    if (p.pointId === point.id) {
      if (p.blockedByAutoplay) player.resume();
      else player.togglePlayPause();
      return;
    }
    ctx.playPoint(point);
  });

  $("pointModalRouteToBtn").addEventListener("click", () => {
    if (selectedId) ctx.routeToPoint(selectedId);
  });

  $("pointModalNextBtn").addEventListener("click", () => {
    const s = ctx.store.getState();
    const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
    if (!route || !selectedId) return;
    const idx = route.pointIds.indexOf(selectedId);
    const nextId = route.pointIds.slice(idx + 1).find(id => !s.playedPointIds.has(id)) || route.pointIds[idx + 1];
    if (nextId) {
      openPointSheet(nextId);
      const next = s.pointsById.get(nextId);
      if (next) ctx.centerOn(next.coordinates);
    }
  });

  player.subscribe(() => updatePlayLabel());
  // The «Прослушано» chip appears live once the story passes 80 %.
  ctx.store.subscribe((st, prev) => {
    if (st.listenedPointIds !== prev.listenedPointIds && selectedId) renderChips(st, selectedId);
  });
}

/**
 * @param {any} s store state
 * @param {string} pointId
 */
function renderChips(s, pointId) {
  const chips = $("pointModalChipRow");
  clear(chips);
  if (s.listenedPointIds.has(pointId)) chips.appendChild(el("span", { class: "next-chip" }, "Прослушано"));
}

/** @returns {string|null} */
export function getSelectedPointId() {
  return selectedId;
}

/**
 * @param {string} pointId
 * @param {{auto?: boolean}} [opts] auto: opened by the geofence (don't steal focus)
 */
export function openPointSheet(pointId, opts = {}) {
  if (!ctx) return;
  const s = ctx.store.getState();
  const point = s.pointsById.get(pointId);
  if (!point) return;
  selectedId = pointId;

  $("pointModalTitle").textContent = point.title;
  $("pointModalShortDesc").textContent = point.shortDescription || point.description || "Описание скоро появится.";

  const fullDesc = $("pointModalFullDesc");
  const toggle = $("pointModalDescToggle");
  const hasFull = !!point.description && point.description !== point.shortDescription;
  fullDesc.textContent = point.description;
  fullDesc.hidden = true;
  toggle.hidden = !hasFull;
  toggle.textContent = "Читать полностью";
  toggle.setAttribute("aria-expanded", "false");

  const route = s.activeRouteId ? s.routesById.get(s.activeRouteId) : null;
  const pill = $("pointModalRoutePill");
  pill.hidden = !route;
  if (route) {
    const prog = routeProgress(route.pointIds, id => s.pointsById.has(id), s.playedPointIds);
    const pos = prog.ids.indexOf(point.id);
    $("pointModalRouteText").textContent = pos >= 0
      ? `{ ${route.title} · ${pos + 1} / ${prog.total} }`
      : `{ ${route.title} }`;
  }

  const coverWrap = $("pointModalCoverWrap");
  clear(coverWrap);
  if (point.image && isSafeImageUrl(point.image.url)) {
    const img = el("img", { alt: point.title, width: "960", height: "540", decoding: "async" });
    /** @type {HTMLImageElement} */ (img).src = point.image.url;
    coverWrap.appendChild(el("div", { class: "modal-cover" }, img));
  }

  renderChips(s, point.id);

  $("pointModalPlayBtn").hidden = !point.audio;
  $("pointModalNextBtn").hidden = !route;
  updatePlayLabel();

  const backdrop = $("pointModalBackdrop");
  const wasOpen = backdrop.classList.contains("open");
  if (!wasOpen) previouslyFocused = /** @type {HTMLElement} */ (document.activeElement);
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
  document.body.classList.add("no-scroll");
  /** @type {HTMLElement} */ (backdrop.querySelector(".sheet")).scrollTop = 0;
  pushLayer("point", hidePointSheet);
  if (!opts.auto) $("closePointModalBtn").focus();
}

function hidePointSheet() {
  const backdrop = $("pointModalBackdrop");
  if (!backdrop.classList.contains("open")) return;
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
  document.body.classList.remove("no-scroll");
  previouslyFocused?.focus?.();
}

export function closePointSheet() {
  popLayer("point");
  hidePointSheet();
}

export function updatePlayLabel() {
  if (!ctx) return;
  const label = $("pointModalPlayLabel");
  const btn = $("pointModalPlayBtn");
  const p = player.getState();
  const point = selectedId ? ctx.store.getState().pointsById.get(selectedId) : null;
  const isThis = !!selectedId && p.pointId === selectedId;
  const dur = point && point.audio && point.audio.durationSeconds ? ` · ${formatTime(point.audio.durationSeconds)}` : "";
  if (isThis && p.blockedByAutoplay) label.textContent = "Нажмите, чтобы слушать";
  else if (isThis && p.playing) label.textContent = "Пауза";
  else if (isThis) label.textContent = p.currentTime > 0 ? "Продолжить" : `Слушать рассказ${dur}`;
  else label.textContent = `Слушать рассказ${dur}`;
  btn.classList.toggle("is-playing", isThis && p.playing);
}
