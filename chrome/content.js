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
    "defaultNextEpisode",
    "volumeLevel",
    "muteInsteadOfPause",
    "timerEndAction",
    "reduceAudioLevel",
    "dimScreen",
    "countdownVisible",
    "timerDefaultMin",
    "activeTabOnly",
    "nextLatePhasePct",
    "overlayOpacity",
    "overlayAutoHide",
    "overlayAutoHideSec",
    "overlaySnap",
    "overlayShowEndTime",
    "overlayShowAdd5",
    "overlayShowVideoLeft",
    "overlayShowActions",
    "overlayLocked",
    "timerEndChime",
    "timerEndChimeVolume",
    "episodeGuard",
    "beta"
];

  const DEFAULTS = {
    perShowRules: {},
    globalEnabled: true,
    skipDelayMs: 500,
    minAutoCooldownMs: 600,
    debugLogs: false,
    defaultSkipIntro: true,
    defaultSkipCredits: true,
    defaultNextEpisode: true,
    volumeLevel: 50,
    muteInsteadOfPause: false,
    timerEndAction: "pause",
    reduceAudioLevel: 10,
    dimScreen: true,
    countdownVisible: false,
    timerDefaultMin: 30,

    activeTabOnly: true,
    nextLatePhasePct: 80,

    overlayOpacity: 1.0,
    overlayAutoHide: false,
    overlayAutoHideSec: 4,
    overlaySnap: true,
    overlayShowEndTime: true,
    overlayShowAdd5: false,
    overlayShowVideoLeft: true,
    overlayShowActions: true,
    overlayLocked: false,

    timerEndChime: false,
    timerEndChimeVolume: 40,
    episodeGuard: { enabled: false, maxEpisodes: 3, watchedCount: 0, lastWatched: null },
    beta: {
      enabled: false,
      wakeLock: false,
      pauseOnHidden: false,
      pauseOnHiddenSec: 10,
      resumeOnVisible: false,
      autoFullscreen: false,
      autoStartTimerOnPlay: false,
      autoStartTimerMinutes: 30,
      fadeBeforeTimerEnd: true,
      fadeSeconds: 20,
      rememberSpeed: true,
      defaultSpeed: 1.0,
      subtitlesDefault: "auto", // auto | on | off
      autoContinueWatching: true
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

    // overlay
    overlayHost: null,
    overlayShadow: null,
    overlayVisible: false,
    overlayMin: false,
    overlayScale: 1.0,

    overlayOpacity: 1.0,
    overlayLocked: false,
    overlayLastInteractMs: 0,
    overlayAutoHideArmed: false,

    // timer metrics
    totalSec: 0,
    endAtMs: 0,
    userPausedTimer: false,
    timerEndedAtMs: 0,

    // playback
    wakeLock: null,
    hasAppliedSpeed: false,
    hasAutoStartedTimerThisSession: false,
    hiddenPauseTimer: null
  };

  /* -------------------- runtime guards -------------------- */
  function safeRuntime() {
    return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
  }
  function getSync(keys) {
    return new Promise((resolve) => {
      if (!safeRuntime()) return resolve({});
      try { chrome.storage.sync.get(keys, resolve); } catch { resolve({}); }
    });
  }
  function setSync(obj) {
    return new Promise((resolve) => {
      if (!safeRuntime()) return resolve();
      try { chrome.storage.sync.set(obj, resolve); } catch { resolve(); }
    });
  }
  function setLocal(obj) {
    return new Promise((resolve) => {
      if (!safeRuntime()) return resolve();
      try { chrome.storage.local.set(obj, resolve); } catch { resolve(); }
    });
  }

  /* -------------------- utils -------------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.left <= (window.innerWidth || document.documentElement.clientWidth) &&
      getComputedStyle(el).visibility !== "hidden" &&
      getComputedStyle(el).display !== "none" &&
      getComputedStyle(el).opacity !== "0";
  }

  function parseSeriesKeyFromUrl() {
    // Plex often encodes the library key in the hash, e.g. key=%2Flibrary%2Fmetadata%2F12345
    const raw = location.href + " " + location.hash;
    const m1 = raw.match(/key=([^&\s]+)/i);
    if (m1) {
      try {
        const decoded = decodeURIComponent(m1[1]);
        const mId = decoded.match(/\/library\/metadata\/(\d+)/);
        if (mId) return `meta:${mId[1]}`;
        return `key:${decoded}`;
      } catch {
        return `key:${m1[1]}`;
      }
    }
    const m2 = raw.match(/\/library\/metadata\/(\d+)/);
    if (m2) return `meta:${m2[1]}`;
    return "unknown";
  }

  function inferSeriesTitle() {
    // Best-effort: Plex player often sets document.title to "Episode • Series — Plex"
    const t = (document.title || "").trim();
    if (!t) return "Unknown";
    // try to pull "Series — Plex"
    const parts = t.split("—").map(s => s.trim());
    if (parts.length >= 2) {
      const left = parts[0];
      // left might be "S1:E1 • Series"
      const p2 = left.split("•").map(s => s.trim());
      if (p2.length >= 2) return p2[p2.length - 1];
      return left;
    }
    return t.slice(0, 80);
  }

  function currentRules() {
    const per = state.settings.perShowRules || {};
    const key = state.seriesKey || "unknown";
    const r = per[key] || {};
    return {
      skipIntro: r.skipIntro ?? (state.settings.defaultSkipIntro ?? true),
      skipCredits: r.skipCredits ?? (state.settings.defaultSkipCredits ?? true),
      nextEpisode: r.nextEpisode ?? (state.settings.defaultNextEpisode ?? true),
      // future: skipRecap separate if needed
    };
  }

  /* -------------------- video selection -------------------- */
  function getVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (!vids.length) return null;

    // prefer the largest visible playing video
    let best = null;
    let bestScore = -1;
    for (const v of vids) {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      const score = (isVisible(v) ? 1 : 0) * 1_000_000 + area + (v.paused ? 0 : 10_000);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }


  function isLikelyPlayerContext() {
    // We want Smart Next to work even when <video> temporarily disappears (post-play / up-next screen),
    // but we still avoid scanning on library/home pages.
    try {
      return !!document.querySelector(
        'video, [class*="FullPlayer"], [class*="AudioVideo"], [class*="UpNext"], [class*="Autoplay"], [class*="Postplay"], [data-testid*="player" i], [data-qa-id*="player" i]'
      );
    } catch {
      return false;
    }
  }

  function isPlaying(v) {
    return !!(v && !v.paused && !v.ended && v.readyState >= 2);
  }

  /* -------------------- overlay (shadow DOM) -------------------- */
  function overlayCSS() {
    return `
      :host{ all: initial; }
      .wrap{
        position: fixed;
        left: var(--x, 18px);
        bottom: var(--y, 18px);
        z-index: 2147483647;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        color: rgba(255,255,255,.92);
        user-select: none;
        -webkit-user-select: none;
        pointer-events: auto;
        opacity: var(--op, 1);
        transition: opacity 180ms ease, transform 180ms ease;
        transform: scale(var(--scale, 1));
        transform-origin: left bottom;
      }
      .card{
        position: relative;
        pointer-events: auto;
        display:flex;
        align-items:center;
        gap:10px;
        padding:10px 12px;
        border-radius: 16px;
        background: rgba(12, 18, 30, 0.55);
        border: 1px solid rgba(255,255,255,.12);
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        backdrop-filter: blur(14px);
      }
      .min .card{ padding:8px 10px; border-radius: 999px; gap:8px; }
      .left{ display:flex; align-items:center; gap:10px; }
      .ring{
        width: 30px; height: 30px; border-radius: 999px;
        background: conic-gradient(from 180deg, rgba(59,130,246,.95) var(--p, 0%), rgba(255,255,255,.12) 0);
        display:grid; place-items:center;
      }
      .ring:after{
        content:"";
        width: 22px; height: 22px; border-radius: 999px;
        background: rgba(12, 18, 30, 0.78);
        border: 1px solid rgba(255,255,255,.10);
      }
      .time{
        font-weight: 800;
        letter-spacing: .2px;
        font-size: 13px;
        line-height: 1.1;
      }
      .sub{
        font-size: 11px;
        color: rgba(255,255,255,.68);
        margin-top: 2px;
      }

      .end{
        font-size: 10.5px;
        color: rgba(255,255,255,.55);
        margin-top: 2px;
        letter-spacing: .2px;
      }
      .wrap:not(.showEnd) .end{ display:none; }
      .wrap:not(.showAdd5) #spAdd5{ display:none; }
      .tinyrow{ margin-top: 8px; }
      .tinyrow button{ padding: 6px 8px; font-size: 11.5px; border-radius: 10px; }
      .wrap.autohide.idle{ opacity: 0.18; }
      .wrap.locked .grip{ opacity:.35; cursor:not-allowed; }
      .wrap.locked .resize{ display:none; }

      .stack{ display:flex; flex-direction:column; }
      .pill{
        display:inline-flex; align-items:center; gap:6px;
        padding: 6px 8px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.06);
      }
      button{
        all: unset;
        cursor: pointer;
        padding: 6px 8px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.06);
        color: rgba(255,255,255,.92);
        font-size: 12px;
        font-weight: 700;
      }
      button:hover{ background: rgba(255,255,255,.10); }
      button:active{ transform: translateY(0.5px); }
      .danger{ border-color: rgba(239,68,68,.35); }
      .ghost{ background: transparent; }
      .btnrow{ display:flex; gap:8px; align-items:center; }
      .divider{ width:1px; height:26px; background: rgba(255,255,255,.12); margin: 0 2px; }
      .grip{
        width: 16px;
        height: 26px;
        border-radius: 10px;
        background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.12);
        display:grid;
        place-items:center;
        cursor: grab;
      }
      .grip:active{ cursor: grabbing; }
      .dots{
        width: 10px; height: 14px;
        background:
          radial-gradient(circle, rgba(255,255,255,.65) 1px, transparent 2px) 0 0/5px 5px;
        opacity: .8;
      }
      .min .btnrow, .min .sub, .min .divider{ display:none; }
      .min .ring{ width: 22px; height:22px; }
      .min .ring:after{ width: 16px; height:16px; }

      .right{ display:flex; flex-direction:column; gap:6px; }
      .pill.tiny{ padding: 6px 7px; font-size: 11px; min-width: 34px; justify-content:center; }
      .resize{
        position:absolute;
        right: 10px;
        bottom: 10px;
        width: 14px;
        height: 14px;
        border-radius: 4px;
        background: rgba(255,255,255,.10);
        border: 1px solid rgba(255,255,255,.14);
        cursor: nwse-resize;
        pointer-events:auto;
      }
      .resize:before{
        content:"";
        position:absolute;
        right:3px; bottom:3px;
        width:7px; height:7px;
        border-right:2px solid rgba(255,255,255,.55);
        border-bottom:2px solid rgba(255,255,255,.55);
        opacity:.75;
      }
      .min .right{ display:flex; }
      .min #spSizeDown, .min #spSizeUp{ display:none; }
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
    wrap.style.setProperty("--scale", String(state.overlayScale || 1));
    wrap.style.setProperty("--op", String(state.settings?.overlayOpacity ?? 1));
    wrap.innerHTML = `
      <div class="card">
        <div class="grip" id="spGrip" title="Drag"><div class="dots"></div></div>
        <div class="left">
          <div class="ring" id="spRing"></div>
          <div class="stack">
            <div class="time" id="spTime">—</div>
            <div class="sub" id="spSub">Sleep Timer</div>
            <div class="end" id="spEnd">—</div>
            <div class="vid" id="spVid" style="display:none">—</div>
          </div>
        </div>

        <div class="divider"></div>

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

        <div class="right">
          <button id="spSizeDown" class="pill tiny" title="Smaller">A−</button>
          <button id="spSizeUp" class="pill tiny" title="Larger">A+</button>
          <button id="spMin" class="pill tiny" title="Minimize">▾</button>
        </div>

        <div id="spResize" class="resize" title="Resize"></div>
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
  }

  function setOverlayMin(min) {
    state.overlayMin = !!min;
    if (!state.overlayHost) return;
    const wrap = state.overlayShadow.querySelector(".wrap");
    wrap.classList.toggle("min", state.overlayMin);
    const btn = state.overlayShadow.getElementById("spMin");
    btn.textContent = state.overlayMin ? "▸" : "▾";
    saveOverlayPos(); // store min state too
  }

  function setOverlayScale(scale) {
    const s = clamp(Number(scale) || 1, 0.65, 1.6);
    state.overlayScale = s;
    if (!state.overlayHost) return;
    const wrap = state.overlayShadow.querySelector(".wrap");
    wrap.style.setProperty("--scale", String(s));
    saveOverlayPos();
  }


  function setOverlayOpacity(opacity) {
    const o = clamp(Number(opacity) || 1, 0.25, 1.0);
    state.overlayOpacity = o;
    if (!state.overlayHost) return;
    const wrap = state.overlayShadow.querySelector(".wrap");
    wrap.style.setProperty("--op", String(o));
    // don't persist in local pos; stored in sync settings
  }

  function setOverlayLocked(locked) {
    state.overlayLocked = !!locked;
    if (!state.overlayHost) return;
    const wrap = state.overlayShadow.querySelector(".wrap");
    wrap.classList.toggle("locked", state.overlayLocked);
    const b = state.overlayShadow.getElementById("spLock");
    if (b) b.textContent = state.overlayLocked ? "🔒" : "🔓";
    saveOverlayPos();
  }

  function armOverlayAutoHide() {
    if (!state.overlayHost) return;
    const s = state.settings || {};
    const wrap = state.overlayShadow.querySelector(".wrap");
    wrap.classList.toggle("autohide", !!s.overlayAutoHide);
    if (!s.overlayAutoHide) {
      wrap.classList.remove("idle");
      return;
    }
    state.overlayLastInteractMs = Date.now();
    // set idle after delay unless hovered
    const delay = clamp(Number(s.overlayAutoHideSec) || 4, 1, 15) * 1000;
    window.clearTimeout(state._overlayIdleT);
    state._overlayIdleT = window.setTimeout(() => {
      // if still no interaction and not hovered, go idle
      if (Date.now() - state.overlayLastInteractMs >= delay && !wrap.matches(":hover")) {
        wrap.classList.add("idle");
      }
    }, delay + 20);
  }

  function bumpOverlay() {
    if (!state.overlayHost) return;
    const wrap = state.overlayShadow.querySelector(".wrap");
    state.overlayLastInteractMs = Date.now();
    wrap.classList.remove("idle");
    armOverlayAutoHide();
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
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
      const m = d.getMinutes();
      const am = h >= 12 ? "PM" : "AM";
      h = h % 12; if (h === 0) h = 12;
      return `${h}:${String(m).padStart(2,"0")} ${am}`;
    } catch { return "—"; }
  }

  function renderOverlay() {
    if (!state.overlayHost) return;
    const t = state.overlayShadow.getElementById("spTime");
    const sub = state.overlayShadow.getElementById("spSub");
    const end = state.overlayShadow.getElementById("spEnd");
    const vid = state.overlayShadow.getElementById("spVid");
    const actionsRow = state.overlayShadow.getElementById("spActionsRow");
    const ring = state.overlayShadow.getElementById("spRing");
    const wrap = state.overlayShadow.querySelector(".wrap");

    // classes derived from settings
    wrap.classList.toggle("showEnd", !!state.settings.overlayShowEndTime);
    wrap.classList.toggle("showAdd5", !!state.settings.overlayShowAdd5);
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
      }

      // episode remaining line
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
      ring.style.setProperty("--p", `${Math.round(p * 100)}%`);
    } else {
      t.textContent = endedRecently ? "Finished" : "No timer";
      sub.textContent = state.seriesTitle || "Sleep Timer";
      if (end) end.textContent = endedRecently ? "Tap Snooze to continue" : "—";
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
    }
  }

  function bindOverlayControls() {
    const $ = (id) => state.overlayShadow.getElementById(id);

    const click = (id, fn) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      bumpOverlay();
      fn();
    });
    };

    click("spAdd5",  () => startOrExtendTimer(5*60));
    click("spAdd15", () => startOrExtendTimer(15*60));
    click("spAdd30", () => startOrExtendTimer(30*60));
    click("spAdd60", () => startOrExtendTimer(60*60));
    click("spSub10", () => startOrExtendTimer(-10*60));
    click("spCancel", () => stopTimer(false));

    click("spToEnd", () => {
      const v = getVideo();
      if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
      const rem = Math.max(0, (v.duration - (v.currentTime || 0)));
      setTimerAbsolute(rem);
    });

    click("spRestoreVol", () => {
      const v = getVideo();
      if (!v) return;
      if (typeof state._preEndMuted === "boolean") v.muted = state._preEndMuted;
      if (typeof state._preEndVolume === "number") v.volume = clamp(state._preEndVolume, 0, 1);
      state._reducedAudioActive = false;
      renderOverlay();
      bumpOverlay();
    });

    click("spPause", () => toggleUserPauseTimer());
    click("spSnooze", () => snoozeTimer(10*60));
    click("spLock", () => toggleOverlayLock());

    click("spSkipIntro", () => triggerSkip("intro"));
    click("spSkipCredits", () => triggerSkip("credits"));
    click("spNext", () => triggerSkip("next"));

    const spMin = $("spMin"); if (spMin) spMin.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setOverlayMin(!state.overlayMin);
    });
    // Size controls
    const spSizeDown = $("spSizeDown"); if (spSizeDown) spSizeDown.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      setOverlayScale((state.overlayScale || 1) - 0.1);
    });
    const spSizeUp = $("spSizeUp"); if (spSizeUp) spSizeUp.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      setOverlayScale((state.overlayScale || 1) + 0.1);
    });

    // Resize by dragging the corner handle
    const resize = $("spResize");
    // resize handle optional
    let resizing = false;
    let rsStartX = 0, rsStartY = 0, rsBase = 1;

    if (resize) resize.addEventListener("pointerdown", (e) => {
      if (state.settings.overlayLocked) return;
      bumpOverlay();
      resizing = true;
      resize.setPointerCapture(e.pointerId);
      rsBase = state.overlayScale || 1;
      rsStartX = e.clientX; rsStartY = e.clientY;
      e.preventDefault(); e.stopPropagation();
    });

    if (resize) resize.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const dx = e.clientX - rsStartX;
      const dy = e.clientY - rsStartY;
      // Move right/down -> larger, left/up -> smaller
      const delta = (dx + dy) / 420;
      setOverlayScale(rsBase + delta);
      e.preventDefault(); e.stopPropagation();
    });

    if (resize) resize.addEventListener("pointerup", (e) => {
      if (!resizing) return;
      resizing = false;
      try { resize.releasePointerCapture(e.pointerId); } catch {}
      saveOverlayPos();
      e.preventDefault(); e.stopPropagation();
    });


    // Drag only by grip
    const grip = $("spGrip");
    if (!grip) return;
    let dragging = false;
    let startX=0, startY=0, baseX=18, baseY=18;

    grip.addEventListener("pointerdown", (e) => {
      if (state.settings.overlayLocked) return;
      bumpOverlay();
      dragging = true;
      grip.setPointerCapture(e.pointerId);
      const wrap = state.overlayShadow.querySelector(".wrap");
      const x = parseFloat(wrap.style.getPropertyValue("--x") || "18");
      const y = parseFloat(wrap.style.getPropertyValue("--y") || "18");
      baseX = x; baseY = y;
      startX = e.clientX; startY = e.clientY;
      e.preventDefault();
      e.stopPropagation();
    });

    grip.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const wrap = state.overlayShadow.querySelector(".wrap");
      // use left/bottom (x = left, y = bottom). dy in screen coords is inverted for bottom.
      const newX = clamp(baseX + dx, 6, (window.innerWidth - 260));
      const newY = clamp(baseY - dy, 6, (window.innerHeight - 96));
      wrap.style.setProperty("--x", `${newX}px`);
      wrap.style.setProperty("--y", `${newY}px`);
      e.preventDefault();
      e.stopPropagation();
    });

    grip.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      try { grip.releasePointerCapture(e.pointerId); } catch {}

      // Snap to nearest corner (optional)
      if (state.settings.overlaySnap) {
        try {
          const wrap = state.overlayShadow.querySelector(".wrap");
          const r = wrap.getBoundingClientRect();
          const margin = 12;
          const leftDist = r.left;
          const rightDist = window.innerWidth - r.right;
          const bottomDist = window.innerHeight - r.bottom;
          const topDist = r.top;

          // choose horizontal
          const snapLeft = leftDist <= rightDist;
          const snapBottom = bottomDist <= topDist;

          // translate to our left/bottom coords
          const newX = snapLeft ? margin : Math.max(margin, window.innerWidth - r.width - margin);
          const newBottom = snapBottom ? margin : Math.max(margin, window.innerHeight - r.height - margin);

          wrap.style.setProperty("--x", `${Math.round(newX)}px`);
          wrap.style.setProperty("--y", `${Math.round(newBottom)}px`);
        } catch {}
      }

      saveOverlayPos();
      bumpOverlay();
      e.preventDefault();
      e.stopPropagation();
    });
  }

  async function restoreOverlayPos() {
    if (!safeRuntime()) return;
    try {
      const res = await new Promise((resolve) => chrome.storage.local.get(["overlayPosV5"], resolve));
      const pos = res.overlayPosV5 || null;
      if (!pos || !state.overlayHost) return;
      const wrap = state.overlayShadow.querySelector(".wrap");
      if (typeof pos.x === "number") wrap.style.setProperty("--x", `${pos.x}px`);
      if (typeof pos.y === "number") wrap.style.setProperty("--y", `${pos.y}px`);
      if (typeof pos.scale === "number") setOverlayScale(pos.scale);
      if (typeof pos.min === "boolean") setOverlayMin(pos.min);
    } catch {}
  }

  function saveOverlayPos() {
    if (!safeRuntime() || !state.overlayHost) return;
    try {
      const wrap = state.overlayShadow.querySelector(".wrap");
      const x = parseFloat(wrap.style.getPropertyValue("--x") || "18");
      const y = parseFloat(wrap.style.getPropertyValue("--y") || "18");
      chrome.storage.local.set({ overlayPosV5: { x, y, min: state.overlayMin, scale: state.overlayScale } });
    } catch {}
  }

  /* -------------------- dim screen -------------------- */
  function ensureDimLayer() {
    let el = document.getElementById("sp-dim-layer");
    if (el) return el;
    el = document.createElement("div");
    el.id = "sp-dim-layer";
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      background: "black",
      opacity: "0",
      pointerEvents: "none",
      zIndex: "2147483646",
      transition: "opacity 250ms ease"
    });
    document.documentElement.appendChild(el);
    return el;
  }

  function setDim(on) {
    if (!state.settings.dimScreen) return;
    const el = ensureDimLayer();
    el.style.opacity = on ? "0.68" : "0";
    el.style.pointerEvents = on ? "auto" : "none";
  }


  function playChime(volPct) {
    try {
      const v = clamp(Number(volPct) || 40, 0, 100) / 100;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      o1.type = "sine"; o2.type = "triangle";
      o1.frequency.value = 880;
      o2.frequency.value = 660;
      o1.connect(g); o2.connect(g);
      g.connect(ctx.destination);

      const t0 = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, v), t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.65);

      o1.start(t0); o2.start(t0);
      o1.stop(t0 + 0.7); o2.stop(t0 + 0.7);

      setTimeout(() => { try { ctx.close(); } catch {} }, 900);
    } catch {}
  }

  /* -------------------- timer -------------------- */
  function startOrExtendTimer(deltaSec) {
    const wasRunning = !!state.timerRunning;
    const prevRemain = Number(state.remainingSec || 0);
    const next = clamp(prevRemain + Number(deltaSec || 0), 0, 12 * 3600);

    state.remainingSec = next;

    if (state.remainingSec <= 0.01) {
      stopTimer(false);
      return;
    }

    state.timerRunning = true;
    state.lastTickMs = Date.now();
    state.fadeActive = false;
    state.timerEndedAtMs = 0;

    // total duration for progress ring (best effort)
    if (!wasRunning || !Number.isFinite(state.totalSec) || state.totalSec <= 0) {
      state.totalSec = next;
    } else {
      // keep total >= remaining
      const t = clamp((state.totalSec || next) + Number(deltaSec || 0), 1, 12 * 3600);
      state.totalSec = Math.max(t, next);
    }

    // If user had paused the timer and then adds time, keep it paused.
    renderOverlay();

    // do NOT force-enable overlay; only show if user already enabled it
    if (state.settings.countdownVisible) setOverlayVisible(true);
    bumpOverlay();
  }

  
  function setTimerAbsolute(sec) {
    const s = clamp(Number(sec || 0), 0, 12 * 3600);
    state.remainingSec = s;

    if (s <= 0.01) {
      stopTimer(false);
      return;
    }

    state.timerRunning = true;
    state.lastTickMs = Date.now();
    state.fadeActive = false;
    state.timerSuspended = false;
    state.userPausedTimer = false;
    state.timerEndedAtMs = null;

    renderOverlay();
    if (state.settings.countdownVisible) setOverlayVisible(true);
    bumpOverlay();
  }

