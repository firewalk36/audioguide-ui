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

/**
 * A url is safe to interpolate into `url("...")` only if it is https and
 * contains none of the characters that could break out of the wrapper.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isSafeImageUrl(url) {
  if (!url || typeof url !== "string") return false;
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
