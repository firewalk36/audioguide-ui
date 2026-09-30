// @ts-check
/**
 * DOM helpers. Nothing in this module ever assigns raw HTML markup to an
 * element — nodes are built with `el()` and text is always set via
 * `textContent` (through the DOM API itself).
 */

/**
 * Create an element with attributes and children.
 * @param {string} tag
 * @param {Object<string, any>} [attrs]
 * @param {...(Node|string|number|null|undefined|Array<Node|string|number|null|undefined>)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class" || key === "className") {
      node.className = String(value);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset" && value && typeof value === "object") {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = String(dv);
    } else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Remove all children of a node, using the DOM API rather than markup assignment.
 * @param {Element} node
 */
export function clear(node) {
  node.replaceChildren();
}

/**
 * Escape a string for the few places that legitimately render HTML
 * (Yandex Maps `hintContent`/`balloonContent`, which are HTML, not text).
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch
  ));
}

// Same-origin media served by our own backend (see audioguide-backend's
// storage contract): server-generated uuid4-hex filenames only.
const SAFE_IMAGE_PATH_RE = /^\/media\/images\/[0-9a-f]{32}\.jpg$/;
const SAFE_AUDIO_PATH_RE = /^\/media\/audio\/[0-9a-f]{32}\.(mp3|m4a|ogg|wav)$/;
// Bundled demo placeholders (dev/guide.sample.json, `?demo=1` only):
// a relative path to a flat SVG, slug filename, nothing else.
const DEMO_PLACEHOLDER_RE = /^dev\/placeholders\/[a-z0-9-]+\.svg$/;

/**
 * A url is safe to interpolate into `url("...")` (or assign as `src`) only
 * if it is either an https:// url with none of the characters that could
 * break out of a `url("...")` wrapper (demo data still points at https://
 * hosts), or a same-origin relative media url served by our own backend
 * under `/media/images/<hex>.jpg`, or a bundled demo placeholder
 * `dev/placeholders/<slug>.svg`.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isSafeImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (SAFE_IMAGE_PATH_RE.test(url) || DEMO_PLACEHOLDER_RE.test(url)) return true;
  if (!url.startsWith("https://")) return false;
  return !/["\\)\n\r]/.test(url);
}

/**
 * Same idea as `isSafeImageUrl`, for audio `src` assignment: either a
 * same-origin `/media/audio/<hex>.<mp3|m4a|ogg|wav>` path, or an https://
 * url (demo data) free of characters that could be abused if ever
 * interpolated into markup/CSS.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isSafeAudioUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (SAFE_AUDIO_PATH_RE.test(url)) return true;
  if (!url.startsWith("https://")) return false;
  return !/["\\)\n\r]/.test(url);
}

/**
 * Apply a background-image to a node, but only after validating the URL.
 * @param {HTMLElement} node
 * @param {string|null|undefined} url
 */
export function setSafeBackgroundImage(node, url) {
  node.style.backgroundImage = isSafeImageUrl(url) ? `url("${url}")` : "";
}

/**
 * Reference a symbol from the inline SVG sprite in index.html.
 * @param {string} name symbol id without the "i-" prefix
 * @param {string} [extraClass]
 * @returns {SVGSVGElement}
 */
export function icon(name, extraClass) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", extraClass ? `i ${extraClass}` : "i");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

let toastRoot = null;

/**
 * Show a transient, auto-dismissing toast — the app's replacement for a
 * blocking alert dialog, which is never used.
 * @param {string} message
 * @param {"info"|"error"|"success"} [kind]
 */
export function toast(message, kind = "info") {
  if (!toastRoot) {
    toastRoot = el("div", { class: "toast-root", "aria-live": "polite", role: "status" });
    document.body.appendChild(toastRoot);
  }
  const node = el("div", { class: `toast toast-${kind}` }, message);
  toastRoot.appendChild(node);
  requestAnimationFrame(() => node.classList.add("visible"));
  setTimeout(() => {
    node.classList.remove("visible");
    setTimeout(() => node.remove(), 250);
  }, 4000);
}

/**
 * Announce a status message in the page's polite live region (for screen
 * readers), without popping up a toast.
 * @param {string} message
 */
export function announce(message) {
  const region = document.getElementById("liveRegion");
  if (region) region.textContent = message;
}