function stopTimer(triggerEndActions) {
    const had = state.timerRunning;
    state.timerRunning = false;
    state.timerSuspended = false;
    state.remainingSec = 0;
    state.fadeActive = false;
    state.userPausedTimer = false;
    if (triggerEndActions && had) state.timerEndedAtMs = Date.now();
    renderOverlay();
    // keep overlay visible if user wants it; just shows "No timer"
    if (triggerEndActions && had) onTimerEnd();
  }


  function toggleUserPauseTimer() {
    if (!state.timerRunning) return;
    state.userPausedTimer = !state.userPausedTimer;
    state.timerSuspended = state.userPausedTimer || state.timerSuspended;
    state.lastTickMs = Date.now();
    renderOverlay();
    bumpOverlay();
  }

  function snoozeTimer(sec) {
    // works both when finished recently and when running
    startOrExtendTimer(Number(sec || 0));
    renderOverlay();
    bumpOverlay();
  }

  function toggleOverlayLock() {
    const next = !state.settings.overlayLocked;
    state.settings.overlayLocked = next;
    setSync({ overlayLocked: next });
    if (state.overlayHost) {
      setOverlayLocked(next);
    }
    bumpOverlay();
  }

  async function onTimerEnd() {
    const v = getVideo();
    if (!v) return;

    if (state.settings.activeTabOnly) {
      if (document.hidden) return;
      try { if (IS_TOP && typeof document.hasFocus === "function" && !document.hasFocus()) return; } catch {}
    }

    // Fade handled already; enforce end action
    const action = (state.settings.timerEndAction) || (state.settings.muteInsteadOfPause ? "mute" : "pause");

    if (action === "reduce") {
      // Reduce audio and keep playing
      try {
        state._preEndMuted = v.muted;
        state._preEndVolume = v.volume;
        v.muted = false;
        v.volume = clamp(Number(state.settings.reduceAudioLevel || 10) / 100, 0, 1);
        state._reducedAudioActive = true;
      } catch {}
    } else if (action === "mute") {
      v.muted = true;
      state._reducedAudioActive = false;
    } else {
      try { v.pause(); } catch {}
      state._reducedAudioActive = false;
    }
if (state.settings.timerEndChime) {
      playChime(clamp(Number(state.settings.timerEndChimeVolume || 40), 0, 100));
    }

    // ensure overlay updates to "Finished" if it is enabled
    bumpOverlay();
    setDim(true);
  }

  function maybeRunFade(v) {
    const beta = state.settings.beta || DEFAULTS.beta;
    if (!beta.enabled || !beta.fadeBeforeTimerEnd) return;

    const fadeSec = clamp(Number(beta.fadeSeconds || 20), 3, 180);
    if (state.remainingSec > fadeSec) return;

    if (!state.fadeActive) {
      state.fadeActive = true;
      state.fadeStartVolume = v.volume;
    }
    const p = 1 - (state.remainingSec / fadeSec); // 0->1
    const vol = clamp(state.fadeStartVolume * (1 - p), 0, 1);
    v.volume = vol;
  }

  function tick() {
    const v = getVideo();
    if (!state.timerRunning || state.remainingSec <= 0) return;

    const now = Date.now();
    const dt = Math.max(0, now - (state.lastTickMs || now));
    state.lastTickMs = now;

    // count down only while playing (unless user paused)
    if (state.userPausedTimer) {
      state.timerSuspended = true;
    } else if (v && isPlaying(v)) {
      state.timerSuspended = false;
      const dec = dt / 1000;
      state.remainingSec = Math.max(0, state.remainingSec - dec);
      maybeRunFade(v);
      if (state.remainingSec <= 0.01) {
        stopTimer(true);
      }
    } else {
      state.timerSuspended = true;
    }
    renderOverlay();
    armOverlayAutoHide();
  }

  /* -------------------- skipper (intro/credits/next) -------------------- */
  const RE_INTRO = /\bskip\s+(intro|opening|recap)\b/i;
  const RE_CREDITS = /\bskip\s+(credits|outro)\b/i;
  const RE_NEXT = /\b(next\s+episode|play\s+next|next)\b/i;
  const RE_TRANSPORT_NEG = /\b(10\s*(sec|seconds)|replay\s*10|forward\s*10|skip\s*(ahead|back)\s*10)\b/i;
  // ---- Smart "Play Next / Next Episode" (ported from your original next.js) ----
  // Purpose: reliably click the actual "Play Next / Next Episode" CTA without touching transport controls or menus.
  const SN_NEXT_WORDS = /\b(play\s*next|next\s*episode|watch\s*next|continue(?!\s*watching\s*from)|continue\s*to\s*next|up\s*next)\b/i;
  const SN_NEGATIVE_WORDS = /\b(autoplay\s*(on|off)?|settings|preferences|audio|subtitles|resume)\b/i;

  const SN_TRANSPORT_LABEL_NEG = /\b(10\s*(sec|seconds)|ten\s*seconds|seek|scrub|timeline|progress|jump|rewind|replay\s*10|forward\s*10|skip\s*(ahead|back)\s*10)\b/i;
  const SN_TRANSPORT_CLASS_NEG = /(Transport|control|Controls|Seek|SkipForward|SkipBack|Replay|Timeline|Scrub|Progress|OSD)/i;

  const SN_HIDE_CLASSES = ['hidden','opacity-0','invisible','sr-only','is-hidden','u-hidden','visually-hidden'];

  const SN_CLICK_COOLDOWN_MS = 300;
  let snLastClickTs = 0;

  function snIsInMenuOrContext(el) {
    return !!el?.closest?.(
      [
        '[role="menu"]',
        '[role="menuitem"]',
        '.ContextMenu',
        '.contextMenu',
        '.Menu',
        '.Dropdown',
        '[data-testid*="menu"]',
        '[data-qa-id*="menu"]'
      ].join(',')
    );
  }

  function snIsTransportElement(el) {
    for (let n = el, i = 0; n && i < 10; i++, n = n.parentElement) {
      const cls = (n.className || '').toString();
      if (SN_TRANSPORT_CLASS_NEG.test(cls)) return true;
    }
    return false;
  }

  function snIsLatePhase() {
    const v = getVideo();
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return false;
    const p = (v.currentTime || 0) / v.duration;
    const pct = Number(settings.nextLatePhasePct);
    const thr = Number.isFinite(pct) ? Math.min(0.98, Math.max(0.5, pct / 100)) : 0.80;
    return p >= thr;
  }

  function snClickPlexUpNextIfPresent() {
    const settings = state.settings || {};
    const delay = Number.isFinite(settings.skipDelayMs) ? settings.skipDelayMs : 500;

    const auto = document.getElementById('autoPlayCheck');
    if (!auto || !(auto instanceof HTMLInputElement) || !auto.checked) return false;

    const btn = document.querySelector(
      '[class*="AudioVideoUpNext-poster"] button[aria-label="Play Next"][class*="AudioVideoUpNext-playButton"]'
    );
    if (!btn) return false;
    if (snIsInMenuOrContext(btn) || snIsTransportElement(btn)) return false;
    if (!snIsVisible(btn)) return false;

    const now = Date.now();
    if (now - snLastClickTs < SN_CLICK_COOLDOWN_MS) return true;
    snLastClickTs = now;

    const target = snResolveClickable(btn) || btn;
    if (!target) return true;

    setTimeout(() => {
      snSimulatedClick(target);
      // console.debug('[StreamPlus:next] ✅ Clicked Plex Play Next (fast path)');
    }, delay);

    return true;
  }

  const SN_SELECTORS = [
    'button', '[role=button]', 'a[role=button]',
    '[class*="OverlayButton"]', '[class*="overlayButton"]',
    '[class*="FullPlayer"] [class*="Button"]',
    '[class*="UpNext"] [class*="Button"]',
    '[data-testid*="next" i]', '[data-qa-id*="next" i]',
    '[class*="Next" i]', '[class*="next" i]'
  ];

  function snFindNextCandidates() {
    const late = snIsLatePhase();
    const out = [];

    for (const el of snDeepQueryAllRoots([document], SN_SELECTORS, 0, 8)) {
      if (!snIsElement(el)) continue;
      if (snIsTransportElement(el)) continue;
      if (snIsInMenuOrContext(el)) continue;

      const label = snGetElementLabel(el);
      if (SN_TRANSPORT_LABEL_NEG.test(label)) continue;
      if (SN_NEGATIVE_WORDS.test(label)) continue;

      const hasNext = SN_NEXT_WORDS.test(label);
      if (!hasNext) continue;

      const overlayish = snHasOverlayAncestry(el);
      out.push({ el, score: snScoreNextCandidate(el, label, late, overlayish) });
    }

    return out;
  }

  function snGetElementLabel(el) {
    const aria = el.getAttribute?.('aria-label') || '';
    const title = el.getAttribute?.('title') || '';
    const own = (el.textContent || '');
    const near = snClosestOverlay(el) || el.parentElement || {};
    const nearText = (near.textContent || '');
    return `${aria}\n${title}\n${own}\n${nearText}`.replace(/\s+/g, ' ').trim();
  }

  function snClosestOverlay(el) {
    return el.closest?.(
      '[class*="Overlay"], [class*="overlay"], [class*="UpNext"], [data-testid*="overlay" i], [class*="Autoplay"]'
    ) || null;
  }

  function snHasOverlayAncestry(el) {
    for (let n = el, i = 0; n && i < 10; i++, n = n.parentElement) {
      const cls = (n.className || '').toString();
      if (/Overlay|overlay|FullPlayer|UpNext|Autoplay/i.test(cls)) return true;
    }
    return false;
  }

  function snScoreNextCandidate(el, label, late, overlayish) {
    let s = 0;
    if (SN_NEXT_WORDS.test(label)) s += 4;
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

  function snPickVisibleButton(node) {
    if (snIsVisible(node)) return node;
    try {
      const btn = node.querySelector?.('button,[role=button],a[role=button],*[onclick]');
      if (btn && snIsVisible(btn) && !snIsInMenuOrContext(btn) && !snIsTransportElement(btn)) return btn;
    } catch {}
    return null;
  }

  function snForceReveal(container, button) {
    const touched = [];

    const touch = (el, attrs) => {
      if (!el) return;
      const prev = {
        el,
        style: el.getAttribute('style'),
        hidden: el.getAttribute('aria-hidden'),
        class: el.getAttribute('class')
      };
      touched.push(prev);

      try {
        const cl = new Set((el.className || '').toString().split(/\s+/));
        let changed = false;
        for (const h of SN_HIDE_CLASSES) if (cl.has(h)) { cl.delete(h); changed = true; }
        if (changed) el.className = [...cl].join(' ');
      } catch {}

      try {
        if (el.hasAttribute('aria-hidden')) el.setAttribute('aria-hidden', 'false');
      } catch {}

      try {
        const st = el.style;
        st.setProperty('opacity', '1', 'important');
        st.setProperty('visibility', 'visible', 'important');
        st.setProperty('display', 'block', 'important');
        st.setProperty('pointer-events', 'auto', 'important');
        st.setProperty('transform', 'none', 'important');
        st.setProperty('filter', 'none', 'important');
        if (attrs) for (const [k,v] of Object.entries(attrs)) st.setProperty(k, v, 'important');
      } catch {}
    };

    touch(container, { 'z-index': '2147483647' });
    touch(button,   { 'z-index': '2147483647' });

    if (button && button.parentElement) touch(button.parentElement, { overflow: 'visible' });

    try { container.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}

    return () => {
      for (const prev of touched.reverse()) {
        try {
          if (prev.style == null) prev.el.removeAttribute('style');
          else prev.el.setAttribute('style', prev.style);
        } catch {}
        try {
          if (prev.hidden == null) prev.el.removeAttribute('aria-hidden');
          else prev.el.setAttribute('aria-hidden', prev.hidden);
        } catch {}
        try {
          if (prev.class == null) prev.el.removeAttribute('class');
          else prev.el.setAttribute('class', prev.class);
        } catch {}
      }
    };
  }

  function snResolveClickable(node) {
    let el = node;
    for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
      if (!snIsElement(el)) continue;
      if (snIsInMenuOrContext(el)) break;
      const tag = (el.tagName || '').toLowerCase();
      const role = (el.getAttribute?.('role') || '').toLowerCase();
      const style = getComputedStyle(el);
      const clickable =
        tag === 'button' ||
        role === 'button' ||
        el.hasAttribute('onclick') ||
        (parseFloat(style.opacity || '1') > 0.06 &&
         style.pointerEvents !== 'none' &&
         (style.cursor === 'pointer' || tag === 'a'));
      if (clickable && !snIsTransportElement(el)) return el;
    }
    let desc;
    try { desc = node.querySelector?.('button,[role=button],a[role=button],*[onclick]'); } catch {}
    if (desc && !snIsTransportElement(desc) && !snIsInMenuOrContext(desc)) return desc;
    return snIsElement(node) && !snIsTransportElement(node) && !snIsInMenuOrContext(node) ? node : null;
  }

  function snSimulatedClick(el) {
    try {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown',   { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mouseup',     { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('click',       { bubbles: true, cancelable: true, buttons: 1 }));
    } catch {
      try { el.click?.(); } catch {}
    }
  }

  function snIsElement(x) { return x && x.nodeType === 1; }

  function snIsVisible(el) {
    if (!snIsElement(el)) return false;
    let r, s;
    try { r = el.getBoundingClientRect(); s = getComputedStyle(el); } catch { return false; }
    return (
      r.width >= 8 &&
      r.height >= 8 &&
      r.bottom >= 0 && r.right >= 0 &&
      r.top <= (window.innerHeight || 0) && r.left <= (window.innerWidth || 0) &&
      s.display !== 'none' && s.visibility !== 'hidden' &&
      parseFloat(s.opacity || '1') > 0.06 &&
      s.pointerEvents !== 'none'
    );
  }

  function* snDeepQueryAllRoots(roots, selectors, depth = 0, maxDepth = 8) {
    for (const root of roots) {
      if (!root) continue;

      for (const sel of selectors) {
        let list = [];
        try { list = root.querySelectorAll(sel); } catch {}
        for (const el of list) yield el;
      }

      if (depth >= maxDepth) continue;

      let all = [];
      try { all = root.querySelectorAll('*'); } catch {}
      for (const host of all) {
        const sr = host && host.shadowRoot;
        if (sr) yield* snDeepQueryAllRoots([sr], selectors, depth + 1, maxDepth);
      }

      let iframes = [];
      try { iframes = root.querySelectorAll('iframe'); } catch {}
      for (const f of iframes) {
        try {
          const doc = f.contentDocument;
          if (doc) yield* snDeepQueryAllRoots([doc], selectors, depth + 1, maxDepth);
        } catch {}
      }
    }
  }

  function snWait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function smartNextTryClickOnce(force = false) {
    const settings = state.settings || {};
    if (settings.globalEnabled === false) return false;
    const rules = currentRules();
    if (!rules.nextEpisode) return false;

    // Fast path first
    if (snClickPlexUpNextIfPresent()) return true;

    // If not force, we still allow clicking whenever the "Next" CTA exists; scoring just prefers late phase.
    const cands = snFindNextCandidates();
    if (!cands.length) return false;

    cands.sort((a, b) => (b.score || 0) - (a.score || 0));
    const delay = Number.isFinite(settings.skipDelayMs) ? settings.skipDelayMs : 500;

    for (const cand of cands) {
      const now = Date.now();
      if (now - snLastClickTs < SN_CLICK_COOLDOWN_MS) return true;
      snLastClickTs = now;

      setTimeout(async () => {
        let target = snResolveClickable(cand.el);
        if (!target) return;

        if (!snIsVisible(target)) {
          const overlay = snClosestOverlay(target) || target.parentElement || document.body;
          const restore = snForceReveal(overlay, target);
          await snWait(120);

          target = snResolveClickable(target) || target;

          if (!snIsVisible(target)) {
            const alt = snPickVisibleButton(overlay);
            if (alt) target = alt;
          }

          if (!snIsVisible(target)) await snWait(80);

          if (snIsVisible(target)) {
            snSimulatedClick(target);
            restore();
            return;
          }

          restore();
          return;
        }

        snSimulatedClick(target);
      }, delay);
      break;
    }

    return true;
  }


  let skipperLastClick = 0;

  function findClickable(re) {
    const candidates = Array.from(document.querySelectorAll(
      'button,[role="button"],a,[data-testid],div[tabindex]'
    ));
    for (const el of candidates) {
      const txt = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
      if (!txt) continue;
      if (RE_TRANSPORT_NEG.test(txt)) continue;
      if (!re.test(txt)) continue;
      if (!isVisible(el)) continue;
      return el;
    }
    return null;
  }

  async function clickWithDelay(el) {
    const delay = clamp(Number(state.settings.skipDelayMs || 0), 0, 5000);
    if (delay) await sleep(delay);
    try { el.click(); } catch {}
  }

  async function skipperLoop() {
    const v = getVideo();
    if (!v) return;

    if (state.settings.activeTabOnly) {
      if (document.hidden) return;
      try { if (IS_TOP && typeof document.hasFocus === "function" && !document.hasFocus()) return; } catch {}
    }

    // update series info opportunistically
    state.seriesKey = parseSeriesKeyFromUrl();
    state.seriesTitle = inferSeriesTitle();
    setLocal({ activeSeriesKey: state.seriesKey, activeSeriesTitle: state.seriesTitle });

    if (!state.settings.globalEnabled) return;
    const rules = currentRules();

    const now = Date.now();
    if (now - skipperLastClick < clamp(Number(state.settings.minAutoCooldownMs || 600), 100, 5000)) return;

    if (rules.skipIntro) {
      const el = findClickable(RE_INTRO);
      if (el) { skipperLastClick = now; await clickWithDelay(el); return; }
    }
    if (rules.skipCredits) {
      const el = findClickable(RE_CREDITS);
      if (el) { skipperLastClick = now; await clickWithDelay(el); return; }
    }
    if (rules.nextEpisode) {
      const did = await smartNextTryClickOnce(false);
      if (did) { skipperLastClick = now; return; }
    }
  }

  function triggerSkip(kind) {
    if (!state.settings.globalEnabled) return;
    if (kind === "intro") {
      const el = findClickable(RE_INTRO);
      if (el) clickWithDelay(el);
    } else if (kind === "credits") {
      const el = findClickable(RE_CREDITS);
      if (el) clickWithDelay(el);
    } else if (kind === "next") {
      // Use the smart next skipper logic for manual clicks too
      smartNextTryClickOnce(true);
    }
  }

  /* -------------------- beta helpers -------------------- */
  async function applyWakeLock(v) {
    const beta = state.settings.beta || DEFAULTS.beta;
    if (!beta.enabled || !beta.wakeLock) {
      if (state.wakeLock) { try { await state.wakeLock.release(); } catch {} state.wakeLock = null; }
      return;
    }
    if (!("wakeLock" in navigator)) return;
    if (!isPlaying(v)) return;
    if (state.wakeLock) return;
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
    } catch {}
  }

  function setupPauseOnHidden(v) {
    const beta = state.settings.beta || DEFAULTS.beta;
    if (!beta.enabled || !beta.pauseOnHidden) return;

    const sec = clamp(Number(beta.pauseOnHiddenSec || 10), 3, 600);

    document.addEventListener("visibilitychange", () => {
      clearTimeout(state.hiddenPauseTimer);

      // Resume if we were paused by this feature
      if (!document.hidden && beta.resumeOnVisible && state._pausedByHidden) {
        state._pausedByHidden = false;
        const vv = getVideo();
        if (vv) {
          try { vv.play?.(); } catch {}
        }
      }

      if (document.hidden && isPlaying(v)) {
        state.hiddenPauseTimer = setTimeout(() => {
          const vv = getVideo();
          if (vv && document.hidden && isPlaying(vv)) {
            try { vv.pause(); state._pausedByHidden = true; } catch {}
          }
        }, sec * 1000);
      }
    }, { passive: true });
  }

  function setupAutoFullscreen(v) {
    const beta = state.settings.beta || DEFAULTS.beta;
    if (!beta.enabled || !beta.autoFullscreen) return;

    // best-effort; browser may block. run once per session.
    if (state.__didFullscreen) return;
    state.__didFullscreen = true;

    v.addEventListener("play", async () => {
      try {
        if (document.fullscreenElement) return;
        const target = v.closest("[data-testid],.Player,main") || v;
        await target.requestFullscreen?.();
      } catch {}
    }, { once: true });
  }

  function setupPlaybackSpeed(v) {
    const beta = state.settings.beta || DEFAULTS.beta;
    if (!beta.enabled) return;

    // apply once when metadata is ready
    const apply = async () => {
      if (state.hasAppliedSpeed) return;
      state.hasAppliedSpeed = true;

      try {
        const cur = await getSync(["spLastPlaybackRate"]);
        let rate = Number(beta.defaultSpeed || 1.0);
        if (beta.rememberSpeed && typeof cur.spLastPlaybackRate === "number") rate = cur.spLastPlaybackRate;
        rate = clamp(rate, 0.25, 3.0);
        v.playbackRate = rate;
      } catch {}
    };

    v.addEventListener("loadedmetadata", apply, { once: true });
    v.addEventListener("ratechange", () => {
      if (!beta.rememberSpeed) return;
      // store globally
      const r = clamp(Number(v.playbackRate || 1), 0.25, 3.0);
      setSync({ spLastPlaybackRate: r });
    });
  }

  function setupSubtitles(v) {
    const beta = state.settings.beta || DEFAULTS.beta;
    if (!beta.enabled) return;

    const pref = (beta.subtitlesDefault || "auto").toLowerCase();
    if (!["auto","on","off"].includes(pref)) return;

    const apply = () => {
      const tracks = v.textTracks;
      if (!tracks || tracks.length === 0) return;

      if (pref === "auto") return; // leave Plex default
      for (const tr of tracks) {
        try { tr.mode = (pref === "on") ? "showing" : "disabled"; } catch {}
      }
    };

    v.addEventListener("loadedmetadata", apply);
  }

  function autoContinueWatchingTick() {
    const beta = state.settings.beta || DEFAULTS.beta;
    if (!beta.enabled || !beta.autoContinueWatching) return;

    const re = /\b(continue watching|still watching|continue)\b/i;
    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
    for (const b of buttons) {
      const txt = (b.innerText || b.textContent || "").trim();
      if (!txt || txt.length > 40) continue;
      if (!re.test(txt)) continue;
      if (!isVisible(b)) continue;
      try { b.click(); } catch {}
      break;
    }
  }

  function maybeAutoStartTimerOnPlay(v) {
    const beta = state.settings.beta || DEFAULTS.beta;
    if (!beta.enabled || !beta.autoStartTimerOnPlay) return;
    if (state.hasAutoStartedTimerThisSession) return;

    v.addEventListener("play", () => {
      if (state.timerRunning && state.remainingSec > 0) return;
      if (state.hasAutoStartedTimerThisSession) return;
      state.hasAutoStartedTimerThisSession = true;
      const mins = clamp(Number(beta.autoStartTimerMinutes || 30), 5, 360);
      startOrExtendTimer(mins * 60);
    }, { once: true });
  }

  /* -------------------- settings load + live updates -------------------- */
  async function loadSettings() {
    const raw = await getSync(STORAGE_KEYS);
    // merge defaults
    state.settings = {
      ...DEFAULTS,
      ...raw,
      episodeGuard: { ...DEFAULTS.episodeGuard, ...(raw.episodeGuard || {}) },
      beta: { ...DEFAULTS.beta, ...(raw.beta || {}) },
      perShowRules: raw.perShowRules || DEFAULTS.perShowRules
    };

    // set overlay visibility according to user pref (doesn't start/stop timer)
    setOverlayVisible(!!state.settings.countdownVisible);
    // apply overlay style prefs
    setOverlayOpacity(state.settings.overlayOpacity);
    state.overlayLocked = !!state.settings.overlayLocked;
    if (state.overlayHost) setOverlayLocked(state.overlayLocked);
    armOverlayAutoHide();
  }

  function onStorageChanged(changes, area) {
    if (area !== "sync") return;
    let shouldReload = false;
    for (const k of STORAGE_KEYS) {
      if (changes[k]) { shouldReload = true; break; }
    }
    if (!shouldReload) return;
    loadSettings().then(() => {
      // update overlay immediately
      renderOverlay();
    });
  }

  /* -------------------- message API (popup) -------------------- */
  function onMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "sp:state:get") {
      const v = getVideo();
      sendResponse({
        hasVideo: !!v,
        playing: isPlaying(v),
        seriesKey: state.seriesKey,
        seriesTitle: state.seriesTitle,
        timerRunning: state.timerRunning,
        timerRemainingSec: Math.max(0, Math.floor(state.remainingSec)),
        videoRemainingSec: (() => {
          try {
            const vv = v || getVideo();
            if (!vv || !Number.isFinite(vv.duration) || vv.duration <= 0) return 0;
            return Math.max(0, Math.floor((vv.duration - (vv.currentTime || 0))));
          } catch { return 0; }
        })(),
        overlayVisible: !!state.settings.countdownVisible
      });
      return true;
    }

    if (msg.type === "sp:timer:add") { startOrExtendTimer((msg.seconds || 0)); sendResponse({ ok: true }); return true; }
    if (msg.type === "sp:timer:set") { setTimerAbsolute((msg.seconds || 0)); sendResponse({ ok: true }); return true; }
    if (msg.type === "sp:timer:cancel") { stopTimer(false); sendResponse({ ok: true }); return true; }

    if (msg.type === "sp:overlay:refresh") { renderOverlay(); sendResponse({ ok: true }); return true; }

    if (msg.type === "sp:overlay:set") {
      // user toggled preference; we persist it, and setOverlayVisible will follow
      setSync({ countdownVisible: !!msg.visible }).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.type === "sp:automation:set") {
      setSync({ globalEnabled: !!msg.enabled }).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.type === "sp:action") {
      triggerSkip(msg.kind);
      sendResponse({ ok: true });
      return true;
    }
  }

  /* -------------------- boot -------------------- */
  async function boot() {
    await loadSettings();

    // series
    state.seriesKey = parseSeriesKeyFromUrl();
    state.seriesTitle = inferSeriesTitle();
    setLocal({ activeSeriesKey: state.seriesKey, activeSeriesTitle: state.seriesTitle });

    if (safeRuntime()) {
      chrome.storage.onChanged.addListener(onStorageChanged);
      chrome.runtime.onMessage.addListener(onMessage);
    }

    // Overlay is optional; only render it once a video exists (prevents showing on Plex home pages).
    if (state.settings.countdownVisible && getVideo()) {
      ensureOverlay();
      setOverlayVisible(true);
      renderOverlay();
    }


    // Auto-hide overlay: wake it on mouse move (top frame only)
    if (IS_TOP) {
      let lastMove = 0;
      document.addEventListener("mousemove", () => {
        const now = Date.now();
        if (now - lastMove < 350) return;
        lastMove = now;
        if (!state.overlayHost) return;
        if (!state.settings.countdownVisible) return;
        if (!state.settings.overlayAutoHide) return;
        bumpOverlay();
      }, { passive: true });
    }

    // periodic loops (lightweight)
    setInterval(() => {
      tick();
    }, 250);

    setInterval(() => {
      // Only attempt skipper if a video exists (prevents nav pages from being spammed)
      if (getVideo()) skipperLoop();
    }, 500);

    // Smart Next: run even if <video> disappears (Plex post-play / up-next screen).
    // Guarded so it won't spam on non-player pages.
    setInterval(() => {
      try {
        const s = state.settings || {};
        if (s.globalEnabled === false) return;
        const rules = currentRules();
        if (!rules.nextEpisode) return;
        if (!isLikelyPlayerContext()) return;
        // Prefer top frame, but allow subframes if they contain the Up Next UI (some Plex builds mount player UI in an iframe).
        if (!IS_TOP) {
          const hasUpNextUI = !!document.querySelector('[class*="UpNext"],[class*="AudioVideoUpNext"],[class*="Postplay"],#autoPlayCheck');
          if (!hasUpNextUI) return;
        }
        smartNextTryClickOnce(false);
      } catch {}
    }, 300);


    setInterval(() => {
      if (getVideo()) autoContinueWatchingTick();
    }, 1200);


    // Smart Next observer: reacts immediately when "Up Next" UI mounts.
    const nextMo = new MutationObserver(() => {
      try {
        const s = state.settings || {};
        if (s.globalEnabled === false) return;
        const rules = currentRules();
        if (!rules.nextEpisode) return;
        if (!isLikelyPlayerContext()) return;
        if (!IS_TOP) {
          const hasUpNextUI = !!document.querySelector('[class*="UpNext"],[class*="AudioVideoUpNext"],[class*="Postplay"],#autoPlayCheck');
          if (!hasUpNextUI) return;
        }
        smartNextTryClickOnce(false);
      } catch {}
    });
    try { nextMo.observe(document, { childList: true, subtree: true }); } catch {}

    // bind once when video appears
    const mo = new MutationObserver(() => {
      const v = getVideo();
      if (!v) return;

      // overlay (only when enabled)
      if (state.settings.countdownVisible) {
        ensureOverlay();
        setOverlayVisible(true);
        renderOverlay();
      }

      // beta hooks
      applyWakeLock(v);
      setupPauseOnHidden(v);
      setupAutoFullscreen(v);
      setupPlaybackSpeed(v);
      setupSubtitles(v);
      maybeAutoStartTimerOnPlay(v);

      // keep wake lock updated with play/pause
      v.addEventListener("play", () => applyWakeLock(v), { passive: true });
      v.addEventListener("pause", () => applyWakeLock(v), { passive: true });
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // initial if already present
    const v0 = getVideo();
    if (v0) {
      applyWakeLock(v0);
      setupPauseOnHidden(v0);
      setupAutoFullscreen(v0);
      setupPlaybackSpeed(v0);
      setupSubtitles(v0);
      maybeAutoStartTimerOnPlay(v0);
    }
  }

  boot();
})();