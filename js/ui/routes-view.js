// @ts-check
/**
 * Route list (start screen) and route page (cover, facts, intro, stops,
 * "Начать маршрут").
 */
import { el, clear, icon, isSafeImageUrl, setSafeBackgroundImage } from "../dom.js";
import { formatDistance, formatDuration, formatTime, pointsLabel, routeProgress } from "../format.js";
import { loadPlayedPoints } from "../geo.js";
import * as player from "../player.js";

export const TRANSPORT_LABELS = { walk: "Пешком", bike: "Вело / самокат", car: "На машине", transit: "Транспорт" };
const COVER_CLASSES = { walk: "cover-walk", bike: "cover-bike", car: "cover-car", transit: "cover-transit" };

/**
 * @typedef {Object} RoutesCtx
 * @property {import('../store.js').Store<any>} store
 * @property {(routeId: string) => void} openRoute
 * @property {(pointId: string) => void} openPoint
 * @property {() => void} retryLoad
 * @property {() => void} resumeRoute
 */

/** @type {RoutesCtx|null} */
let ctx = null;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {RoutesCtx} context */
export function wireRoutesView(context) {
  ctx = context;
  $("routeSearch").addEventListener("input", applySearch);
  $("resumeBtn").addEventListener("click", () => ctx.resumeRoute());
}

/**
 * Played ids for a route: live state if it is the active route, else storage.
 * @param {any} s store state
 * @param {string} routeId
 * @returns {Set<string>}
 */
export function playedFor(s, routeId) {
  return s.activeRouteId === routeId ? s.playedPointIds : loadPlayedPoints(routeId);
}

export function renderRouteList() {
  if (!ctx) return;
  const grid = $("routeGrid");
  const s = ctx.store.getState();
  grid.setAttribute("aria-busy", String(s.loadState === "loading"));
  renderResumeBar();

  if (s.loadState === "loading") return; // keep skeletons from index.html
  clear(grid);

  if (s.loadState === "error") {
    grid.appendChild(messageState({
      title: "Маршруты не загрузились",
      text: `${s.loadError || "Нет связи с сервером."} Проверьте интернет и попробуйте ещё раз.`,
      actionLabel: "Повторить",
      onAction: () => ctx.retryLoad(),
      error: true
    }));
    return;
  }
  if (!s.routes.length) {
    grid.appendChild(messageState({
      title: "Маршрутов пока нет",
      text: "Мы готовим первые прогулки. Пока можно открыть карту и послушать отдельные точки."
    }));
    return;
  }
  for (const route of s.routes) grid.appendChild(buildRouteCard(route, s));
  applySearch();
}

function renderResumeBar() {
  const s = ctx.store.getState();
  const route = s.activeRouteId && s.routeFilterEnabled ? s.routesById.get(s.activeRouteId) : null;
  $("resumeBar").hidden = !route;
  if (route) $("resumeTitle").textContent = route.title;
}

/** @param {{title:string, text:string, actionLabel?:string, onAction?:()=>void, error?:boolean}} o */
function messageState({ title, text, actionLabel, onAction, error }) {
  return el("div", { class: `empty-state${error ? " is-error" : ""}`, role: error ? "alert" : null },
    el("h2", {}, title),
    el("p", {}, text),
    actionLabel ? el("button", { class: "btn btn-primary", type: "button", onclick: onAction }, icon("refresh"), actionLabel) : null
  );
}

/** @param {any} route @param {any} s */
function buildRouteCard(route, s) {
  const cover = el("div", { class: `route-cover ${COVER_CLASSES[route.transport]}` },
    el("span", { class: "route-cover-badge" }, TRANSPORT_LABELS[route.transport])
  );
  if (route.cover) setSafeBackgroundImage(cover, route.cover.url);
  const prog = routeProgress(route.pointIds, id => s.pointsById.has(id), playedFor(s, route.id));
  const meta = [formatDuration(route.durationMinutes), formatDistance(route.distanceMeters), pointsLabel(prog.total)]
    .filter(v => v !== "—").join(" · ");
  const isActive = s.activeRouteId === route.id && s.routeFilterEnabled;

  const body = el("div", { class: "route-body" },
    el("h2", { class: "route-card-title" }, el("span", { class: "mark" }, route.title)),
    route.description ? el("p", { class: "desc" }, route.description) : null,
    el("p", { class: "route-meta braces" }, meta)
  );
  if (prog.playedCount > 0) {
    const bar = el("span", { class: "bar" }, el("span", { style: `transform:scaleX(${prog.playedCount / Math.max(1, prog.total)})` }));
    body.appendChild(el("p", { class: "route-progress" },
      prog.done ? "Пройден" : `Прослушано ${prog.playedCount} из ${prog.total}`, bar));
  }
  const card = el("button", {
    class: `route-card${isActive ? " is-active" : ""}`,
    type: "button",
    "aria-label": `${route.title}. ${meta}${isActive ? ". Идёт сейчас" : ""}`,
    dataset: { search: `${route.title} ${route.description}`.toLowerCase() }
  }, cover, body);
  card.addEventListener("click", () => ctx.openRoute(route.id));
  return card;
}

