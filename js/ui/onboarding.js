// @ts-check
/**
 * First run: three steps explaining route → geolocation → Автозвук.
 * Shown once per browser (localStorage flag), reopenable from Настройки.
 * It never asks for permissions itself — those come in context, from
 * "Начать маршрут" / "Где я?" / Автозвук.
 */
import { pushLayer, popLayer, trapFocus } from "./layers.js";

const FLAG_KEY = "ag_onboarded";

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @type {HTMLElement|null} */
let previouslyFocused = null;

/**
 * @param {{ onRoutes: () => void, onMap: () => void }} actions
 */
export function wireOnboarding(actions) {
  const root = $("onboarding");
  root.addEventListener("keydown", e => trapFocus(e, root, () => closeOnboarding()));
  $("onboardingStartBtn").addEventListener("click", () => { closeOnboarding(); actions.onRoutes(); });
  $("onboardingMapBtn").addEventListener("click", () => { closeOnboarding(); actions.onMap(); });
}

export function shouldShowOnboarding() {
  try {
    return localStorage.getItem(FLAG_KEY) !== "1";
  } catch {
    return false; // storage blocked: don't nag on every visit
  }
}

export function showOnboarding() {
  const root = $("onboarding");
  previouslyFocused = /** @type {HTMLElement} */ (document.activeElement);
  root.hidden = false;
  document.body.classList.add("no-scroll");
  pushLayer("onboarding", hideOnboarding);
  // Focus the dialog itself so screen readers start at the title and no
  // focus ring sits on the primary button before the visitor has done anything.
  root.focus();
}

function hideOnboarding() {
  const root = $("onboarding");
  if (root.hidden) return;
  root.hidden = true;
  document.body.classList.remove("no-scroll");
  try { localStorage.setItem(FLAG_KEY, "1"); } catch { /* best effort */ }
  previouslyFocused?.focus?.();
}

export function closeOnboarding() {
  popLayer("onboarding");
  hideOnboarding();
}
