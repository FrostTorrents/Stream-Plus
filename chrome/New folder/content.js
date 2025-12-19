// content.js — overlay + sleep timer + skipper bootstrap + series key publisher
// • Player-context gate: no automation on playlist/library pages
// • All chrome.runtime calls guarded (prevents "Extension context invalidated" errors)
// • Overlay is draggable + resizable with persisted position/size/opacity
// • Timer only counts down while the video is playing (auto-pauses/resumes with playback)

let settings = {};
let currentSeriesTitle = '';
let fadeInterval = null;
let originalVolume = 1;
let remainingSeconds = 0;
let timerInterval = null;       // ticking loop
let timerSuspended = false;     // true when video is paused/ended
let videoEventsBound = false;   // ensure we bind once
let playerContext = false;      // true only when we detect a real player

const fadeVolumeStep = 5; // 5% every 30s in final minutes
const IS_TOP = window.top === window;

/* -------------------- Runtime guards -------------------- */
function safeRuntime() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
}
function safeSendMessage(msg) {
  return new Promise((resolve) => {
    if (!safeRuntime()) return resolve(undefined);
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(res));
    } catch (_) {
      resolve(undefined);
    }
  });
}
function safeGetURL(path) {
  if (!safeRuntime()) return null;
  try { return chrome.runtime.getURL(path); } catch (_) { return null; }
}

/* -------------------- Boot -------------------- */
(async function init() {
  settings = await getSettings();

  // Decide initial context
  playerContext = detectPlayerContext();

  if (IS_TOP) {
    currentSeriesTitle = resolveSeriesTitle();
    publishActiveSeries(currentSeriesTitle);

    if (settings.countdownVisible) {
      await ensureOverlayVisible();
    }

    // Always watch for video presence (auto-start when it appears)
    watchVideoPresence();

    // Wire to current <video> (and any future swaps)
    bindVideoEventsOnce();

    handleEpisodeGuard();

    // Start skippers only if we're in player right now (watcher will catch later cases)
    if (playerContext) startSkippersWhenReady();

    watchSeriesChanges();
    watchRouteChanges(); // update playerContext as SPA hash/route changes
  } else {
    // Iframe: resolve series + start skippers as soon as we see a video
    currentSeriesTitle = (await waitForActiveSeriesTitle(60, 200)) || 'Unknown Series';

    // Watch for video presence in the iframe (more reliable than route checks)
    watchVideoPresence();

    // If a video is already here, bind & start now
    if (detectPlayerContext()) {
      bindVideoEventsOnce();
      startSkippersWhenReady();
    }
  }

  // Popup -> content control (ensure overlay is visible first for timer ops)
  if (safeRuntime()) {
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!IS_TOP) return; // overlay lives in top frame
        if (!msg?.type) return;

        if (msg.type === 'overlay:toggle') {
          if (msg.show) ensureOverlayVisible();
          else removeOverlay();
        } else if (msg.type === 'timer:add') {
          ensureOverlayVisible().then(() => startOrExtendTimer((Number(msg.minutes) || 0) * 60));
        } else if (msg.type === 'timer:sub') {
          ensureOverlayVisible().then(() => {
            remainingSeconds = Math.max(0, remainingSeconds - ((Number(msg.minutes) || 10) * 60));
            updateDisplay();
          });
        } else if (msg.type === 'timer:cancel') {
          ensureOverlayVisible().then(() => stopTimer());
        }
      });
    } catch (_) { /* ignore */ }
  }

  // Storage changes (defensive)
  if (safeRuntime()) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        Object.keys(changes).forEach(k => (settings[k] = changes[k].newValue));

        if (IS_TOP && Object.prototype.hasOwnProperty.call(changes, 'countdownVisible')) {
          changes.countdownVisible.newValue ? ensureOverlayVisible() : removeOverlay();
        }

        // Only forward into skippers in real player contexts
        if (!playerContext) return;
        if (typeof window.updateSkipperSettings === 'function') window.updateSkipperSettings(settings, currentSeriesTitle);
        if (typeof window.updateOutroSettings === 'function') window.updateOutroSettings(settings, currentSeriesTitle);
        if (typeof window.updateNextSettings === 'function') window.updateNextSettings(settings, currentSeriesTitle);
      });
    } catch (_) { /* ignore */ }
  }

  // Pause timer when tab not visible (extra safety)
  document.addEventListener('visibilitychange', () => {
    timerSuspended = (document.visibilityState !== 'visible') || !isVideoPlaying();
  });
})();

