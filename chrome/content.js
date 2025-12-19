// content.js — Stream Plus (redesign v5)
// Single content script: overlay + sleep timer + skippers + beta helpers.
// Runs in all frames, but only activates automations when a <video> is present.

(() => {
  if (window.__STREAM_PLUS_V5__) return;
  window.__STREAM_PLUS_V5__ = true;

  const IS_TOP = window.top === window;
  const STORAGE_KEYS = [
    "perShowRules",
    "globalEnabled",
    "skipDelayMs",
    "minAutoCooldownMs",
    "debugLogs",
    "defaultSkipIntro",
    "defaultSkipCredits",
    "defaultPlayNext",

    "countdownVisible",
    "timerEndMode",
    "timerEndReducePct",
    "dimOnTimerEnd",
    "volumeLevelPct",

    "overlayOpacity",
    "overlayAutoHide",
    "overlayAutoHideSec",
    "overlaySnapCorners",
    "overlayShowEndTime",
    "overlayShowAdd5",
    "overlayShowVideoLeft",
    "overlayShowActions",
    "overlayLocked",

    "timerEndChime",
    "timerEndChimeVolume",

    "playNextEnabled",
    "nextStartAtPct",

    "beta"
  ];

  const DEFAULTS = {
    // Global
    globalEnabled: true,
    skipDelayMs: 500,
    minAutoCooldownMs: 650,
    debugLogs: false,

    // Global defaults for new shows
    defaultSkipIntro: true,
    defaultSkipCredits: true,
    defaultPlayNext: true,

    // Sleep Timer
    countdownVisible: false, // "Show floating timer overlay"
    timerEndMode: "pause",   // pause | mute | reduce
    timerEndReducePct: 15,   // for "reduce" end mode
    dimOnTimerEnd: false,
    volumeLevelPct: 50,

    // Overlay
    overlayOpacity: 0.96,
    overlayAutoHide: true,
    overlayAutoHideSec: 6,
    overlaySnapCorners: true,
    overlayShowEndTime: true,
    overlayShowAdd5: false,
    overlayShowVideoLeft: true,
    overlayShowActions: true,
    overlayLocked: false,

    // Sounds
    timerEndChime: false,
    timerEndChimeVolume: 40,

    // Next episode
    playNextEnabled: true,
    nextStartAtPct: 80,

    // Per-show rules
    perShowRulesByKey: {}, // { [seriesKey]: { skipIntro, skipCredits, playNext } }
    disabledSeriesKeys: [],

    // Beta
    beta: {
      enabled: false,
      wakeLock: false,
      pauseOnHidden: false,
      pauseOnHiddenSec: 10,
      resumeOnVisible: false,
      autoFullscreenOnPlay: false,
      rememberSpeed: false,
      defaultSpeed: 1.0,
      subtitlesDefault: "auto", // auto|on|off
      autoClickContinueWatching: false,
      fadeBeforeEnd: false,
      fadeSeconds: 12,
      autoStartTimerOnPlay: false,
      autoStartTimerMinutes: 30
    }
  };

  const state = {
    settings: (typeof structuredClone==='function' ? structuredClone(DEFAULTS) : JSON.parse(JSON.stringify(DEFAULTS))),

    // series
    seriesKey: "unknown",
    seriesTitle: "Unknown",

    // timer
    remainingSec: 0,
    timerRunning: false,
    timerSuspended: false,
    lastTickMs: 0,

    // fade
    fadeActive: false,
    fadeStartVolume: 1,
    fadeEndsAt: 0,

    // overlay DOM
    overlayHost: null,
    overlayShadow: null,
    overlayVisible: false,

    // overlay state
    overlayMinimized: false,
    overlayScale: 1,
    overlayX: null,
    overlayY: null,
    overlayW: 360,
    overlayH: 128,

    // click cooldown
    lastAutoActionMs: 0,

    // volume restore
    _reducedAudioActive: false,
    _reducedAudioPrevVol: null,

    // timer metrics
    totalSec: 0,
    endAtMs: 0,
    userPausedTimer: false,
    timerEndedAtMs: 0,

    // playback
    wakeLock: null,
    hasAppliedSpeed: false,
    hasAutoStartedTimerThisSession: false,
    hiddenPauseTimer: null,

    // overlay refresh ticker
    overlayUiTicker: null
  };

  /* -------------------- runtime init -------------------- */

  const log = (...a) => {
    if (!state.settings.debugLogs) return;
    try { console.debug("[StreamPlus]", ...a); } catch {}
  };

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const now = () => Date.now();

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    return `${m}:${String(s).padStart(2,"0")}`;
  }

  function fmtClock(ms) {
    try {
      const d = new Date(ms);
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, "0");
      const ap = h >= 12 ? "PM" : "AM";
      h = h % 12; if (h === 0) h = 12;
      return `${h}:${m} ${ap}`;
    } catch { return "—"; }
  }

  function deepGet(obj, path, fallback) {
    try {
      const parts = path.split(".");
      let cur = obj;
      for (const p of parts) cur = cur[p];
      return cur === undefined ? fallback : cur;
    } catch { return fallback; }
  }

  function getVideo() {
    try {
      const v = document.querySelector("video");
      return v || null;
    } catch { return null; }
  }

  function isPlexPlayerContext() {
    // conservative check: only consider ourselves "player-ish" if:
    // - video exists, OR
    // - common Plex player containers exist
    if (getVideo()) return true;
    try {
      if (document.querySelector('[class*="FullPlayer"]')) return true;
      if (document.querySelector('[class*="AudioVideoPlayer"]')) return true;
      if (document.querySelector('[class*="AudioVideoUpNext"]')) return true;
      if (document.querySelector('[data-testid*="player" i]')) return true;
    } catch {}
    return false;
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(STORAGE_KEYS, (items) => {
          const merged = (typeof structuredClone==='function' ? structuredClone(DEFAULTS) : JSON.parse(JSON.stringify(DEFAULTS)));
          for (const k of STORAGE_KEYS) {
            if (items[k] !== undefined) merged[k] = items[k];
          }

          // beta nested merge
          merged.beta = Object.assign({}, DEFAULTS.beta, items.beta || {});

          state.settings = merged;
          resolve(merged);
        });
      } catch {
        state.settings = (typeof structuredClone==='function' ? structuredClone(DEFAULTS) : JSON.parse(JSON.stringify(DEFAULTS)));
        resolve(state.settings);
      }
    });
  }

  function setSync(obj) {
    try { chrome.storage.sync.set(obj); } catch {}
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [k, v] of Object.entries(changes)) {
      state.settings[k] = v.newValue;
    }
    // beta nested
    if (changes.beta) {
      state.settings.beta = Object.assign({}, DEFAULTS.beta, changes.beta.newValue || {});
    }
    applySettingsSideEffects();
    renderOverlay();
  });

  function applySettingsSideEffects() {
    // keep overlay visibility in sync when user toggles
    if (state.settings.countdownVisible) {
      setOverlayVisible(true);
    } else {
      setOverlayVisible(false);
    }
  }

  /* -------------------- series key helpers -------------------- */

  function canonicalizeSeriesTitle(s) {
    let t = (s || "").trim();
    t = t.replace(/\s*[-–—]\s*S\d+\s*[·x×]?\s*E\d+\s*$/i, "");
    t = t.replace(/\s*\(\s*S\d+\s*[·x×]?\s*E\d+\s*\)\s*$/i, "");
    t = t.replace(/\s*\bS(?:eason)?\s*\d+\s*[·x×.]?\s*E(?:pisode)?\s*\d+\b.*$/i, "");
    t = t.replace(/\s*\bS\d+\s*E\d+\b.*$/i, "");
    t = t.replace(/\s*[-–—]\s*Season\s*\d+\s*Episode\s*\d+\s*$/i, "");
    t = t.replace(/\s*\bSeason\s*\d+\s*Episode\s*\d+\b.*$/i, "");
    return t.trim();
  }

  function normalizeTitle(s) {
    return (s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N}\s]+/gu, "")
      .trim();
  }

  function seriesKeyFrom(title) {
    return normalizeTitle(canonicalizeSeriesTitle(title));
  }

  function discoverSeriesTitle() {
    // Best-effort: Plex player header usually includes title
    // We'll use document.title as fallback.
    let t = "";
    try {
      const h = document.querySelector('[class*="MetadataPosterTitle"], [class*="MetadataPosterTitle"] *');
      if (h && h.textContent) t = h.textContent.trim();
    } catch {}
    if (!t) {
      try { t = document.title || ""; } catch {}
    }
    if (!t) t = "Unknown";
    return t.trim();
  }

  function updateSeries() {
    const title = discoverSeriesTitle();
    state.seriesTitle = title;
    state.seriesKey = seriesKeyFrom(title) || "unknown";
  }

  function perShowRule() {
    const byKey = state.settings.perShowRulesByKey || {};
    const r = byKey[state.seriesKey] || null;
    if (r) return r;

    // backwards compat: perShowRules[title]
    const legacy = (state.settings.perShowRules || {})[state.seriesTitle];
    return legacy || null;
  }

  function ruleOrDefault(flag, defaultKey) {
    const r = perShowRule();
    if (r && r[flag] !== undefined) return !!r[flag];
    return !!state.settings[defaultKey];
  }

  function isAutomationEnabled() {
    return state.settings.globalEnabled !== false;
  }

  function canAutoAct() {
    if (!isAutomationEnabled()) return false;
    // Optional guard: only act when tab is active
    try {
      if (state.settings.beta?.enabled && state.settings.beta?.pauseOnHidden) {
        // unrelated; keep
      }
    } catch {}
    return true;
  }

  function bumpAutoCooldown() {
    state.lastAutoActionMs = now();
  }

  function canClickNow() {
    const cd = Number.isFinite(state.settings.minAutoCooldownMs) ? state.settings.minAutoCooldownMs : 650;
    return (now() - state.lastAutoActionMs) >= cd;
  }

  /* -------------------- overlay UI -------------------- */

  function overlayCSS() {
    return `
      :host { all: initial; }
      .wrap {
        position: fixed;
        left: 20px;
        top: 20px;
        width: var(--w, 360px);
        height: var(--h, 128px);
        transform: translate3d(var(--x, 0px), var(--y, 0px), 0) scale(var(--s, 1));
        transform-origin: top left;
        pointer-events: auto;
        z-index: 2147483647;
        opacity: var(--op, 0.96);
      }
      .card {
        width: 100%;
        height: 100%;
        border-radius: 22px;
        background: rgba(10, 12, 16, 0.66);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: 0 18px 60px rgba(0,0,0,0.55);
        color: #f7f8fa;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        overflow: hidden;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 12px 10px 12px;
      }
      .left {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1;
        min-width: 0;
      }
      .title {
        font-size: 36px;
        line-height: 1;
        font-weight: 800;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        letter-spacing: -0.01em;
      }
      .sub {
        font-size: 16px;
        opacity: 0.86;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .end {
        font-size: 14px;
        opacity: 0.72;
        margin-top: 2px;
        white-space: nowrap;
      }
      .meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .ring {
        width: 48px;
        height: 48px;
        border-radius: 999px;
        flex: 0 0 auto;
        background:
          conic-gradient(rgba(255,255,255,0.92) var(--p, 0%), rgba(255,255,255,0.16) 0);
        display: grid;
        place-items: center;
      }
      .ring::before {
        content: "";
        width: 40px;
        height: 40px;
        border-radius: 999px;
        background: rgba(0,0,0,0.25);
        border: 1px solid rgba(255,255,255,0.10);
      }
      .grip {
        width: 44px;
        height: 44px;
        border-radius: 14px;
        display: grid;
        place-items: center;
        cursor: grab;
        user-select: none;
        background: rgba(255,255,255,0.10);
        border: 1px solid rgba(255,255,255,0.10);
      }
      .grip:active { cursor: grabbing; }
      .dots {
        width: 18px;
        height: 18px;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 3px;
      }
      .dots span {
        width: 4px; height: 4px;
        border-radius: 999px;
        background: rgba(255,255,255,0.72);
      }
      .btnrow {
        display: flex;
        gap: 8px;
        padding: 0 12px 12px 12px;
        flex-wrap: wrap;
      }
      button {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.16);
        background: rgba(255,255,255,0.10);
        color: #fff;
        border-radius: 14px;
        padding: 10px 12px;
        font-weight: 700;
        cursor: pointer;
        user-select: none;
      }
      button:hover { background: rgba(255,255,255,0.16); }
      .danger { background: rgba(255,70,70,0.18); border-color: rgba(255,70,70,0.30); }
      .ghost { background: transparent; border-color: rgba(255,255,255,0.12); opacity: 0.9; }
      .small { padding: 8px 10px; font-weight: 800; }
      .tiny { padding: 6px 8px; font-weight: 800; border-radius: 12px; }
      .divider { height: 1px; background: rgba(255,255,255,0.10); margin: 0 12px; }
      .right {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .pill { border-radius: 999px; }
      .min { height: 62px; }
      .min .btnrow, .min .divider, .min .tinyrow { display: none !important; }
      .min .title { font-size: 28px; }
      .min .sub { display: none; }
      .resize {
        position: absolute;
        right: 10px;
        bottom: 10px;
        width: 20px;
        height: 20px;
        border-radius: 6px;
        cursor: nwse-resize;
        background: rgba(255,255,255,0.12);
        border: 1px solid rgba(255,255,255,0.12);
      }
      .locked .grip, .locked .resize { cursor: not-allowed; opacity: 0.55; }
      .autohide { transition: opacity 260ms ease; }
      .autohide.hidden { opacity: 0.0; pointer-events: none; }
      .videoLeft {
        font-size: 34px;
        font-weight: 800;
        margin-top: 6px;
        letter-spacing: -0.01em;
      }
    `;
  }

  function ensureOverlay() {
    if (state.overlayHost) return;

    const host = document.createElement("div");
    host.id = "sp-overlay-host";
    // keep host in DOM even when "hidden" to preserve drag state; we toggle display on wrapper
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.pointerEvents = "none";
    host.style.zIndex = "2147483647";

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = overlayCSS();

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
      <div class="card">
        <div class="row">
          <div class="grip" id="spGrip" title="Drag">
            <div class="dots" aria-hidden="true">
              <span></span><span></span><span></span>
              <span></span><span></span><span></span>
              <span></span><span></span><span></span>
            </div>
          </div>

          <div class="ring" id="spRing" title="Progress"></div>

          <div class="left">
            <div class="meta">
              <div class="title" id="spTime">No timer</div>
              <div class="sub" id="spSub">—</div>
              <div class="end" id="spEnd">Ends —</div>
              <div class="videoLeft" id="spVideoLeft" style="display:none">Episode left —</div>
            </div>
          </div>
        </div>

        <div class="btnrow">
          <button id="spAdd5" class="pill small" title="+5 minutes">+5</button>
          <button id="spAdd15">+15</button>
          <button id="spAdd30">+30</button>
          <button id="spAdd60">+60</button>
          <button id="spSub10">−10</button>
          <button id="spCancel" class="danger">Cancel</button>
        </div>

        <div class="btnrow tinyrow">
          <button id="spPause" class="ghost" title="Pause/Resume timer">⏯</button>
          <button id="spSnooze" class="ghost" title="Snooze +10m">Snooze +10</button>
          <button id="spRestoreVol" class="ghost" title="Restore volume" style="display:none">Restore vol</button>
          <button id="spToEnd" class="ghost" title="Set timer to end of episode">End</button>
          <button id="spLock" class="ghost" title="Lock/unlock overlay">🔓</button>
        </div>

        <div class="divider"></div>

        <div class="btnrow" id="spActionsRow">
          <button id="spSkipIntro" class="ghost">Intro</button>
          <button id="spSkipCredits" class="ghost">Credits</button>
          <button id="spNext" class="ghost">Next</button>
        </div>

        <div class="divider"></div>

        <div class="row" style="padding-top: 10px;">
          <div style="flex:1"></div>
          <div class="right">
            <button id="spSizeDown" class="pill tiny" title="Smaller">A−</button>
            <button id="spSizeUp" class="pill tiny" title="Larger">A+</button>
            <button id="spMin" class="pill tiny" title="Minimize">▾</button>
          </div>

          <div id="spResize" class="resize" title="Resize"></div>
        </div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);

    state.overlayHost = host;
    state.overlayShadow = shadow;

    bindOverlayControls();
    restoreOverlayPos();
    renderOverlay();
    armOverlayAutoHide();
    startOverlayTicker();
  }

  function startOverlayTicker() {
    if (state.overlayUiTicker) return;
    // Keep the overlay UI responsive even when no timer is running.
    // This is needed for "Episode left" to count down during playback.
    state.overlayUiTicker = setInterval(() => {
      try {
        if (!state.overlayHost || !state.overlayVisible) return;
        // Only refresh when we can actually compute something meaningful
        // (video time left or timer status).
        renderOverlay();
      } catch {}
    }, 500);
  }

  function stopOverlayTicker() {
    if (!state.overlayUiTicker) return;
    try { clearInterval(state.overlayUiTicker); } catch {}
    state.overlayUiTicker = null;
  }

  function setOverlayVisible(visible) {
    // Preference is stored in sync; this only controls whether we render it in this frame.
    const wants = !!visible;
    state.overlayVisible = wants;

    // Only show overlay when a video is present (prevents overlay on Plex home/library pages).
    if (wants && !getVideo()) return;

    if (!state.overlayHost && wants) ensureOverlay();
    if (!state.overlayHost) return;

    const wrap = state.overlayShadow.querySelector(".wrap");
    wrap.style.display = wants ? "block" : "none";

    if (wants) {
      renderOverlay();
      armOverlayAutoHide();
      startOverlayTicker();
    }
  }

  function renderOverlay() {
    if (!state.overlayHost) return;

    const wrap = state.overlayShadow.querySelector(".wrap");
    const ring = state.overlayShadow.getElementById("spRing");
    const t = state.overlayShadow.getElementById("spTime");
    const sub = state.overlayShadow.getElementById("spSub");
    const end = state.overlayShadow.getElementById("spEnd");
    const vid = state.overlayShadow.getElementById("spVideoLeft");
    const actionsRow = state.overlayShadow.getElementById("spActionsRow");

    wrap.classList.toggle("min", !!state.overlayMinimized);
    wrap.classList.toggle("autohide", !!state.settings.overlayAutoHide);
    wrap.classList.toggle("locked", !!state.settings.overlayLocked);

    if (actionsRow) actionsRow.style.display = (state.settings.overlayShowActions === false) ? "none" : "";

    // update lock icon text if exists
    const lockBtn = state.overlayShadow.getElementById("spLock");
    if (lockBtn) lockBtn.textContent = state.settings.overlayLocked ? "🔒" : "🔓";

    // snooze visibility
    const snoozeBtn = state.overlayShadow.getElementById("spSnooze");
    const endedRecently = state.timerEndedAtMs && (Date.now() - state.timerEndedAtMs < 120000);
    if (snoozeBtn) snoozeBtn.style.display = endedRecently ? "inline-flex" : "none";

    const restoreBtn = state.overlayShadow.getElementById("spRestoreVol");
    if (restoreBtn) restoreBtn.style.display = state._reducedAudioActive ? "inline-flex" : "none";

    // pause/resume label
    const pauseBtn = state.overlayShadow.getElementById("spPause");
    if (pauseBtn) pauseBtn.textContent = state.userPausedTimer ? "▶" : "⏸";

    if (state.timerRunning && state.remainingSec > 0.01) {
      t.textContent = fmtTime(state.remainingSec);

      const paused = state.userPausedTimer || state.timerSuspended;
      sub.textContent = paused ? "Paused" : (state.seriesTitle || "Sleep Timer");

      // end time
      if (end) {
        if (paused) {
          end.textContent = "Ends —";
        } else {
          const endAt = Date.now() + Math.max(0, state.remainingSec) * 1000;
          end.textContent = `Ends ${fmtClock(endAt)}`;
        }
        end.style.display = (state.settings.overlayShowEndTime === false) ? "none" : "";
      }

      // episode left
      if (vid) {
        if (state.settings.overlayShowVideoLeft === false) {
          vid.style.display = "none";
        } else {
          const vv = getVideo();
          if (vv && Number.isFinite(vv.duration) && vv.duration > 0) {
            vid.style.display = "";
            vid.textContent = `Episode left ${fmtTime(Math.max(0, vv.duration - (vv.currentTime || 0)))}`;
          } else {
            vid.style.display = "none";
          }
        }
      }

      // progress ring
      const total = Math.max(1, state.totalSec || 0, state.remainingSec);
      const p = clamp(1 - (state.remainingSec / total), 0, 1);
      ring.style.setProperty("--p", `${Math.floor(p * 100)}%`);

      // +5 visibility
      const add5 = state.overlayShadow.getElementById("spAdd5");
      if (add5) add5.style.display = state.settings.overlayShowAdd5 ? "" : "none";
    } else {
      // no timer
      t.textContent = "No timer";
      sub.textContent = "—";

      if (end) {
        end.textContent = "Ends —";
        end.style.display = (state.settings.overlayShowEndTime === false) ? "none" : "";
      }

      // episode left still useful when no timer
      if (vid) {
        if (state.settings.overlayShowVideoLeft === false) {
          vid.style.display = "none";
        } else {
          const vv = getVideo();
          if (vv && Number.isFinite(vv.duration) && vv.duration > 0) {
            vid.style.display = "";
            vid.textContent = `Episode left ${fmtTime(Math.max(0, vv.duration - (vv.currentTime || 0)))}`;
          } else {
            vid.style.display = "none";
          }
        }
      }
      ring.style.setProperty("--p", `0%`);

      // +5 visibility
      const add5 = state.overlayShadow.getElementById("spAdd5");
      if (add5) add5.style.display = state.settings.overlayShowAdd5 ? "" : "none";
    }

    // opacity
    try { wrap.style.setProperty("--op", String(clamp(Number(state.settings.overlayOpacity || 0.96), 0.25, 1))); } catch {}

    // dimensions + transform
    const s = clamp(Number(state.overlayScale || 1), 0.7, 2.0);
    wrap.style.setProperty("--s", String(s));

    wrap.style.setProperty("--w", `${Math.round(clamp(state.overlayW || 360, 260, 720))}px`);
    wrap.style.setProperty("--h", `${Math.round(clamp(state.overlayH || 128, 80, 340))}px`);

    const x = Number.isFinite(state.overlayX) ? state.overlayX : 0;
    const y = Number.isFinite(state.overlayY) ? state.overlayY : 0;
    wrap.style.setProperty("--x", `${Math.round(x)}px`);
    wrap.style.setProperty("--y", `${Math.round(y)}px`);
  }

  function restoreOverlayPos() {
    // restore from localStorage (per-browser, not synced)
    try {
      const raw = localStorage.getItem("sp_overlay_pos_v5");
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && typeof o === "object") {
        if (Number.isFinite(o.x)) state.overlayX = o.x;
        if (Number.isFinite(o.y)) state.overlayY = o.y;
        if (Number.isFinite(o.w)) state.overlayW = o.w;
        if (Number.isFinite(o.h)) state.overlayH = o.h;
        if (Number.isFinite(o.s)) state.overlayScale = o.s;
        if (typeof o.min === "boolean") state.overlayMinimized = o.min;
      }
    } catch {}
  }

  function persistOverlayPos() {
    try {
      const o = {
        x: state.overlayX, y: state.overlayY,
        w: state.overlayW, h: state.overlayH,
        s: state.overlayScale,
        min: state.overlayMinimized
      };
      localStorage.setItem("sp_overlay_pos_v5", JSON.stringify(o));
    } catch {}
  }

  function snapToCorners() {
    if (!state.settings.overlaySnapCorners) return;
    if (!state.overlayShadow) return;

    const wrap = state.overlayShadow.querySelector(".wrap");
    if (!wrap) return;

    const rect = wrap.getBoundingClientRect();
    const margin = 14;

    // determine nearest corner
    const midX = rect.left + rect.width / 2;
    const midY = rect.top + rect.height / 2;

    const snapX = (midX < window.innerWidth / 2) ? margin : (window.innerWidth - rect.width - margin);
    const snapY = (midY < window.innerHeight / 2) ? margin : (window.innerHeight - rect.height - margin);

    // convert from CSS left/top + translate to translate offsets
    // wrap has left/top fixed at 20/20; translation adds.
    const baseLeft = 20;
    const baseTop = 20;
    state.overlayX = snapX - baseLeft;
    state.overlayY = snapY - baseTop;
    persistOverlayPos();
    renderOverlay();
  }

  function bindOverlayControls() {
    const sh = state.overlayShadow;
    if (!sh) return;

    const byId = (id) => sh.getElementById(id);

    // Timer buttons
    const add5 = byId("spAdd5");
    const add15 = byId("spAdd15");
    const add30 = byId("spAdd30");
    const add60 = byId("spAdd60");
    const sub10 = byId("spSub10");
    const cancel = byId("spCancel");
    const pause = byId("spPause");
    const snooze = byId("spSnooze");
    const restoreVol = byId("spRestoreVol");
    const toEnd = byId("spToEnd");

    if (add5) add5.addEventListener("click", () => startOrExtendTimer(5 * 60));
    if (add15) add15.addEventListener("click", () => startOrExtendTimer(15 * 60));
    if (add30) add30.addEventListener("click", () => startOrExtendTimer(30 * 60));
    if (add60) add60.addEventListener("click", () => startOrExtendTimer(60 * 60));
    if (sub10) sub10.addEventListener("click", () => startOrExtendTimer(-10 * 60));
    if (cancel) cancel.addEventListener("click", () => cancelTimer());
    if (pause) pause.addEventListener("click", () => toggleTimerPause());
    if (snooze) snooze.addEventListener("click", () => snoozeTimer(10 * 60));
    if (restoreVol) restoreVol.addEventListener("click", () => restoreReducedVolume());
    if (toEnd) toEnd.addEventListener("click", () => setTimerToEndOfEpisode());

    // Action buttons
    const si = byId("spSkipIntro");
    const sc = byId("spSkipCredits");
    const nx = byId("spNext");
    if (si) si.addEventListener("click", () => trySkipIntro(true));
    if (sc) sc.addEventListener("click", () => trySkipCredits(true));
    if (nx) nx.addEventListener("click", () => tryPlayNext(true));

    // Minimize + scale
    const min = byId("spMin");
    const down = byId("spSizeDown");
    const up = byId("spSizeUp");
    if (min) min.addEventListener("click", () => {
      state.overlayMinimized = !state.overlayMinimized;
      persistOverlayPos();
      renderOverlay();
      bumpOverlay();
    });
    if (down) down.addEventListener("click", () => {
      state.overlayScale = clamp((state.overlayScale || 1) - 0.1, 0.7, 2.0);
      persistOverlayPos();
      renderOverlay();
      bumpOverlay();
    });
    if (up) up.addEventListener("click", () => {
      state.overlayScale = clamp((state.overlayScale || 1) + 0.1, 0.7, 2.0);
      persistOverlayPos();
      renderOverlay();
      bumpOverlay();
    });

    // Lock
    const lock = byId("spLock");
    if (lock) lock.addEventListener("click", () => toggleOverlayLock());

    // Dragging
    const grip = byId("spGrip");
    const wrap = sh.querySelector(".wrap");
    if (grip && wrap) {
      let dragging = false;
      let startX = 0, startY = 0;
      let baseX = 0, baseY = 0;

      const onDown = (e) => {
        if (state.settings.overlayLocked) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        baseX = Number.isFinite(state.overlayX) ? state.overlayX : 0;
        baseY = Number.isFinite(state.overlayY) ? state.overlayY : 0;
        e.preventDefault();
        bumpOverlay();
      };

      const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        state.overlayX = baseX + dx;
        state.overlayY = baseY + dy;
        renderOverlay();
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        persistOverlayPos();
        snapToCorners();
      };

      grip.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", onUp, { passive: true });
    }

    // Resize
    const res = byId("spResize");
    if (res) {
      let resizing = false;
      let startX = 0, startY = 0;
      let startW = 0, startH = 0;

      const onDown = (e) => {
        if (state.settings.overlayLocked) return;
        resizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = state.overlayW || 360;
        startH = state.overlayH || 128;
        e.preventDefault();
        bumpOverlay();
      };

      const onMove = (e) => {
        if (!resizing) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        state.overlayW = clamp(startW + dx, 260, 720);
        state.overlayH = clamp(startH + dy, 80, 340);
        renderOverlay();
      };

      const onUp = () => {
        if (!resizing) return;
        resizing = false;
        persistOverlayPos();
        snapToCorners();
      };

      res.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", onUp, { passive: true });
    }
  }

  function armOverlayAutoHide() {
    if (!state.overlayShadow) return;
    const wrap = state.overlayShadow.querySelector(".wrap");
    if (!wrap) return;

    let hideT = null;

    const show = () => {
      wrap.classList.remove("hidden");
      if (hideT) clearTimeout(hideT);
      if (!state.settings.overlayAutoHide) return;

      const sec = clamp(Number(state.settings.overlayAutoHideSec || 6), 1, 40);
      hideT = setTimeout(() => {
        // don't hide if user is dragging/resizing? (best effort)
        wrap.classList.add("hidden");
      }, sec * 1000);
    };

    const onMove = () => show();
    const onEnter = () => show();
    const onClick = () => show();

    try {
      wrap.addEventListener("mouseenter", onEnter);
      wrap.addEventListener("mousemove", onMove);
      wrap.addEventListener("click", onClick);
      window.addEventListener("mousemove", onMove, { passive: true });
      show();
    } catch {}
  }

  function bumpOverlay() {
    // tiny nudge to make overlay update smoothly in some browsers
    if (!state.overlayShadow) return;
    try {
      const wrap = state.overlayShadow.querySelector(".wrap");
      if (!wrap) return;
      wrap.style.willChange = "transform";
      setTimeout(() => { try { wrap.style.willChange = ""; } catch {} }, 250);
    } catch {}
  }

  function toggleOverlayLock() {
    const next = !state.settings.overlayLocked;
    state.settings.overlayLocked = next;
    setSync({ overlayLocked: next });
    renderOverlay();
  }

  /* -------------------- sleep timer -------------------- */

  function startOrExtendTimer(deltaSec) {
    // If no timer running, delta is treated as "set to"
    if (!state.timerRunning || state.remainingSec <= 0) {
      const set = Math.max(1, Number(deltaSec || 0));
      state.remainingSec = set;
      state.totalSec = set;
      state.timerRunning = true;
      state.timerSuspended = false;
      state.userPausedTimer = false;
      state.endAtMs = now() + state.remainingSec * 1000;
      state.lastTickMs = now();
      log("Timer started", state.remainingSec);
    } else {
      // extend existing timer
      const next = Math.max(1, Math.floor(state.remainingSec + Number(deltaSec || 0)));
      state.remainingSec = next;

      // totalSec is used for progress ring; keep it at least initial total or current remaining
      const t = clamp((state.totalSec || next) + Number(deltaSec || 0), 1, 12 * 3600);
      state.totalSec = Math.max(t, next);
    }

    // If user had paused the timer and then adds time, keep it paused.
    renderOverlay();

    // do NOT force-enable overlay; only show if user already enabled it
    if (state.settings.countdownVisible) setOverlayVisible(true);
    bumpOverlay();
  }

  function setTimerToEndOfEpisode() {
    const v = getVideo();
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const left = Math.max(1, Math.floor(v.duration - (v.currentTime || 0)));
    // set directly (do not extend)
    state.remainingSec = left;
    state.totalSec = left;
    state.timerRunning = true;
    state.timerSuspended = false;
    state.userPausedTimer = false;
    state.endAtMs = now() + left * 1000;
    state.lastTickMs = now();
    renderOverlay();
    if (state.settings.countdownVisible) setOverlayVisible(true);
    bumpOverlay();
  }

  function cancelTimer() {
    state.timerRunning = false;
    state.remainingSec = 0;
    state.totalSec = 0;
    state.timerSuspended = false;
    state.userPausedTimer = false;
    state.endAtMs = 0;
    state.fadeActive = false;
    state.timerEndedAtMs = 0;
    renderOverlay();
    bumpOverlay();
  }

  function toggleTimerPause() {
    if (!state.timerRunning) return;
    state.userPausedTimer = !state.userPausedTimer;
    if (!state.userPausedTimer) state.lastTickMs = now();
    renderOverlay();
    bumpOverlay();
  }

  function snoozeTimer(sec) {
    // works both when finished recently and when running
    startOrExtendTimer(Number(sec || 0));
    renderOverlay();
    bumpOverlay();
  }

  function restoreReducedVolume() {
    if (!state._reducedAudioActive) return;
    const v = getVideo();
    if (!v) return;
    try {
      if (state._reducedAudioPrevVol != null) v.volume = clamp(state._reducedAudioPrevVol, 0, 1);
    } catch {}
    state._reducedAudioActive = false;
    state._reducedAudioPrevVol = null;
    renderOverlay();
  }

  function playChime() {
    try {
      const vol = clamp((Number(state.settings.timerEndChimeVolume || 40) / 100), 0, 1);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 740;
      g.gain.value = vol;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      setTimeout(() => { try { o.stop(); ctx.close(); } catch {} }, 180);
    } catch {}
  }

  function dimScreen() {
    if (!state.settings.dimOnTimerEnd) return;
    try {
      let el = document.getElementById("sp-dim");
      if (!el) {
        el = document.createElement("div");
        el.id = "sp-dim";
        el.style.position = "fixed";
        el.style.inset = "0";
        el.style.background = "rgba(0,0,0,0.72)";
        el.style.zIndex = "2147483646";
        el.style.pointerEvents = "none";
        document.documentElement.appendChild(el);
      }
      el.style.display = "block";
    } catch {}
  }

  function timerEndAction() {
    const v = getVideo();
    if (!v) return;

    const mode = String(state.settings.timerEndMode || "pause");
    if (mode === "pause") {
      try { v.pause(); } catch {}
    } else if (mode === "mute") {
      try { v.muted = true; } catch {}
    } else if (mode === "reduce") {
      try {
        state._reducedAudioPrevVol = (typeof v.volume === "number") ? v.volume : null;
        const pct = clamp(Number(state.settings.timerEndReducePct || 15), 0, 100);
        v.volume = clamp(pct / 100, 0, 1);
        state._reducedAudioActive = true;
      } catch {}
    }

    if (state.settings.timerEndChime) playChime();
    dimScreen();

    state.timerEndedAtMs = now();
    renderOverlay();
  }

  function tickTimer() {
    if (!state.timerRunning) return;
    if (state.userPausedTimer) return;
    if (state.timerSuspended) return;

    const t = now();
    const dt = Math.max(0, (t - (state.lastTickMs || t)) / 1000);
    state.lastTickMs = t;

    state.remainingSec = Math.max(0, state.remainingSec - dt);
    if (state.remainingSec <= 0.01) {
      state.timerRunning = false;
      state.remainingSec = 0;
      state.totalSec = 0;
      timerEndAction();
      return;
    }

    // fade before end (beta)
    const b = state.settings.beta || {};
    if (b.enabled && b.fadeBeforeEnd && !state.fadeActive) {
      const fadeSec = clamp(Number(b.fadeSeconds || 12), 3, 60);
      if (state.remainingSec <= fadeSec + 0.2) {
        const v = getVideo();
        if (v) {
          state.fadeActive = true;
          state.fadeStartVolume = (typeof v.volume === "number") ? v.volume : 1;
          state.fadeEndsAt = now() + fadeSec * 1000;
        }
      }
    }
    if (state.fadeActive) tickFade();

    renderOverlay();
  }

  function tickFade() {
    const v = getVideo();
    if (!v) { state.fadeActive = false; return; }
    const endAt = state.fadeEndsAt || 0;
    const rem = Math.max(0, endAt - now());
    const dur = Math.max(1, (Number(state.settings.beta?.fadeSeconds || 12) * 1000));
    const p = clamp(1 - (rem / dur), 0, 1);
    const target = clamp(state.fadeStartVolume * (1 - p), 0, 1);
    try { v.volume = target; } catch {}
    if (rem <= 30) state.fadeActive = false;
  }

  /* -------------------- automation: skip intro/credits/next -------------------- */

  // Generic button finders (Plex UI changes often)
  const RX_INTRO = /\b(skip\s*intro)\b/i;
  const RX_CREDITS = /\b(skip\s*credits|skip\s*ending|skip\s*outro)\b/i;

  function safeClick(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown",   { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mouseup",     { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("click",       { bubbles: true, cancelable: true, buttons: 1 }));
      return true;
    } catch {
      try { el.click(); return true; } catch {}
    }
    return false;
  }

  function findButtonByLabel(rx) {
    const sels = ["button", "[role=button]", "a[role=button]"];
    for (const sel of sels) {
      const list = document.querySelectorAll(sel);
      for (const el of list) {
        const label = ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).replace(/\s+/g, " ").trim();
        if (rx.test(label)) return el;
      }
    }
    return null;
  }

  function trySkipIntro(force = false) {
    if (!canAutoAct()) return false;
    if (!force && !ruleOrDefault("skipIntro", "defaultSkipIntro")) return false;
    if (!force && !canClickNow()) return false;

    const btn = findButtonByLabel(RX_INTRO);
    if (!btn) return false;

    const delay = Number.isFinite(state.settings.skipDelayMs) ? state.settings.skipDelayMs : 500;
    setTimeout(() => {
      safeClick(btn);
      bumpAutoCooldown();
      log("✅ Skip Intro");
    }, delay);
    return true;
  }

  function trySkipCredits(force = false) {
    if (!canAutoAct()) return false;
    if (!force && !ruleOrDefault("skipCredits", "defaultSkipCredits")) return false;
    if (!force && !canClickNow()) return false;

    const btn = findButtonByLabel(RX_CREDITS);
    if (!btn) return false;

    const delay = Number.isFinite(state.settings.skipDelayMs) ? state.settings.skipDelayMs : 500;
    setTimeout(() => {
      safeClick(btn);
      bumpAutoCooldown();
      log("✅ Skip Credits");
    }, delay);
    return true;
  }

  // Smart Next Episode skipper (ported)
  function tryPlayNext(force = false) {
    if (!canAutoAct()) return false;
    if (!force) {
      // per-show
      const r = perShowRule();
      const playNext = (r && r.playNext !== false) || (r == null);
      if (state.settings.playNextEnabled === false || playNext === false) return false;
      if (!canClickNow()) return false;
    }

    if (!window.__SMART_NEXT_SKIPPER__) {
      injectSmartNext();
    }
    // Smart next runs on observer + poll. Here we just bump cooldown if in force mode.
    if (force) bumpAutoCooldown();
    return true;
  }

  function injectSmartNext() {
    // Inline the user's smart next skipper. We only attach it once per frame.
    try {
      const fn = function() {
        if (window.__SMART_NEXT_SKIPPER__) return;
        window.__SMART_NEXT_SKIPPER__ = true;

        let settings = {};
        let seriesTitle = "";
        let mo = null;
        let pollTimer = null;

        const POLL_MS = 300;
        const CLICK_COOLDOWN_MS = 300;
        let lastClickTs = 0;

        const NEXT_WORDS = /\b(play\s*next|next\s*episode|watch\s*next|continue(?!\s*watching\s*from)|continue\s*to\s*next|up\s*next)\b/i;
        const NEGATIVE_WORDS = /\b(autoplay\s*(on|off)?|settings|preferences|audio|subtitles|resume)\b/i;

        const TRANSPORT_LABEL_NEG = /\b(10\s*(sec|seconds)|ten\s*seconds|seek|scrub|timeline|progress|jump|rewind|replay\s*10|forward\s*10|skip\s*(ahead|back)\s*10)\b/i;
        const TRANSPORT_CLASS_NEG = /(Transport|control|Controls|Seek|SkipForward|SkipBack|Replay|Timeline|Scrub|Progress|OSD)/i;

        const HIDE_CLASSES = ["hidden","opacity-0","invisible","sr-only","is-hidden","u-hidden","visually-hidden"];

        function isInMenuOrContext(el) {
          return !!el.closest(
            [
              '[role="menu"]',
              '[role="menuitem"]',
              ".ContextMenu",
              ".contextMenu",
              ".Menu",
              ".Dropdown",
              '[data-testid*="menu"]',
              '[data-qa-id*="menu"]'
            ].join(",")
          );
        }

        window.initNextSkipper = function initNextSkipper(loadedSettings, currentSeries) {
          settings = loadedSettings || {};
          seriesTitle = (currentSeries || "Unknown Series").trim();
          if (!isEnabledForSeries()) return;
          start();
        };

        window.updateNextSettings = function updateNextSettings(newSettings, currentSeries) {
          settings = newSettings || settings;
          if (currentSeries) seriesTitle = currentSeries;
        };

        chrome.storage?.onChanged?.addListener((changes, area) => {
          if (area !== "sync") return;
          Object.keys(changes).forEach(k => (settings[k] = changes[k].newValue));
        });

        function canonicalizeSeriesTitle(s) {
          let t = (s || "").trim();
          t = t.replace(/\s*[-–—]\s*S\d+\s*[·x×]?\s*E\d+\s*$/i, "");
          t = t.replace(/\s*\(\s*S\d+\s*[·x×]?\s*E\d+\s*\)\s*$/i, "");
          t = t.replace(/\s*\bS(?:eason)?\s*\d+\s*[·x×.]?\s*E(?:pisode)?\s*\d+\b.*$/i, "");
          t = t.replace(/\s*\bS\d+\s*E\d+\b.*$/i, "");
          t = t.replace(/\s*[-–—]\s*Season\s*\d+\s*Episode\s*\d+\s*$/i, "");
          t = t.replace(/\s*\bSeason\s*\d+\s*Episode\s*\d+\b.*$/i, "");
          return t.trim();
        }

        function normalizeTitle(s) {
          return (s || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .replace(/[^\p{L}\p{N}\s]+/gu, "")
            .trim();
        }

        function seriesKeyFrom(title) {
          return normalizeTitle(canonicalizeSeriesTitle(title));
        }

        function isEnabledForSeries() {
          if (settings.globalEnabled === false) return false;

          const key = seriesKeyFrom(seriesTitle);
          const disabledKeys = settings?.disabledSeriesKeys || [];
          if (disabledKeys.includes(key)) return false;

          const byKey = settings?.perShowRulesByKey || {};
          const r = byKey[key] || (settings?.perShowRules || {})[seriesTitle] || null;

          const playNext = (r && r.playNext !== false) || (r == null);
          const globalOn = settings.playNextEnabled !== false;
          return globalOn && playNext;
        }

        function start() {
          if (mo) mo.disconnect();
          if (pollTimer) clearInterval(pollTimer);

          mo = new MutationObserver(() => tryClickOnce());
          mo.observe(document, { childList: true, subtree: true });

          pollTimer = setInterval(() => tryClickOnce(), POLL_MS);
          tryClickOnce();
        }

        function isLatePhase() {
          const v = document.querySelector("video");
          if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return false;
          const p = (v.currentTime || 0) / v.duration;
          // allow override via settings.nextStartAtPct
          const pct = Math.max(50, Math.min(98, Number(settings.nextStartAtPct || 80)));
          return p >= (pct / 100);
        }

        function clickPlexUpNextIfPresent() {
          const auto = document.getElementById("autoPlayCheck");
          if (!auto || !(auto instanceof HTMLInputElement) || !auto.checked) return false;

          const btn = document.querySelector(
            '[class*="AudioVideoUpNext-poster"] button[aria-label="Play Next"][class*="AudioVideoUpNext-playButton"]'
          );
          if (!btn) return false;
          if (isInMenuOrContext(btn) || isTransportElement(btn)) return false;
          if (!isVisible(btn)) return false;

          const now = Date.now();
          if (now - lastClickTs < CLICK_COOLDOWN_MS) return true;
          lastClickTs = now;

          const target = resolveClickable(btn) || btn;
          if (!target) return true;

          simulatedClick(target);
          return true;
        }

        function tryClickOnce() {
          if (!isEnabledForSeries()) return;

          if (clickPlexUpNextIfPresent()) return;

          const cands = findNextCandidates();
          if (!cands.length) return;

          cands.sort((a, b) => (b.score || 0) - (a.score || 0));
          const delay = Number.isFinite(settings.skipDelayMs) ? settings.skipDelayMs : 500;

          for (const cand of cands) {
            const now = Date.now();
            if (now - lastClickTs < CLICK_COOLDOWN_MS) return;
            lastClickTs = now;

            setTimeout(async () => {
              let target = resolveClickable(cand.el);
              if (!target) return;

              if (!isVisible(target)) {
                const overlay = closestOverlay(target) || target.parentElement || document.body;
                const restore = forceReveal(overlay, target);
                await wait(120);

                target = resolveClickable(target) || target;

                if (!isVisible(target)) {
                  const alt = pickVisibleButton(overlay);
                  if (alt) target = alt;
                }

                if (!isVisible(target)) await wait(80);

                if (isVisible(target)) {
                  simulatedClick(target);
                  restore();
                  return;
                }

                restore();
                return;
              }

              simulatedClick(target);
            }, delay);
            break;
          }
        }

        const SELECTORS = [
          "button", "[role=button]", "a[role=button]",
          '[class*="OverlayButton"]', '[class*="overlayButton"]',
          '[class*="FullPlayer"] [class*="Button"]',
          '[class*="UpNext"] [class*="Button"]',
          '[data-testid*="next" i]', '[data-qa-id*="next" i]',
          '[class*="Next" i]', '[class*="next" i]'
        ];

        function findNextCandidates() {
          const late = isLatePhase();
          const out = [];

          for (const el of deepQueryAllRoots([document], SELECTORS, 0, 8)) {
            if (!isElement(el)) continue;
            if (isTransportElement(el)) continue;
            if (isInMenuOrContext(el)) continue;

            const label = getElementLabel(el);
            if (TRANSPORT_LABEL_NEG.test(label)) continue;
            if (NEGATIVE_WORDS.test(label)) continue;

            const hasNext = NEXT_WORDS.test(label);
            if (!hasNext) continue;

            const overlayish = hasOverlayAncestry(el);
            out.push({ el, score: scoreNextCandidate(el, label, late, overlayish) });
          }

          return out;
        }

        function getElementLabel(el) {
          const aria = el.getAttribute?.("aria-label") || "";
          const title = el.getAttribute?.("title") || "";
          const own = (el.textContent || "");
          const near = closestOverlay(el) || el.parentElement || {};
          const nearText = (near.textContent || "");
          return `${aria}\n${title}\n${own}\n${nearText}`.replace(/\s+/g, " ").trim();
        }

        function closestOverlay(el) {
          return el.closest?.(
            '[class*="Overlay"], [class*="overlay"], [class*="UpNext"], [data-testid*="overlay" i], [class*="Autoplay"]'
          ) || null;
        }

        function scoreNextCandidate(el, label, late, overlayish) {
          let s = 0;
          if (NEXT_WORDS.test(label)) s += 4;
          if (overlayish) s += 3;
          if (late) s += 2;
          try {
            const r = el.getBoundingClientRect();
            if (r.width * r.height > 1500) s += 1;
            const cx = Math.abs((r.left + r.right) / 2 - window.innerWidth / 2);
            const cy = Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
            if (cx < window.innerWidth * 0.35) s += 1;
            if (cy < window.innerHeight * 0.45) s += 1;
          } catch {}
          return s;
        }

        function hasOverlayAncestry(el) {
          for (let n = el, i = 0; n && i < 10; i++, n = n.parentElement) {
            const cls = (n.className || "").toString();
            if (/Overlay|overlay|FullPlayer|UpNext|Autoplay/i.test(cls)) return true;
          }
          return false;
        }

        function isTransportElement(el) {
          for (let n = el, i = 0; n && i < 10; i++, n = n.parentElement) {
            const cls = (n.className || "").toString();
            if (TRANSPORT_CLASS_NEG.test(cls)) return true;
          }
          return false;
        }

        function pickVisibleButton(node) {
          if (isVisible(node)) return node;
          try {
            const btn = node.querySelector?.("button,[role=button],a[role=button],*[onclick]");
            if (btn && isVisible(btn) && !isInMenuOrContext(btn) && !isTransportElement(btn)) return btn;
          } catch {}
          return null;
        }

        function forceReveal(container, button) {
          const touched = [];

          const touch = (el, attrs) => {
            if (!el) return;
            const prev = {
              el,
              style: el.getAttribute("style"),
              hidden: el.getAttribute("aria-hidden"),
              class: el.getAttribute("class")
            };
            touched.push(prev);

            try {
              const cl = new Set((el.className || "").toString().split(/\s+/));
              let changed = false;
              for (const h of HIDE_CLASSES) if (cl.has(h)) { cl.delete(h); changed = true; }
              if (changed) el.className = [...cl].join(" ");
            } catch {}

            try {
              if (el.hasAttribute("aria-hidden")) el.setAttribute("aria-hidden", "false");
            } catch {}

            try {
              const st = el.style;
              st.setProperty("opacity", "1", "important");
              st.setProperty("visibility", "visible", "important");
              st.setProperty("display", "block", "important");
              st.setProperty("pointer-events", "auto", "important");
              st.setProperty("transform", "none", "important");
              st.setProperty("filter", "none", "important");
              if (attrs) for (const [k,v] of Object.entries(attrs)) st.setProperty(k, v, "important");
            } catch {}
          };

          touch(container, { "z-index": "2147483647" });
          touch(button,   { "z-index": "2147483647" });

          if (button && button.parentElement) touch(button.parentElement, { overflow: "visible" });

          try { container.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" }); } catch {}

          return () => {
            for (const prev of touched.reverse()) {
              try {
                if (prev.style == null) prev.el.removeAttribute("style");
                else prev.el.setAttribute("style", prev.style);
              } catch {}
              try {
                if (prev.hidden == null) prev.el.removeAttribute("aria-hidden");
                else prev.el.setAttribute("aria-hidden", prev.hidden);
              } catch {}
              try {
                if (prev.class == null) prev.el.removeAttribute("class");
                else prev.el.setAttribute("class", prev.class);
              } catch {}
            }
          };
        }

        function resolveClickable(node) {
          let el = node;
          for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
            if (!isElement(el)) continue;
            if (isInMenuOrContext(el)) break;
            const tag = (el.tagName || "").toLowerCase();
            const role = (el.getAttribute?.("role") || "").toLowerCase();
            const style = getComputedStyle(el);
            const clickable =
              tag === "button" ||
              role === "button" ||
              el.hasAttribute("onclick") ||
              (parseFloat(style.opacity || "1") > 0.06 &&
              style.pointerEvents !== "none" &&
              (style.cursor === "pointer" || tag === "a"));
            if (clickable && !isTransportElement(el)) return el;
          }
          let desc;
          try { desc = node.querySelector?.("button,[role=button],a[role=button],*[onclick]"); } catch {}
          if (desc && !isTransportElement(desc) && !isInMenuOrContext(desc)) return desc;
          return isElement(node) && !isTransportElement(node) && !isInMenuOrContext(node) ? node : null;
        }

        function simulatedClick(el) {
          try {
            el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, buttons: 1 }));
            el.dispatchEvent(new MouseEvent("mousedown",   { bubbles: true, cancelable: true, buttons: 1 }));
            el.dispatchEvent(new MouseEvent("mouseup",     { bubbles: true, cancelable: true, buttons: 1 }));
            el.dispatchEvent(new MouseEvent("click",       { bubbles: true, cancelable: true, buttons: 1 }));
          } catch {
            try { el.click?.(); } catch {}
          }
        }

        function isElement(x) { return x && x.nodeType === 1; }
        function isVisible(el) {
          if (!isElement(el)) return false;
          let r, s;
          try { r = el.getBoundingClientRect(); s = getComputedStyle(el); } catch { return false; }
          return (
            r.width >= 8 &&
            r.height >= 8 &&
            r.bottom >= 0 && r.right >= 0 &&
            r.top <= (window.innerHeight || 0) && r.left <= (window.innerWidth || 0) &&
            s.display !== "none" && s.visibility !== "hidden" &&
            parseFloat(s.opacity || "1") > 0.06 &&
            s.pointerEvents !== "none"
          );
        }

        function* deepQueryAllRoots(roots, selectors, depth = 0, maxDepth = 8) {
          for (const root of roots) {
            if (!root) continue;

            for (const sel of selectors) {
              let list = [];
              try { list = root.querySelectorAll(sel); } catch {}
              for (const el of list) yield el;
            }

            if (depth >= maxDepth) continue;

            let all = [];
            try { all = root.querySelectorAll("*"); } catch {}
            for (const host of all) {
              const sr = host && host.shadowRoot;
              if (sr) yield* deepQueryAllRoots([sr], selectors, depth + 1, maxDepth);
            }

            let iframes = [];
            try { iframes = root.querySelectorAll("iframe"); } catch {}
            for (const f of iframes) {
              try {
                const doc = f.contentDocument;
                if (doc) yield* deepQueryAllRoots([doc], selectors, depth + 1, maxDepth);
              } catch {}
            }
          }
        }

        function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
      };

      fn();
      // feed it settings + series title from outer state
      try {
        window.initNextSkipper?.(state.settings, state.seriesTitle);
        window.updateNextSettings?.(state.settings, state.seriesTitle);
      } catch {}
    } catch (e) {
      log("injectSmartNext failed", e);
    }
  }

  /* -------------------- beta features -------------------- */

  async function ensureWakeLock() {
    const b = state.settings.beta || {};
    if (!(b.enabled && b.wakeLock)) return;
    try {
      if ("wakeLock" in navigator) {
        if (!state.wakeLock) state.wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch {}
  }

  function releaseWakeLock() {
    try { state.wakeLock?.release?.(); } catch {}
    state.wakeLock = null;
  }

  function applyPlaybackSpeed() {
    const b = state.settings.beta || {};
    if (!b.enabled) return;
    const v = getVideo();
    if (!v) return;

    // Remember speed
    if (b.rememberSpeed) {
      try {
        const stored = localStorage.getItem("sp_last_rate");
        if (!state.hasAppliedSpeed && stored) {
          v.playbackRate = clamp(Number(stored), 0.25, 4.0);
          state.hasAppliedSpeed = true;
        }
      } catch {}
      // Save on changes
      try {
        v.addEventListener("ratechange", () => {
          try { localStorage.setItem("sp_last_rate", String(v.playbackRate)); } catch {}
        }, { passive: true, once: true });
      } catch {}
    } else if (!state.hasAppliedSpeed) {
      // Default speed
      const sp = clamp(Number(b.defaultSpeed || 1), 0.25, 4.0);
      try { v.playbackRate = sp; } catch {}
      state.hasAppliedSpeed = true;
    }
  }

  function applySubtitlesDefault() {
    const b = state.settings.beta || {};
    if (!b.enabled) return;
    const v = getVideo();
    if (!v) return;

    const mode = String(b.subtitlesDefault || "auto");
    try {
      const tracks = v.textTracks;
      if (!tracks || tracks.length === 0) return;
      if (mode === "auto") return;

      for (let i = 0; i < tracks.length; i++) {
        tracks[i].mode = (mode === "on") ? "showing" : "disabled";
      }
    } catch {}
  }

  function maybeAutoStartTimerOnPlay() {
    const b = state.settings.beta || {};
    if (!b.enabled || !b.autoStartTimerOnPlay) return;
    if (state.hasAutoStartedTimerThisSession) return;
    if (state.timerRunning && state.remainingSec > 0) return;

    const mins = clamp(Number(b.autoStartTimerMinutes || 30), 5, 360);
    startOrExtendTimer(mins * 60);
    state.hasAutoStartedTimerThisSession = true;
  }

  function maybeAutoFullscreenOnPlay() {
    const b = state.settings.beta || {};
    if (!b.enabled || !b.autoFullscreenOnPlay) return;
    // best-effort; browser may block
    try {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch?.(()=>{});
      }
    } catch {}
  }

  function pauseOnHiddenHandler() {
    const b = state.settings.beta || {};
    if (!(b.enabled && b.pauseOnHidden)) return;

    const v = getVideo();
    if (!v) return;

    if (document.hidden) {
      const sec = clamp(Number(b.pauseOnHiddenSec || 10), 1, 300);
      if (state.hiddenPauseTimer) clearTimeout(state.hiddenPauseTimer);
      state.hiddenPauseTimer = setTimeout(() => {
        try { v.pause(); } catch {}
      }, sec * 1000);
    } else {
      if (state.hiddenPauseTimer) clearTimeout(state.hiddenPauseTimer);
      state.hiddenPauseTimer = null;
      if (b.resumeOnVisible) {
        try { v.play?.(); } catch {}
      }
    }
  }

  function maybeAutoClickContinueWatching() {
    const b = state.settings.beta || {};
    if (!(b.enabled && b.autoClickContinueWatching)) return;
    // common prompts
    const rx = /\b(continue\s*watching|are\s*you\s*still\s*watching)\b/i;
    const btn = findButtonByLabel(rx);
    if (btn && canClickNow()) {
      safeClick(btn);
      bumpAutoCooldown();
      log("✅ Clicked Continue Watching");
    }
  }

  /* -------------------- init + loops -------------------- */

  async function init() {
    await loadSettings();
    updateSeries();
    applySettingsSideEffects();

    // attach observers
    const mo = new MutationObserver(() => {
      // keep series fresh
      updateSeries();
      // refresh next skipper settings if present
      try { window.updateNextSettings?.(state.settings, state.seriesTitle); } catch {}

      // skippers
      if (getVideo()) {
        trySkipIntro();
        trySkipCredits();
        maybeAutoClickContinueWatching();
      } else {
        // still allow smart next on post-play overlay
        if (isPlexPlayerContext()) {
          tryPlayNext(false);
        }
      }
    });

    try { mo.observe(document, { childList: true, subtree: true }); } catch {}

    // timer tick
    setInterval(() => tickTimer(), 250);

    // periodic "next" attempt when in player context
    setInterval(() => {
      if (!isAutomationEnabled()) return;
      if (isPlexPlayerContext()) tryPlayNext(false);
    }, 300);

    // player event hooks
    document.addEventListener("visibilitychange", pauseOnHiddenHandler, { passive: true });

    // video listeners
    setInterval(() => {
      const v = getVideo();
      if (!v) return;
      ensureWakeLock();
      applyPlaybackSpeed();
      applySubtitlesDefault();
    }, 1000);

    // on play: beta timer, fullscreen
    document.addEventListener("play", (e) => {
      const v = getVideo();
      if (!v) return;
      maybeAutoStartTimerOnPlay();
      maybeAutoFullscreenOnPlay();
      ensureWakeLock();
    }, true);

    document.addEventListener("pause", () => {
      // don't release wake lock on pause; but can if you want
    }, true);

    log("Initialized", { top: IS_TOP });
  }

  init();

})();
