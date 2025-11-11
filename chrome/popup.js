/* popup.js – unified "Rules & Skip" tab (stable) + Sleep/Beta tabs */

const $  = (id) => document.getElementById(id);
const q  = (sel, root=document) => root.querySelector(sel);
const qa = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

qa(".tab-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    qa(".tab-button").forEach((b) => b.classList.remove("active"));
    qa(".tab-content").forEach((c) => (c.style.display = "none"));
    btn.classList.add("active");
    const tabId = btn.dataset.tab;
    $(tabId).style.display = "block";
  });
});

// ---------------- Defaults ----------------
const TIMER_DEFAULTS = {
  timerMinutes: 60,
  muteInsteadOfPause: false,
  dimScreen: false,
  countdownToggle: true,
  lowerVolumeCheckbox: false,
  volumeLevelInput: 10, // percent
};

const RULES_DEFAULTS = {
  enableSkipper: true,
  enablePlayNext: true,
  skipperDelay: 600,
  perShowEn: true,      // <- now stable, default ON
};

const BETA_DEFAULTS = {
  betaMaster: false,
  episodeGuardEn: false,
  episodeGuardN: 3,
  fadeEn: false,
  fadeMinutes: 5,
};

// --------------- Storage helpers ---------------
const getAll = (keys, fallbacks) =>
  new Promise((resolve) => chrome.storage.local.get(keys, (d) => resolve({ ...fallbacks, ...d })));
const setAll = (payload) =>
  new Promise((resolve) => chrome.storage.local.set(payload, resolve));

async function getActivePlexTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0] || null;
      const isPlex = !!(tab?.url && /^https:\/\/(.*\.)?plex\.tv/i.test(tab.url));
      resolve(isPlex ? tab : null);
    });
  });
}

// ============================================================================
// Sleep Timer
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  await hydrateTimerUI();
  await hydrateRulesUI();
  await hydrateBetaUI();

  wireTimerUI();
  wireRulesUI();
  wireBetaUI();

  renderBingeCards(); // optional helper in long file (safe if no-op)
});

// ---------- Timer UI ----------
async function hydrateTimerUI() {
  const s = await getAll(Object.keys(TIMER_DEFAULTS), TIMER_DEFAULTS);
  $("timerInput").value = s.timerMinutes;
  $("muteInsteadOfPause").checked = s.muteInsteadOfPause;
  $("dimScreen").checked = s.dimScreen;
  $("countdownToggle").checked = s.countdownToggle;
  $("lowerVolumeCheckbox").checked = s.lowerVolumeCheckbox;
  $("volumeLevelInput").value = s.volumeLevelInput;
  $("volumeLevelContainer").style.display = s.lowerVolumeCheckbox ? "block" : "none";

  qa(".preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const inc = parseInt(btn.dataset.minutes, 10);
      const input = $("timerInput");
      const max = parseInt(input.max || "480", 10);
      const prev = Math.max(0, parseInt(input.value || "0", 10));
      const next = clamp(prev + inc, 1, max);
      input.value = next;
      $("statusMessage").textContent = `+${inc}m → ${next}m total`;
    });
  });
}

function wireTimerUI() {
  $("lowerVolumeCheckbox").addEventListener("change", (e) => {
    $("volumeLevelContainer").style.display = e.target.checked ? "block" : "none";
  });

  $("startBtn").addEventListener("click", async () => {
    const minutes = Math.max(1, parseInt($("timerInput").value || "60", 10));
    const endTime = Date.now() + minutes * 60 * 1000;

    const options = {
      mute: $("muteInsteadOfPause").checked,
      dim: $("dimScreen").checked,
      showCountdown: $("countdownToggle").checked,
      lowerVolume: $("lowerVolumeCheckbox").checked,
      volumeLevel: Math.min(100, Math.max(0, parseInt($("volumeLevelInput").value || "10", 10))) / 100,
    };

    await setAll({
      timerMinutes: minutes,
      muteInsteadOfPause: options.mute,
      dimScreen: options.dim,
      countdownToggle: options.showCountdown,
      lowerVolumeCheckbox: options.lowerVolume,
      volumeLevelInput: Math.round(options.volumeLevel * 100),
      plexSleepEndTime: endTime,
      plexSleepOptions: options,
    });

    const tab = await getActivePlexTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: "start_timer", endTime, options });
      $("statusMessage").textContent = `⏱️ Timer started for ${minutes} minutes`;
    } else {
      $("statusMessage").textContent = "⚠️ Please open a Plex tab before starting the timer.";
    }
  });

  $("cancelBtn").addEventListener("click", async () => {
    const tab = await getActivePlexTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: "cancel_timer" });
      $("statusMessage").textContent = "❌ Timer canceled";
    } else {
      $("statusMessage").textContent = "⚠️ No Plex tab found.";
    }
    await setAll({ plexSleepEndTime: 0 });
  });
}

