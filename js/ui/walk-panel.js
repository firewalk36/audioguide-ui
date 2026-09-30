// @ts-check
/**
 * Walking mode: a panel docked over the map that always answers
 * "where next, how far, is the sound on?" for the active route.
 */
import { el, clear, icon, announce } from "../dom.js";
import { CONFIG } from "../config.js";
import { haversineMeters } from "../geo.js";
import { bearingDeg, compassRu, formatDistance, formatEta, routeProgress } from "../format.js";

/**
 * @typedef {Object} WalkCtx
 * @property {import('../store.js').Store<any>} store
 * @property {(pointId: string) => void} openPoint
 * @property {(pointId: string) => void} routeToPoint
 * @property {() => void} endRoute
 * @property {() => void} toggleAutoplay
 * @property {() => void} enableGeolocation
 * @property {() => void} showRoutes
 */

/** @type {WalkCtx|null} */
let ctx = null;
let lastSignature = "";
let lastAnnouncedNext = /** @type {string|null} */ (null);

/** @param {WalkCtx} context */
export function wireWalkPanel(context) {
  ctx = context;
}

/**
 * The status line under the next stop: geolocation problems first, then
 * an "Автозвук is off" prompt. When everything works (fix is good and
 * Автозвук is on) there is nothing to say — the top-bar toggle already
 * shows the state — so this returns null.
 * @param {any} s
 * @returns {{kind:string, text:string, action?:string, onAction?:()=>void}|null}
 */
function statusLine(s) {
  if (s.geoDenied) return { kind: "warn", text: "Нет доступа к геолокации. Открывайте точки сами." };
  if (!s.geoEnabled) return { kind: "warn", text: "Геолокация выключена.", action: "Включить", onAction: () => ctx.enableGeolocation() };
  if (!s.userFix) return { kind: "warn", text: "Ищем вас… Лучше выйти на открытое место." };
  if (s.userFix.accuracy > CONFIG.geo.maxAccuracyM) {
    return { kind: "warn", text: `Слабый сигнал GPS (±${Math.round(s.userFix.accuracy)} м), рассказ подождёт точной позиции.` };
  }
  if (s.autoplay) return null;
  return { kind: "off", text: "Автозвук выключен.", action: "Включить", onAction: () => ctx.toggleAutoplay() };
}

export function renderWalkPanel() {
  if (!ctx) return;
  const panel = /** @type {HTMLElement} */ (document.getElementById("walkPanel"));
  const s = ctx.store.getState();
  const route = s.activeRouteId && s.routeFilterEnabled ? s.routesById.get(s.activeRouteId) : null;
  if (!route) {
    panel.hidden = true;
    lastSignature = "";
    return;
  }
  const prog = routeProgress(route.pointIds, id => s.pointsById.has(id), s.playedPointIds);
  const next = prog.nextId ? s.pointsById.get(prog.nextId) : null;
  const dist = next && s.userFix ? haversineMeters(s.userFix.coords, next.coordinates) : null;
  const status = statusLine(s);
  const distText = dist == null ? "" : formatDistance(dist);
  const dirText = dist == null || dist < 30 ? "" : `${compassRu(bearingDeg(s.userFix.coords, next.coordinates))} · ${formatEta(dist, route.transport)}`;

  const signature = JSON.stringify([route.id, prog.playedCount, prog.nextId, distText, dirText, status && status.kind, status && status.text]);
  if (signature === lastSignature && !panel.hidden) return;
  lastSignature = signature;

  if (next && next.id !== lastAnnouncedNext) {
    lastAnnouncedNext = next.id;
    announce(`Следующая точка: ${next.title}${distText ? `, ${distText}` : ""}`);
  }

  clear(panel);
  panel.hidden = false;
  panel.classList.toggle("is-done", prog.done);
  panel.setAttribute("aria-label", `Маршрут «${route.title}»`);
  panel.setAttribute("role", "region");

  // Progress row: the segmented bar plus "N из M" — the stop counter lives
  // here, not as a label above the stop name.
  const position = prog.done ? prog.total : next ? prog.ids.indexOf(next.id) + 1 : 0;
  const bar = el("div", { class: "walk-bar", "aria-hidden": "true" });
  for (const id of prog.ids) {
    bar.appendChild(el("span", { class: s.playedPointIds.has(id) ? "is-played" : id === prog.nextId ? "is-next" : "" }));
  }
  panel.appendChild(el("div", { class: "walk-steps" },
    bar,
    el("span", { class: "walk-count", "aria-label": `Точка ${position} из ${prog.total}` }, `${position} из ${prog.total}`)
  ));

  const body = el("div", { class: "walk-body" });
  if (prog.done) {
    appendAll(body,
      el("h2", { class: "walk-title" }, el("span", { class: "mark" }, "Маршрут пройден")),
      el("p", { class: "walk-hint" }, "Вы дошли до всех точек. Спасибо, что прошли с нами!"),
      el("div", { class: "walk-actions" },
        el("button", { class: "btn btn-primary", type: "button", onclick: () => ctx.showRoutes() }, "Другие маршруты"),
        el("button", { class: "btn btn-outline", type: "button", onclick: () => ctx.endRoute() }, "Завершить")
      )
    );
  } else if (next) {
    const where = [distText, dirText].filter(Boolean).join(" · ");
    appendAll(body,
      el("div", { class: "walk-head" },
        el("h2", { class: "walk-title" }, next.title),
        el("button", { class: "btn btn-quiet walk-end", type: "button", onclick: () => ctx.endRoute() }, "Завершить")
      ),
      where ? el("p", { class: "walk-dist" }, where) : null,
      status ? buildStatus(status) : null,
      el("div", { class: "walk-actions" },
        el("button", { class: "btn btn-primary", type: "button", onclick: () => ctx.openPoint(next.id) },
          icon(next.audio ? "headphones" : "pin"), next.audio ? "Слушать" : "Открыть"),
        el("button", { class: "btn btn-outline", type: "button", "aria-label": `Как дойти до точки «${next.title}»`, onclick: () => ctx.routeToPoint(next.id) },
          icon("path"), "Путь")
      )
    );
  }
  panel.appendChild(body);
}

/**
 * Append children, skipping null/false (native append would print "null").
 * @param {HTMLElement} parent
 * @param {...(Node|null|false|undefined)} nodes
 */
function appendAll(parent, ...nodes) {
  for (const n of nodes) if (n) parent.appendChild(n);
}

/** @param {{kind:string, text:string, action?:string, onAction?:()=>void}} status */
function buildStatus(status) {
  return el("p", { class: `walk-hint is-${status.kind}` },
    el("span", { class: "dot", "aria-hidden": "true" }),
    el("span", {}, status.text),
    status.action ? el("button", { class: "btn btn-quiet", type: "button", onclick: status.onAction }, status.action) : null
  );
}
