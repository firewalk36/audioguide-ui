// @ts-check
/**
 * Overlay layers (route page, point sheet, first run) that the phone's
 * system Back button should close instead of leaving the site. Each open
 * layer pushes one history entry; closing from the UI pops it, and a
 * popstate closes the topmost layer.
 */

/** @typedef {{ id: string, close: () => void }} Layer */

/** @type {Layer[]} */
const stack = [];
let wired = false;
let ignoreNextPop = false;

function wire() {
  if (wired) return;
  wired = true;
  window.addEventListener("popstate", () => {
    if (ignoreNextPop) { ignoreNextPop = false; return; }
    const top = stack.pop();
    if (top) top.close();
  });
}

/**
 * Register a layer as open. Re-opening an already open layer is a no-op for
 * history (its content just re-renders).
 * @param {string} id
 * @param {() => void} close performs the actual hide; must be idempotent
 */
export function pushLayer(id, close) {
  wire();
  if (stack.some(l => l.id === id)) return;
  stack.push({ id, close });
  try {
    history.pushState({ agLayer: id }, "");
  } catch {
    /* history unavailable (sandboxed iframe) — layers still close from the UI */
  }
}

/**
 * Close a layer from the UI: runs its close handler now and rewinds the
 * matching history entry without re-triggering the handler.
 * @param {string} id
 */
export function popLayer(id) {
  const idx = stack.findIndex(l => l.id === id);
  if (idx === -1) return;
  const [layer] = stack.splice(idx, 1);
  layer.close();
  if (idx === stack.length && history.state && history.state.agLayer === id) {
    ignoreNextPop = true;
    history.back();
  }
}

/** @param {string} id */
export function isLayerOpen(id) {
  return stack.some(l => l.id === id);
}

/**
 * Minimal focus trap: Tab/Shift+Tab cycle within `root`, Escape calls onClose.
 * @param {KeyboardEvent} e
 * @param {HTMLElement} root
 * @param {() => void} onClose
 */
export function trapFocus(e, root, onClose) {
  if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
  if (e.key !== "Tab") return;
  const focusable = [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(n => !(/** @type {HTMLElement} */ (n).hidden) && /** @type {HTMLElement} */ (n).offsetParent !== null);
  if (!focusable.length) return;
  const first = /** @type {HTMLElement} */ (focusable[0]);
  const last = /** @type {HTMLElement} */ (focusable[focusable.length - 1]);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