/* -------------------- Context / route detection -------------------- */

function detectPlayerContext() {
  // In IFRAMEs: if there's a <video>, that *is* the player context.
  if (!IS_TOP) {
    return !!document.querySelector('video');
  }

  // In TOP: be a bit cautious but not blocking.
  const hasVideo = !!document.querySelector('video');

  // Common player chrome selectors
  const hasControls =
    document.querySelector('[data-testid="player"]') ||
    document.querySelector('.PlayerControls-container') ||
    document.querySelector('[class*="PlayerControls"]') ||
    document.querySelector('button[aria-label="Play"],button[aria-label="Pause"]');

  // Hash-based hints (Plex SPA routes vary, include more variants)
  const hash = (location.hash || '').toLowerCase();
  const looksLikePlayerRoute =
    hash.includes('/player') ||
    hash.includes('/watch') ||
    hash.includes('/media/') ||      // when navigating directly to media
    hash.includes('/playback');      // some skins

  // TOP frame: allow if video exists OR route strongly suggests player
  return !!(hasVideo || looksLikePlayerRoute || hasControls);
}

function watchVideoPresence() {
  // Start skippers immediately if a <video> is present
  const tryStart = () => {
    const hasVid = !!document.querySelector('video');
    const was = playerContext;
    playerContext = detectPlayerContext();

    if (hasVid && playerContext) {
      // (Re)bind video listeners and (re)start skippers
      bindVideoEventsOnce();
      startSkippersWhenReady();
    }

    // Debug logs for diagnosis
    if (was !== playerContext) {
      console.debug('[SmartSkipper] playerContext changed →', playerContext, { IS_TOP, hasVid });
    }
  };

  // Initial attempt
  tryStart();

  // Observe DOM for a new <video>
  const mo = new MutationObserver(() => {
    if (document.querySelector('video')) {
      tryStart();
    }
  });
  mo.observe(document.body || document.documentElement, { childList: true, subtree: true });

  // Also poll a bit (Plex sometimes swaps deep inside shadow roots)
  const poll = setInterval(() => {
    tryStart();
  }, 1200);

  // Stop polling if we stayed in player context for a while
  setTimeout(() => clearInterval(poll), 30000);
}

function watchRouteChanges() {
  let lastHash = location.hash;
  const check = () => {
    if (location.hash !== lastHash) {
      lastHash = location.hash;
      const was = playerContext;
      playerContext = detectPlayerContext();
      if (was !== playerContext) {
        if (playerContext) {
          // We entered a player: bind (again) and start skippers if needed
          bindVideoEventsOnce();
          startSkippersWhenReady();
        } else {
          // We left the player: stop timer clicking + don't invoke skippers
          // (Skipper modules should also check playerContext guards if they run.)
        }
      }
    }
  };
  window.addEventListener('hashchange', check);
  // Plex is SPA; also poll a bit in case it manipulates history
  setInterval(check, 1000);
}

/* -------------------- Skippers (only in player) -------------------- */

