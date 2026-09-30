// @ts-check
/**
 * Central, static configuration for the audio guide app.
 * Nothing here touches `window`/`document`, so this module is safe to
 * import from a plain Node script (e.g. tests) as well as the browser.
 */

/**
 * @typedef {Object} GeoConfig
 * @property {number} maxAccuracyM - fixes less accurate than this are ignored for triggering
 * @property {PositionOptions} watchOptions - options passed to watchPosition
 * @property {number} hysteresisFactor - multiplier applied to trigger_radius_m to compute the release distance
 * @property {number} hysteresisExtraM - flat metres added on top of the hysteresis factor
 */

/**
 * @typedef {Object} AudioConfig
 * @property {string} silentDataUri - tiny silent mp3 used to unlock autoplay inside a user gesture
 */

/**
 * @typedef {Object} AppConfig
 * @property {string} apiBase
 * @property {string} yandexApiKey
 * @property {[number, number]} mapCenter
 * @property {number} mapZoom
 * @property {GeoConfig} geo
 * @property {AudioConfig} audio
 */

/** @type {AppConfig} */
export const CONFIG = {
  apiBase: "/api/v1",
  yandexApiKey: "6d7f4f22-9bbd-4199-aad9-bd5e0053d7a3",
  mapCenter: [56.326887, 44.005986],
  mapZoom: 13,
  geo: {
    maxAccuracyM: 60,
    watchOptions: { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    hysteresisFactor: 1.5,
    hysteresisExtraM: 10
  },
  audio: {
    // ~0.1s of silence, valid MP3, generated with ffmpeg (anullsrc -> libmp3lame).
    silentDataUri:
      "data:audio/mpeg;base64,SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYzLjEuMTAxAAAAAAAAAAAAAAD/4zjAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAAB+ACSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpK2tra2tra2tra2tra2tra2tra2tra2tra229vb29vb29vb29vb29vb29vb29vb29vb2/////////////////////////////////8AAAAATGF2YzYzLjEuAAAAAAAAAAAAAAAAJAOgAAAAAAAAAfhBGrwSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/4xjEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/4xjEOwAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/4xjEdgAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/4xjEsQAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU="
  }
};
