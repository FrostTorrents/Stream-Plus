// background.js — Stream Plus (MV3)
// Purpose:
// • Set sane defaults without clobbering existing user settings
// • Provide a small message bridge (optional; content script handles most runtime logic)

const DEFAULTS = {
  // legacy/global
  globalEnabled: true,
  skipDelayMs: 500,
  volumeLevel: 50,
  muteInsteadOfPause: false,
  dimScreen: true,
  countdownVisible: false,

  // per-series rules: { [seriesKey]: { skipIntro, skipCredits, skipNext, ... } }
  perShowRules: {},

  // episode guard (legacy)
  episodeGuard: { enabled: false, maxEpisodes: 3, watchedCount: 0, lastWatched: null },

  // beta bundle (new)
  beta: {
    enabled: false,

    // playback helpers
    wakeLock: false,
    pauseOnHidden: false,
    pauseOnHiddenSec: 10,
    autoFullscreen: false,

    // timer helpers
    autoStartTimerOnPlay: false,
    autoStartTimerMinutes: 30,
    fadeBeforeTimerEnd: true,
    fadeSeconds: 20,

    // player prefs
    rememberSpeed: true,
    defaultSpeed: 1.0,
    subtitlesDefault: "auto", // auto | on | off

    // prompts
    autoContinueWatching: true
  }
};

async function getSync(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}
async function setSync(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, resolve));
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  try {
    const existing = await getSync(Object.keys(DEFAULTS));
    const toSet = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (typeof existing[k] === "undefined") toSet[k] = v;
      // merge beta object if partial
      if (k === "beta") {
        const cur = existing.beta || {};
        toSet.beta = { ...DEFAULTS.beta, ...cur };
      }
    }
    if (Object.keys(toSet).length) await setSync(toSet);
    console.log("Stream Plus defaults ensured.", { reason, toSetKeys: Object.keys(toSet) });
  } catch (e) {
    console.warn("Stream Plus onInstalled failed", e);
  }
});

// Optional: let popup query version quickly
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "bg:version") {
    sendResponse({ version: chrome.runtime.getManifest().version });
    return;
  }
});