function startSkippersWhenReady() {
  if (!playerContext) return; // hard gate

  waitFor(() => typeof window.initSkipper === 'function', 40, 120)
    .then(ok => {
      if (ok) {
        console.debug('[SmartSkipper] initSkipper →', { frame: IS_TOP ? 'top' : 'iframe', series: currentSeriesTitle });
        window.initSkipper(settings, currentSeriesTitle);
      }
    });

  waitFor(() => typeof window.initOutroSkipper === 'function', 40, 120)
    .then(ok => {
      if (ok) {
        console.debug('[SmartSkipper] initOutroSkipper →', { frame: IS_TOP ? 'top' : 'iframe', series: currentSeriesTitle });
        window.initOutroSkipper(settings, currentSeriesTitle);
      }
    });

  waitFor(() => typeof window.initNextSkipper === 'function', 40, 120)
    .then(ok => {
      if (ok) {
        console.debug('[SmartSkipper] initNextSkipper →', { frame: IS_TOP ? 'top' : 'iframe', series: currentSeriesTitle });
        window.initNextSkipper(settings, currentSeriesTitle);
      }
    });
}

function waitFor(predicate, retries = 30, delay = 150) {
  return new Promise(resolve => {
    const t = setInterval(() => {
      if (predicate()) { clearInterval(t); resolve(true); }
      else if (--retries <= 0) { clearInterval(t); resolve(false); }
    }, delay);
  });
}

async function waitForActiveSeriesTitle(retries = 60, delay = 200) {
  for (let i = 0; i < retries; i++) {
    const v = await readActiveSeriesFromLocal();
    if (v) return v;
    await new Promise(r => setTimeout(r, delay));
  }
  return null;
}

/* -------------------- Frame/series helpers -------------------- */

function readActiveSeriesFromLocal() {
  return new Promise(resolve => {
    if (!safeRuntime()) return resolve(null);
    chrome.storage.local.get(['activeSeriesTitle'], ({ activeSeriesTitle }) => resolve(activeSeriesTitle || null));
  });
}

function publishActiveSeries(title) {
  const canonical = canonicalizeSeriesTitle(title);
  const key = normalizeTitle(canonical);
  if (!safeRuntime()) return;
  try {
    chrome.storage.local.set({ activeSeriesTitle: canonical, activeSeriesKey: key, activeSeriesUpdatedAt: Date.now() });
  } catch (_) { /* ignore */ }
}

function normalizeTitle(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s]+/gu, '').trim();
}

function canonicalizeSeriesTitle(s) {
  let t = (s || '').trim();
  t = t.replace(/\s*[-–—]\s*S\d+\s*[·x×]?\s*E\d+\s*$/i, '');
  t = t.replace(/\s*\(\s*S\d+\s*[·x×]?\s*E\d+\s*\)\s*$/i, '');
  t = t.replace(/\s*\bS(?:eason)?\s*\d+\s*[·x×.]?\s*E(?:pisode)?\s*\d+\b.*$/i, '');
  t = t.replace(/\s*\bS\d+\s*E\d+\b.*$/i, '');
  t = t.replace(/\s*[-–—]\s*Season\s*\d+\s*Episode\s*\d+\s*$/i, '');
  t = t.replace(/\s*\bSeason\s*\d+\s*Episode\s*\d+\b.*$/i, '');
  return t.trim();
}

function watchSeriesChanges() {
  let last = currentSeriesTitle;
  const check = () => {
    const now = resolveSeriesTitle();
    if (now && now !== last) {
      last = now;
      currentSeriesTitle = now;
      publishActiveSeries(now);
      if (!playerContext) return;
      if (typeof window.updateSkipperSettings === 'function') window.updateSkipperSettings(settings, currentSeriesTitle);
      if (typeof window.updateOutroSettings === 'function') window.updateOutroSettings(settings, currentSeriesTitle);
      if (typeof window.updateNextSettings === 'function') window.updateNextSettings(settings, currentSeriesTitle);
    }
  };
  const mo = new MutationObserver(check);
  mo.observe(document, { childList: true, subtree: true });
  setInterval(check, 1500);
}

function getSettings() {
  return safeSendMessage({ type: 'getSettings' }).then(v => v || {});
}

function resolveSeriesTitle() {
  const el =
    document.querySelector('[data-qa-id="metadataGrandparentTitle"]') ||
    document.querySelector('[data-testid="metadataGrandparentTitle"]') ||
    document.querySelector('.PrePlayTitle .grandparent-title') ||
    document.querySelector('[data-testid="metadata-title"]');
  let raw = el?.textContent?.trim();
  if (!raw || raw.length < 2) raw = (document.title || '').replace(/\s+-\s*Plex.*/i, '').trim();
  return canonicalizeSeriesTitle(raw || 'Unknown Series');
}