// ============================================================================
// Rules & Skip (stable)
// ============================================================================
async function hydrateRulesUI() {
  const s = await getAll(Object.keys(RULES_DEFAULTS), RULES_DEFAULTS);
  $("enableSkipper").checked = s.enableSkipper;
  $("enablePlayNext").checked = s.enablePlayNext;
  $("skipperDelay").value = s.skipperDelay;
  $("perShowEn").checked = s.perShowEn;
}

function wireRulesUI() {
  $("saveRulesSettings").addEventListener("click", async () => {
    const payload = {
      enableSkipper: $("enableSkipper").checked,
      enablePlayNext: $("enablePlayNext").checked,
      skipperDelay: Math.max(100, parseInt($("skipperDelay").value || "600", 10)),
      perShowEn: $("perShowEn").checked,
    };
    await setAll(payload);

    const tab = await getActivePlexTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: "rules_settings_updated" });
    }

    $("rulesStatus").textContent = "✅ Rules & Skip saved";
    setTimeout(() => ($("rulesStatus").textContent = ""), 1500);
  });

  // Convenience: open the in-page Rules chip
  $("openRulesForThisShow").addEventListener("click", async () => {
    const tab = await getActivePlexTab();
    if (!tab) {
      $("rulesStatus").textContent = "⚠️ Open a Plex tab first";
      return;
    }
    chrome.tabs.sendMessage(tab.id, { action: "open_rules_popover" });
    $("rulesStatus").textContent = "🎛 Opening rules in Plex…";
    setTimeout(() => ($("rulesStatus").textContent = ""), 1800);
  });
}

// ============================================================================
// Beta (per-show rules removed from here)
// ============================================================================
async function hydrateBetaUI() {
  const s = await getAll(Object.keys(BETA_DEFAULTS), BETA_DEFAULTS);
  $("betaMaster").checked = s.betaMaster;
  $("episodeGuardEn").checked = s.episodeGuardEn;
  $("episodeGuardN").value = s.episodeGuardN;
  $("fadeEn").checked = s.fadeEn;
  $("fadeMinutes").value = s.fadeMinutes;
}

function wireBetaUI() {
  $("saveBeta").addEventListener("click", async () => {
    const payload = {
      betaMaster: $("betaMaster").checked,
      episodeGuardEn: $("episodeGuardEn").checked,
      episodeGuardN: Math.max(1, parseInt($("episodeGuardN").value || "3", 10)),
      fadeEn: $("fadeEn").checked,
      fadeMinutes: Math.max(1, parseInt($("fadeMinutes").value || "5", 10)),
    };
    await setAll(payload);

    const tab = await getActivePlexTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: "beta_settings_updated" });
    }

    $("betaStatus").textContent = "✅ Beta settings saved";
    setTimeout(() => ($("betaStatus").textContent = ""), 1500);
  });
}

// (Optional) simple toast used elsewhere in long file
function toast(msg) {
  $("statusMessage").textContent = msg;
}

// Stub so the file stays drop-in compatible if you had this function
async function renderBingeCards() {}

// --- Donate button handler (Square link) ---
(() => {
  const btn = document.getElementById("donateBtn");
  if (!btn) return;

  const url = btn.getAttribute("data-url") || "https://square.link/u/JZUUls2L";

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    try {
      if (typeof chrome !== "undefined" && chrome?.tabs?.create) {
        chrome.tabs.create({ url });
      } else if (typeof browser !== "undefined" && browser?.tabs?.create) {
        browser.tabs.create({ url });
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (_) {
      try { window.open(url, "_blank"); } catch(__) {}
    }
  });
})();
