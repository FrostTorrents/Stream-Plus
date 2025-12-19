// popup.js — Stream Plus v5
// Redesigned popup with Now/Timer/Automation/Beta/Global tabs.

const SYNC_KEYS = [
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
    subtitlesDefault: "auto",
    autoContinueWatching: true
  }
};

let activeSeriesKey = "unknown";
let activeSeriesTitle = "Unknown";

document.addEventListener("DOMContentLoaded", init);

function $(id) { return document.getElementById(id); }

function wireTabs() {
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      const key = t.dataset.tab;
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      $(`panel-${key}`).classList.add("active");
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToActiveTab(msg) {
  return new Promise(async (resolve) => {
    try {
      const tab = await getActiveTab();
      if (!tab?.id) return resolve(null);
      chrome.tabs.sendMessage(tab.id, msg, (res) => resolve(res || null));
    } catch {
      resolve(null);
    }
  });
}

async function getSync() {
  const raw = await new Promise((resolve) => chrome.storage.sync.get(SYNC_KEYS, resolve));
  const merged = {
    ...DEFAULTS,
    ...raw,
    beta: { ...DEFAULTS.beta, ...(raw.beta || {}) },
    perShowRules: raw.perShowRules || {}
  };
  return merged;
}
async function setSync(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, resolve));
}
async function getLocal() {
  return new Promise((resolve) => chrome.storage.local.get(["activeSeriesKey","activeSeriesTitle"], resolve));
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${m}:${String(s).padStart(2,"0")}`;
}

function setDot(el, mode) {
  el.classList.remove("good","bad","warn");
  if (mode) el.classList.add(mode);
}

async function refreshChips(settings) {
  const st = await sendToActiveTab({ type: "sp:state:get" });
  // automation
  $("autoChip").textContent = settings.globalEnabled ? "Automation" : "Automation off";
  setDot($("autoDot"), settings.globalEnabled ? "good" : "bad");

  // overlay
  $("overlayChip").textContent = settings.countdownVisible ? "Overlay" : "Overlay off";
  setDot($("overlayDot"), settings.countdownVisible ? "good" : "bad");

  // timer
  if (st && st.timerRunning) {
    $("timerChip").textContent = fmtTime(st.timerRemainingSec);
    setDot($("timerDot"), st.timerRemainingSec <= 60 ? "warn" : "good");
  } else {
    $("timerChip").textContent = "—";
    setDot($("timerDot"), "bad");
  }

  // series line
  const title = (st?.seriesTitle || activeSeriesTitle || "Unknown").trim();
  $("seriesLine").textContent = title;
  activeSeriesKey = st?.seriesKey || activeSeriesKey || "unknown";
  $("seriesKeyLine").textContent = `key: ${activeSeriesKey}`;
}

function currentRules(settings) {
  const r = (settings.perShowRules || {})[activeSeriesKey] || {};
  return {
    skipIntro: r.skipIntro ?? true,
    skipCredits: r.skipCredits ?? true,
    nextEpisode: r.nextEpisode ?? true
  };
}

async function init() {
  wireTabs();

  // pull last-known series from local storage (content script keeps it updated)
  const loc = await getLocal();
  activeSeriesKey = loc.activeSeriesKey || "unknown";
  activeSeriesTitle = loc.activeSeriesTitle || "Unknown";
  $("seriesLine").textContent = activeSeriesTitle;
  $("seriesKeyLine").textContent = `key: ${activeSeriesKey}`;

  // load settings
  const settings = await getSync();

  // populate UI
  await refreshChips(settings);

  // quick actions
  $("btnSkipIntro").addEventListener("click", () => sendToActiveTab({ type: "sp:action", kind: "intro" }));
  $("btnSkipCredits").addEventListener("click", () => sendToActiveTab({ type: "sp:action", kind: "credits" }));
  $("btnNext").addEventListener("click", () => sendToActiveTab({ type: "sp:action", kind: "next" }));
  $("btnToggleAuto").addEventListener("click", async () => {
    const cur = await getSync();
    await setSync({ globalEnabled: !cur.globalEnabled });
    await sendToActiveTab({ type: "sp:automation:set", enabled: !cur.globalEnabled });
    const s2 = await getSync();
    await refreshChips(s2);
    populatePerSeries(s2);
  });

  // timer buttons
  $("tAdd5").addEventListener("click", () => sendToActiveTab({ type: "sp:timer:add", seconds: 5*60 }));
  $("tAdd15").addEventListener("click", () => sendToActiveTab({ type: "sp:timer:add", seconds: 15*60 }));
  $("tAdd30").addEventListener("click", () => sendToActiveTab({ type: "sp:timer:add", seconds: 30*60 }));
  $("tAdd60").addEventListener("click", () => sendToActiveTab({ type: "sp:timer:add", seconds: 60*60 }));
  $("tSub10").addEventListener("click", () => sendToActiveTab({ type: "sp:timer:add", seconds: -10*60 }));
  $("tCancel").addEventListener("click", () => sendToActiveTab({ type: "sp:timer:cancel" }));

  $("tToEnd").addEventListener("click", async () => {
    const st = await sendToActiveTab({ type: "sp:state:get" });
    const rem = Number(st?.videoRemainingSec || 0);
    if (rem > 1) {
      await sendToActiveTab({ type: "sp:timer:set", seconds: rem });
    }
  });

  $("tDefaultStart").addEventListener("click", async () => {
    const sync = await getSync();
    const min = Math.max(1, Math.min(360, Number(sync.timerDefaultMin || 30)));
    await sendToActiveTab({ type: "sp:timer:set", seconds: min * 60 });
  });

  // global toggles / values
  $("showOverlay").checked = !!settings.countdownVisible;
  $("showOverlay").addEventListener("change", async (e) => {
    const v = !!e.target.checked;
    await setSync({ countdownVisible: v });


  $("timerDefaultMin").value = Number(settings.timerDefaultMin ?? 30);
  $("timerDefaultMin").addEventListener("change", async (e) => {
    const v = Math.max(1, Math.min(360, Number(e.target.value || 30)));
    e.target.value = v;
    await setSync({ timerDefaultMin: v });
  });

  // timer end behavior
  const setReduceRowVis = (action) => {
    const row = $("reduceRow");
    if (!row) return;
    row.style.display = (action === "reduce") ? "flex" : "none";
  };

  const action = (settings.timerEndAction) || (settings.muteInsteadOfPause ? "mute" : "pause");
  $("timerEndAction").value = action;
  setReduceRowVis(action);

  $("timerEndAction").addEventListener("change", async (e) => {
    const v = (e.target.value || "pause");
    setReduceRowVis(v);
    await setSync({
      timerEndAction: v,
      // keep legacy key in sync for backwards compat
      muteInsteadOfPause: (v === "mute")
    });
    await sendToActiveTab({ type: "sp:overlay:refresh" });
  });

  $("reduceAudioLevel").value = Number(settings.reduceAudioLevel ?? 10);
  $("reduceAudioLevel").addEventListener("change", async (e) => {
    const v = Math.max(0, Math.min(100, Number(e.target.value || 10)));
    e.target.value = v;
    await setSync({ reduceAudioLevel: v, timerEndAction: "reduce", muteInsteadOfPause: false });
    $("timerEndAction").value = "reduce";
    setReduceRowVis("reduce");
    await sendToActiveTab({ type: "sp:overlay:refresh" });
  });
    await sendToActiveTab({ type: "sp:overlay:set", visible: v });
    await refreshChips(await getSync());
  });

    $("dimEnd").checked = !!settings.dimScreen;
  $("dimEnd").addEventListener("change", async (e) => {
    await setSync({ dimScreen: !!e.target.checked });
  });

  $("globalEnabled").checked = !!settings.globalEnabled;
  $("globalEnabled").addEventListener("change", async (e) => {
    const v = !!e.target.checked;
    await setSync({ globalEnabled: v });
    await sendToActiveTab({ type: "sp:automation:set", enabled: v });
    await refreshChips(await getSync());
  });

  $("delayMs").value = Number(settings.skipDelayMs ?? 500);
  $("delayMs").addEventListener("change", async (e) => {
    const v = Math.max(0, Math.min(5000, Number(e.target.value || 0)));
    e.target.value = v;
    await setSync({ skipDelayMs: v });

  $("defaultSkipIntro").checked = !!settings.defaultSkipIntro;
  $("defaultSkipIntro").addEventListener("change", async (e) => {
    await setSync({ defaultSkipIntro: !!e.target.checked });
  });

  $("defaultSkipCredits").checked = !!settings.defaultSkipCredits;
  $("defaultSkipCredits").addEventListener("change", async (e) => {
    await setSync({ defaultSkipCredits: !!e.target.checked });
  });

  $("defaultNextEpisode").checked = !!settings.defaultNextEpisode;
  $("defaultNextEpisode").addEventListener("change", async (e) => {
    await setSync({ defaultNextEpisode: !!e.target.checked });
  });

  $("minAutoCooldownMs").value = Number(settings.minAutoCooldownMs ?? 600);
  $("minAutoCooldownMs").addEventListener("change", async (e) => {
    const v = Math.max(100, Math.min(5000, Number(e.target.value || 600)));
    e.target.value = v;
    await setSync({ minAutoCooldownMs: v });
  });

  $("debugLogs").checked = !!settings.debugLogs;
  $("debugLogs").addEventListener("change", async (e) => {
    await setSync({ debugLogs: !!e.target.checked });
  });
  });

  $("volumeLevel").value = Number(settings.volumeLevel ?? 50);
  $("volumeLevel").addEventListener("change", async (e) => {
    const v = Math.max(0, Math.min(100, Number(e.target.value || 0)));
    e.target.value = v;
    await setSync({ volumeLevel: v });
  });


  // Global: automation safety
  if ($("activeTabOnly")) {
    $("activeTabOnly").checked = settings.activeTabOnly !== false;
    $("activeTabOnly").addEventListener("change", async (e) => {
      await setSync({ activeTabOnly: !!e.target.checked });
    });
  }

  if ($("nextLatePhasePct")) {
    $("nextLatePhasePct").value = Number(settings.nextLatePhasePct ?? 80);
    $("nextLatePhasePct").addEventListener("change", async (e) => {
      const v = Math.max(50, Math.min(98, Number(e.target.value || 80)));
      e.target.value = v;
      await setSync({ nextLatePhasePct: v });
    });
  }

  // Global: overlay behavior
  if ($("overlayOpacity")) {
    $("overlayOpacity").value = Number(settings.overlayOpacity ?? 1.0);
    $("overlayOpacity").addEventListener("change", async (e) => {
      const v = Math.max(0.25, Math.min(1, Number(e.target.value || 1)));
      e.target.value = v;
      await setSync({ overlayOpacity: v });
    });
  }

  if ($("overlayAutoHide")) {
    $("overlayAutoHide").checked = !!settings.overlayAutoHide;
    $("overlayAutoHide").addEventListener("change", async (e) => {
      await setSync({ overlayAutoHide: !!e.target.checked });
    });
  }

  if ($("overlayAutoHideSec")) {
    $("overlayAutoHideSec").value = Number(settings.overlayAutoHideSec ?? 4);
    $("overlayAutoHideSec").addEventListener("change", async (e) => {
      const v = Math.max(1, Math.min(15, Number(e.target.value || 4)));
      e.target.value = v;
      await setSync({ overlayAutoHideSec: v });
    });
  }

  if ($("overlaySnap")) {
    $("overlaySnap").checked = settings.overlaySnap !== false;
    $("overlaySnap").addEventListener("change", async (e) => {
      await setSync({ overlaySnap: !!e.target.checked });
    });
  }

  if ($("overlayShowEndTime")) {
    $("overlayShowEndTime").checked = settings.overlayShowEndTime !== false;
    $("overlayShowEndTime").addEventListener("change", async (e) => {
      await setSync({ overlayShowEndTime: !!e.target.checked });
    });
  }

  if ($("overlayShowAdd5")) {
    $("overlayShowAdd5").checked = !!settings.overlayShowAdd5;
    const apply = (on) => {
      const b = $("tAdd5");
      if (b) b.style.display = on ? "" : "none";
    };
    apply(!!settings.overlayShowAdd5);
    $("overlayShowAdd5").addEventListener("change", async (e) => {
      const on = !!e.target.checked;
      apply(on);
      await setSync({ overlayShowAdd5: on });
    });
  }


  if ($("overlayShowVideoLeft")) {
    $("overlayShowVideoLeft").checked = !!settings.overlayShowVideoLeft;
    $("overlayShowVideoLeft").addEventListener("change", async (e) => {
      await setSync({ overlayShowVideoLeft: !!e.target.checked });
      await sendToActiveTab({ type: "sp:overlay:refresh" });
    });
  }

  if ($("overlayShowActions")) {
    $("overlayShowActions").checked = !!settings.overlayShowActions;
    $("overlayShowActions").addEventListener("change", async (e) => {
      await setSync({ overlayShowActions: !!e.target.checked });
      await sendToActiveTab({ type: "sp:overlay:refresh" });
    });
  }


  // Global: timer end chime
  if ($("timerEndChime")) {
    $("timerEndChime").checked = !!settings.timerEndChime;
    $("timerEndChime").addEventListener("change", async (e) => {
      await setSync({ timerEndChime: !!e.target.checked });
    });
  }

  if ($("timerEndChimeVolume")) {
    $("timerEndChimeVolume").value = Number(settings.timerEndChimeVolume ?? 40);
    $("timerEndChimeVolume").addEventListener("change", async (e) => {
      const v = Math.max(0, Math.min(100, Number(e.target.value || 40)));
      e.target.value = v;
      await setSync({ timerEndChimeVolume: v });
    });
  }

  // per-series toggles
  populatePerSeries(settings);

  $("seriesSkipIntro").addEventListener("change", async (e) => setPerSeriesRule("skipIntro", !!e.target.checked));
  $("seriesSkipCredits").addEventListener("change", async (e) => setPerSeriesRule("skipCredits", !!e.target.checked));
  $("seriesNextEpisode").addEventListener("change", async (e) => setPerSeriesRule("nextEpisode", !!e.target.checked));

  // beta
  populateBeta(settings);
  bindBetaHandlers();

  // open options
  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // refresh chips periodically (so timer updates while popup open)
  setInterval(async () => {
    const s = await getSync();
    await refreshChips(s);
  }, 900);
}

function populatePerSeries(settings) {
  const r = currentRules(settings);
  $("seriesSkipIntro").checked = !!r.skipIntro;
  $("seriesSkipCredits").checked = !!r.skipCredits;
  $("seriesNextEpisode").checked = !!r.nextEpisode;
}

async function setPerSeriesRule(key, val) {
  const settings = await getSync();
  const per = settings.perShowRules || {};
  const cur = per[activeSeriesKey] || {};
  per[activeSeriesKey] = { ...cur, [key]: val };
  await setSync({ perShowRules: per });
}

function populateBeta(settings) {
  const b = settings.beta || DEFAULTS.beta;
  $("betaEnabled").checked = !!b.enabled;

  $("betaAutoStartTimer").checked = !!b.autoStartTimerOnPlay;
  $("betaAutoStartMins").value = Number(b.autoStartTimerMinutes ?? 30);

  $("betaFade").checked = !!b.fadeBeforeTimerEnd;
  $("betaFadeSec").value = Number(b.fadeSeconds ?? 20);

  $("betaRememberSpeed").checked = !!b.rememberSpeed;
  $("betaDefaultSpeed").value = Number(b.defaultSpeed ?? 1.0);

  $("betaSubs").value = String(b.subtitlesDefault || "auto");

  $("betaWakeLock").checked = !!b.wakeLock;
  $("betaPauseHidden").checked = !!b.pauseOnHidden;
  $("betaPauseHiddenSec").value = Number(b.pauseOnHiddenSec ?? 10);
  if ($("betaResumeVisible")) $("betaResumeVisible").checked = !!b.resumeOnVisible;

  $("betaFullscreen").checked = !!b.autoFullscreen;
  $("betaContinue").checked = !!b.autoContinueWatching;

  setBetaDisabledUI(!b.enabled);
}

function setBetaDisabledUI(disabled) {
  const ids = [
    "betaAutoStartTimer","betaAutoStartMins",
    "betaFade","betaFadeSec",
    "betaRememberSpeed","betaDefaultSpeed",
    "betaSubs",
    "betaWakeLock",
    "betaPauseHidden","betaResumeVisible","betaPauseHiddenSec",
    "betaFullscreen",
    "betaContinue"
  ];
  for (const id of ids) {
    $(id).disabled = disabled;
    if (disabled) $(id).closest?.(".row")?.classList?.add?.("disabled");
  }
}

function bindBetaHandlers() {
  $("betaEnabled").addEventListener("change", async (e) => {
    const settings = await getSync();
    const b = { ...(settings.beta || DEFAULTS.beta), enabled: !!e.target.checked };
    await setSync({ beta: b });
    setBetaDisabledUI(!b.enabled);
  });

  const bind = (id, key, parser = (v)=>v) => {
    $(id).addEventListener("change", async (e) => {
      const settings = await getSync();
      const b = { ...(settings.beta || DEFAULTS.beta), [key]: parser(e.target) };
      await setSync({ beta: b });
    });
  };

  bind("betaAutoStartTimer", "autoStartTimerOnPlay", (t)=>!!t.checked);
  bind("betaAutoStartMins", "autoStartTimerMinutes", (t)=>Math.max(5, Math.min(360, Number(t.value||30))));
  bind("betaFade", "fadeBeforeTimerEnd", (t)=>!!t.checked);
  bind("betaFadeSec", "fadeSeconds", (t)=>Math.max(3, Math.min(180, Number(t.value||20))));
  bind("betaRememberSpeed", "rememberSpeed", (t)=>!!t.checked);
  bind("betaDefaultSpeed", "defaultSpeed", (t)=>Math.max(0.25, Math.min(3, Number(t.value||1))));
  bind("betaSubs", "subtitlesDefault", (t)=>String(t.value||"auto"));
  bind("betaWakeLock", "wakeLock", (t)=>!!t.checked);
  bind("betaPauseHidden", "pauseOnHidden", (t)=>!!t.checked);
  bind("betaPauseHiddenSec", "pauseOnHiddenSec", (t)=>Math.max(3, Math.min(600, Number(t.value||10))));
  bind("betaResumeVisible", "resumeOnVisible", (t)=>!!t.checked);
  bind("betaFullscreen", "autoFullscreen", (t)=>!!t.checked);
  bind("betaContinue", "autoContinueWatching", (t)=>!!t.checked);
}