/* -------------------- Video helpers (drive timer with playback) -------------------- */

function getVideo() {
  return document.querySelector('video');
}

function isVideoPlaying() {
  const v = getVideo();
  return !!(v && !v.paused && !v.ended && v.readyState > 2);
}

function bindVideoEventsOnce() {
  if (videoEventsBound) return;
  const v = getVideo();
  if (!v) return;

  videoEventsBound = true;
  v.addEventListener('play', onVideoPlay, { passive: true });
  v.addEventListener('pause', onVideoPause, { passive: true });
  v.addEventListener('ended', onVideoEnded, { passive: true });

  // Re-bind if Plex swaps the <video>
  const mo = new MutationObserver(() => {
    const nv = getVideo();
    if (nv && !nv.__spBound) {
      nv.__spBound = true;
      nv.addEventListener('play', onVideoPlay, { passive: true });
      nv.addEventListener('pause', onVideoPause, { passive: true });
      nv.addEventListener('ended', onVideoEnded, { passive: true });
    }
  });
  mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

function onVideoPlay() {
  timerSuspended = false;
  if (remainingSeconds > 0 && !timerInterval) startOrExtendTimer(0);
}

function onVideoPause() {
  timerSuspended = true;
}

function onVideoEnded() {
  timerSuspended = true;
  // Optional: stopTimer();
}

/* -------------------- Overlay + Timer -------------------- */

async function ensureOverlayVisible() {
  let overlay = document.getElementById('overlay');
  if (!overlay) {
    await injectOverlay();
    overlay = document.getElementById('overlay');
    bindOverlayControls();
  }
  if (overlay) overlay.style.display = 'inline-flex';
  return overlay;
}

function removeOverlay() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.remove();
  stopTimer();
}

async function injectOverlay() {
  try {
    const url = safeGetURL('overlay.html');
    if (!url) return;
    const res = await fetch(url);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const overlayTemplate = doc.querySelector('#overlay');
    if (!overlayTemplate) return;

    const overlay = overlayTemplate.cloneNode(true);
    overlay.id = 'overlay';
    overlay.style.position = 'fixed';
    overlay.style.zIndex = '2147483647';
    overlay.style.display = 'inline-flex';
    overlay.style.alignItems = 'center';
    overlay.style.transformOrigin = 'left top';
    overlay.style.maxWidth = 'calc(100vw - 16px)';
    overlay.style.maxHeight = '96px';
    overlay.style.boxSizing = 'border-box';
    overlay.style.userSelect = 'none';
    overlay.style.touchAction = 'none';
    overlay.style.cursor = 'move';
    overlay.style.left = overlay.style.left || '20px';
    overlay.style.top  = overlay.style.top  || '20px';
    overlay.style.pointerEvents = 'auto';
    overlay.style.borderRadius = overlay.style.borderRadius || '18px';

    // Resize handle ▣
    const handle = document.createElement('div');
    handle.id = 'overlayResizeHandle';
    Object.assign(handle.style, {
      position: 'absolute',
      right: '8px',
      top: '50%',
      transform: 'translateY(-50%)',
      width: '14px',
      height: '14px',
      borderRadius: '4px',
      background: 'rgba(255,255,255,0.14)',
      border: '1px solid rgba(255,255,255,0.3)',
      cursor: 'ew-resize',
      pointerEvents: 'auto'
    });
    handle.title = 'Drag to resize';
    overlay.appendChild(handle);

    document.body.appendChild(overlay);

    // Restore persisted state
    const state = await loadOverlayState();
    applyOverlayState(overlay, state);

    // Base width for scaling math
    const rect = overlay.getBoundingClientRect();
    const scale = state.scale || 1;
    overlay.dataset.baseW = String(rect.width / scale);
    overlay.dataset.baseH = String(rect.height / scale);

    clampOverlay(overlay);
  } catch (e) {
    console.warn('[SmartSkipper] Overlay injection failed:', e);
  }
}

