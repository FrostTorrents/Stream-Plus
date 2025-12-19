// background.js (Chrome Extension - Service Worker)

chrome.runtime.onInstalled.addListener(() => {
  console.log("Plex Smart Skipper installed.");

  // Defaults (sync so they follow the user)
  chrome.storage.sync.set({
    perShowRules: {},
    globalEnabled: true,
    skipDelayMs: 500,
    volumeLevel: 50,
    muteInsteadOfPause: false,
    dimScreen: true,
    countdownVisible: true,
    episodeGuard: {
      enabled: false,
      maxEpisodes: 3,
      watchedCount: 0,
      lastWatched: null
    },
    sleepTimer: {
      active: false,
      minutesLeft: 0,
      fadeVolume: true
    }
  });
});

// Message bus for popup/content
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getSettings") {
    chrome.storage.sync.get(null, sendResponse);
    return true;
  }

  if (message.type === "updateSetting") {
    chrome.storage.sync.set({ [message.key]: message.value }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "incrementWatchedCount") {
    chrome.storage.sync.get("episodeGuard", ({ episodeGuard }) => {
      episodeGuard = episodeGuard || { enabled: false, maxEpisodes: 3, watchedCount: 0, lastWatched: null };
      episodeGuard.watchedCount += 1;
      episodeGuard.lastWatched = Date.now();
      chrome.storage.sync.set({ episodeGuard }, () => {
        sendResponse({ success: true, updated: episodeGuard });
      });
    });
    return true;
  }

  if (message.type === "resetWatchedCount") {
    chrome.storage.sync.get("episodeGuard", ({ episodeGuard }) => {
      episodeGuard = episodeGuard || { enabled: false, maxEpisodes: 3, watchedCount: 0, lastWatched: null };
      episodeGuard.watchedCount = 0;
      chrome.storage.sync.set({ episodeGuard }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }
});
