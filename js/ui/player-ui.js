// @ts-check
/**
 * Mini-player docked above the tab bar: play/pause, title, time, seek bar,
 * queued-next chip and the "tap to listen" state when autoplay was blocked.
 */
import * as player from "../player.js";
import { formatTime } from "../format.js";

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @type {() => ({title: string, sub: string}|null)} */
let getMeta = () => null;
/** @type {(visible: boolean) => void} */
let onVisibility = () => {};
let wasVisible = false;

/**
 * @param {() => ({title: string, sub: string}|null)} metaGetter
 * @param {(visible: boolean) => void} [visibilityChanged]
 */
export function wirePlayerUI(metaGetter, visibilityChanged) {
  getMeta = metaGetter;
  if (visibilityChanged) onVisibility = visibilityChanged;
  $("playerPlayBtn").addEventListener("click", () => player.togglePlayPause());
  $("playerCloseBtn").addEventListener("click", () => player.stop());
  $("playerUnlockBtn").addEventListener("click", () => player.resume());

  const seekBar = $("playerSeekBar");
  let dragging = false;
  /** @param {PointerEvent} e */
  const ratioFromEvent = e => {
    const rect = seekBar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  seekBar.addEventListener("pointerdown", e => {
    dragging = true;
    seekBar.setPointerCapture(e.pointerId);
    player.seekTo(ratioFromEvent(e) * (player.getState().duration || 0));
  });
  seekBar.addEventListener("pointermove", e => {
    if (!dragging) return;
    player.seekTo(ratioFromEvent(e) * (player.getState().duration || 0));
  });
  seekBar.addEventListener("pointerup", () => { dragging = false; });
  seekBar.addEventListener("keydown", e => {
    if (e.key === "ArrowRight") { player.seekBy(5); e.preventDefault(); }
    if (e.key === "ArrowLeft") { player.seekBy(-5); e.preventDefault(); }
  });

  player.subscribe(renderPlayer);
}

/** @param {import('../player.js').PlayerState} p */
function renderPlayer(p) {
  const mini = $("miniplayer");
  const hasTrack = !!p.pointId;
  mini.classList.toggle("visible", hasTrack);
  document.body.classList.toggle("has-player", hasTrack);
  if (hasTrack !== wasVisible) {
    wasVisible = hasTrack;
    onVisibility(hasTrack);
  }
  if (!hasTrack) return;

  const meta = getMeta();
  $("playerTitle").textContent = meta?.title || "";
  $("playerSub").textContent = meta?.sub || "";

  const nextChip = $("playerNextChip");
  nextChip.hidden = !p.queuedNextTitle;
  nextChip.textContent = p.queuedNextTitle ? `Далее: ${p.queuedNextTitle}` : "";

  const playBtn = $("playerPlayBtn");
  playBtn.querySelector(".icon-play").toggleAttribute("hidden", p.playing);
  playBtn.querySelector(".icon-pause").toggleAttribute("hidden", !p.playing);
  playBtn.setAttribute("aria-label", p.playing ? "Пауза" : "Воспроизвести");

  $("playerUnlockBtn").hidden = !p.blockedByAutoplay;
  playBtn.hidden = p.blockedByAutoplay;
  $("playerProgressWrap").hidden = p.blockedByAutoplay;

  const ratio = p.duration ? Math.min(1, p.currentTime / p.duration) : 0;
  $("playerFill").style.transform = `scaleX(${ratio})`;
  const seek = $("playerSeekBar");
  seek.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  seek.setAttribute("aria-valuetext", `${formatTime(p.currentTime)} из ${formatTime(p.duration)}`);
  $("playerTimeCurrent").textContent = formatTime(p.currentTime);
  $("playerTimeDuration").textContent = formatTime(p.duration);
}