function bindOverlayControls() {
  const overlay = document.getElementById('overlay');
  const timerDisplay = document.getElementById('timerDisplay');
  if (!overlay || !timerDisplay) return;

  overlay.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.add) {
      startOrExtendTimer(parseInt(t.dataset.add, 10) * 60);
    } else if (t.dataset.sub) {
      remainingSeconds = Math.max(0, remainingSeconds - 600);
      updateDisplay();
    } else if (t.id === 'cancelTimer') {
      stopTimer();
    }
  });

  // Opacity via Shift + wheel (persist)
  const saveOpacityDebounced = debounce(() => saveOverlayState(getOverlayStateSync()), 250);
  document.addEventListener('wheel', (e) => {
    const overlayNow = document.getElementById('overlay');
    if (!overlayNow) return;
    if (!e.shiftKey) return;
    e.preventDefault();
    const current = parseFloat(getComputedStyle(overlayNow).opacity) || 1;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    overlayNow.style.opacity = String(Math.max(0.1, Math.min(1, current + delta)));
    saveOpacityDebounced();
  }, { passive: false });

  // Dragging (persist)
  let dragging = false, ox = 0, oy = 0;
  overlay.addEventListener('mousedown', (e) => {
    if (e.target && e.target.id === 'overlayResizeHandle') return;
    dragging = true;
    const rect = overlay.getBoundingClientRect();
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
    overlay.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    overlay.style.cursor = 'move';
    saveOverlayState(getOverlayStateSync());
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = e.clientX - ox;
    const y = e.clientY - oy;
    setOverlayPositionClamped(overlay, x, y);
  });

  // Resizing with handle (persist)
  const handle = document.getElementById('overlayResizeHandle');
  let resizing = false;
  let startX = 0;
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    resizing = true;
    startX = e.clientX;
    overlay.style.cursor = 'ew-resize';
    e.preventDefault();
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    overlay.style.cursor = 'move';
    clampOverlay(overlay);
    saveOverlayState(getOverlayStateSync());
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const baseW = parseFloat(overlay.dataset.baseW || '340');
    const currentRect = overlay.getBoundingClientRect();
    const desiredW = Math.max(220, currentRect.width + (e.clientX - startX));
    startX = e.clientX;
    let newScale = desiredW / baseW;
    newScale = Math.max(0.6, Math.min(2.2, newScale));
    overlay.style.transform = `scale(${newScale})`;
  });

  window.addEventListener('resize', () => {
    clampOverlay(overlay);
    saveOverlayState(getOverlayStateSync());
  });

  updateDisplay();
}

/* -------------------- Overlay state (persist) -------------------- */

function getOverlayStateSync() {
  const overlay = document.getElementById('overlay');
  if (!overlay) return { left: 20, top: 20, opacity: 1, scale: 1 };
  const rect = overlay.getBoundingClientRect();
  const opacity = parseFloat(getComputedStyle(overlay).opacity) || 1;
  const scale = (() => {
    const m = /scale\(([\d.]+)\)/.exec(overlay.style.transform || '');
    return m ? parseFloat(m[1]) : 1;
  })();
  return { left: Math.round(rect.left), top: Math.round(rect.top), opacity, scale };
}

function applyOverlayState(overlay, state) {
  const s = {
    left: Number.isFinite(state.left) ? state.left : 20,
    top: Number.isFinite(state.top) ? state.top : 20,
    opacity: Number.isFinite(state.opacity) ? state.opacity : 1,
    scale: Number.isFinite(state.scale) ? state.scale : 1
  };
  overlay.style.left = `${s.left}px`;
  overlay.style.top = `${s.top}px`;
  overlay.style.opacity = String(Math.max(0.1, Math.min(1, s.opacity)));
  overlay.style.transformOrigin = 'left top';
  overlay.style.transform = `scale(${Math.max(0.6, Math.min(2.2, s.scale))})`;
  clampOverlay(overlay);
}