function applySearch() {
  const q = /** @type {HTMLInputElement} */ ($("routeSearch")).value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll("#routeGrid .route-card").forEach(card => {
    const match = !q || (/** @type {HTMLElement} */ (card).dataset.search || "").includes(q);
    /** @type {HTMLElement} */ (card).hidden = !match;
    if (match) shown++;
  });
  const any = document.querySelectorAll("#routeGrid .route-card").length > 0;
  $("routeSearchEmpty").hidden = !(any && shown === 0);
}

// --- Route page -------------------------------------------------------------

/**
 * Fill the route page for `routeId`. Safe to call again to refresh played
 * state while the page is open.
 * @param {string} routeId
 */
export function renderRouteDetail(routeId) {
  if (!ctx) return;
  const s = ctx.store.getState();
  const route = s.routesById.get(routeId);
  if (!route) return;
  const played = playedFor(s, routeId);
  const prog = routeProgress(route.pointIds, id => s.pointsById.has(id), played);

  const title = $("routeModalTitle");
  clear(title);
  title.appendChild(el("span", { class: "mark mark-coral" }, route.title));
  $("routeModalDescription").textContent = route.description || "Описание появится позже.";
  $("routeModalDuration").textContent = formatDuration(route.durationMinutes);
  $("routeModalDistance").textContent = formatDistance(route.distanceMeters);
  $("routeModalCount").textContent = String(prog.total);
  $("routeModalTransport").textContent = TRANSPORT_LABELS[route.transport];

  const coverWrap = $("routeModalCoverWrap");
  if (coverWrap.dataset.routeId !== routeId) {
    coverWrap.dataset.routeId = routeId;
    clear(coverWrap);
    if (route.cover && isSafeImageUrl(route.cover.url)) {
      const img = el("img", { alt: "", width: "960", height: "540", decoding: "async" });
      /** @type {HTMLImageElement} */ (img).src = route.cover.url;
      coverWrap.appendChild(el("div", { class: "modal-cover" }, img));
    } else {
      coverWrap.appendChild(el("div", { class: `modal-cover-gradient ${COVER_CLASSES[route.transport]}` }));
    }
  }

  $("routeModalIntroWrap").hidden = !route.introAudio;
  if (route.introAudio) {
    const p = player.getState();
    const introPlaying = p.pointId === `intro:${route.id}` && p.playing;
    $("routeModalIntroBtn").classList.toggle("is-playing", introPlaying);
    $("routeModalIntroMeta").textContent = introPlaying
      ? "Играет. Пауза в плеере внизу"
      : route.introAudio.durationSeconds
        ? `${formatTime(route.introAudio.durationSeconds)} · послушайте перед стартом`
        : "Послушайте перед стартом";
  }

  const list = $("routeStops");
  clear(list);
  prog.ids.forEach((id, i) => {
    const pt = s.pointsById.get(id);
    const isPlayed = played.has(id);
    const isNext = id === prog.nextId && prog.playedCount > 0;
    const tag = isPlayed ? "Прослушано" : isNext ? "Далее" : pt.audio ? "" : "Без аудио";
    const btn = el("button", { class: "stop-btn", type: "button" },
      el("span", { class: "stop-n", "aria-hidden": "true" }, isPlayed ? icon("check") : String(i + 1)),
      el("span", { class: "stop-text" },
        el("span", { class: "stop-title" }, pt.title),
        pt.shortDescription ? el("span", { class: "stop-sub" }, pt.shortDescription) : null
      ),
      tag ? el("span", { class: "stop-tag" }, tag) : null
    );
    btn.setAttribute("aria-label", `${i + 1}. ${pt.title}${tag ? `, ${tag.toLowerCase()}` : ""}`);
    btn.addEventListener("click", () => ctx.openPoint(id));
    list.appendChild(el("li", { class: `stop${isPlayed ? " is-played" : ""}${isNext ? " is-next" : ""}` }, btn));
  });
  $("routeStopsNote").textContent = prog.total === 0
    ? "Остановки ещё не добавлены."
    : prog.done ? "Все рассказы прослушаны. Чтобы пройти заново, сбросьте прослушанное."
      : prog.playedCount ? `Прослушано ${prog.playedCount} из ${prog.total}.` : "";

  const isActive = s.activeRouteId === routeId && s.routeFilterEnabled;
  $("startRouteLabel").textContent = isActive ? "Продолжить на карте" : prog.playedCount ? "Продолжить маршрут" : "Начать маршрут";
  $("routePermissionNote").hidden = isActive || s.geoEnabled;
  $("resetPlayedBtn").hidden = prog.playedCount === 0;
}