function loadOverlayState() {
  return new Promise(resolve => {
    if (!safeRuntime()) return resolve({ left: 20, top: 20, opacity: 1, scale: 1 });
    chrome.storage.local.get(['overlayState'], ({ overlayState }) => {
      resolve(overlayState || { left: 20, top: 20, opacity: 1, scale: 1 });
    });
  });
}
function saveOverlayState(state) {
  if (!safeRuntime()) return;
  chrome.storage.local.set({ overlayState: state || getOverlayStateSync() });
}

function setOverlayPositionClamped(overlay, x, y) {
  const rect = overlay.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const margin = 8;
  const maxLeft = (window.innerWidth  - w - margin);
  const maxTop  = (window.innerHeight - h - margin);
  const cl = Math.max(margin, Math.min(maxLeft, x));
  const ct = Math.max(margin, Math.min(maxTop, y));
  overlay.style.left = `${cl}px`;
  overlay.style.top  = `${ct}px`;
}

function clampOverlay(overlay) {
  const rect = overlay.getBoundingClientRect();
  setOverlayPositionClamped(overlay, rect.left, rect.top);
}

/* -------------------- Timer core (only tick while playing) -------------------- */

function startOrExtendTimer(deltaSeconds) {
  bindVideoEventsOnce();

  remainingSeconds += deltaSeconds;
  if (remainingSeconds < 0) remainingSeconds = 0;
  updateDisplay();

  if (!timerInterval) {
    timerInterval = setInterval(() => {
      if (timerSuspended || !isVideoPlaying()) return;
      remainingSeconds--;
      updateDisplay();

      if (remainingSeconds <= 180 && !fadeInterval && settings?.sleepTimer?.fadeVolume) {
        startFadeVolume();
      }

      if (remainingSeconds <= 0) {
        handleTimerEnd();
        stopTimer();
      }
    }, 1000);
  }
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  clearInterval(fadeInterval);
  fadeInterval = null;
  remainingSeconds = 0;
  updateDisplay();
}

function updateDisplay() {
  const timerDisplay = document.getElementById('timerDisplay');
  if (!timerDisplay) return;
  const m = Math.floor(remainingSeconds / 60);
  const s = remainingSeconds % 60;
  timerDisplay.textContent = `⏳ ${m}:${String(s).padStart(2, '0')}`;
}

/* -------------------- Fade to Sleep -------------------- */

function startFadeVolume() {
  const video = getVideo();
  if (!video) return;
  originalVolume = video.volume;

  fadeInterval = setInterval(() => {
    const v = getVideo();
    if (!v || remainingSeconds <= 0 || v.volume <= 0.05) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      return;
    }
    v.volume = Math.max(0, v.volume - (fadeVolumeStep / 100));
  }, 30000);
}

/* -------------------- Timer end behavior -------------------- */

function handleTimerEnd() {
  const video = getVideo();
  if (video) {
    if (settings.muteInsteadOfPause) video.muted = true;
    else { try { video.pause(); } catch {} }
    try { video.volume = originalVolume; } catch {}
  }
  if (settings.dimScreen) {
    document.documentElement.classList.add('dimmed');
    document.body.classList.add('dimmed');
  }
}

/* -------------------- Episode Guard -------------------- */

function handleEpisodeGuard() {
  if (!IS_TOP) return;
  const guard = settings.episodeGuard;
  if (!guard?.enabled) return;

  safeSendMessage({ type: 'incrementWatchedCount' }).then((res) => {
    const updated = res?.updated;
    if (updated && updated.watchedCount >= guard.maxEpisodes) {
      const video = getVideo();
      if (video) try { video.pause(); } catch {}
      alert('🛑 Episode Guard limit reached.');
    }
  });

  setTimeout(() => safeSendMessage({ type: 'resetWatchedCount' }), 10 * 60 * 1000);
}

/* -------------------- Utils -------------------- */

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
