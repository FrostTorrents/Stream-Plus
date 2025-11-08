# Plex Plus ⏰⏭😴

A browser extension that makes Plex smarter for bedtime and binge sessions.

- Set a **sleep timer** with presets (now **additive**: each click stacks time).
- Auto-**skip intros/credits**.
- **Fade-to-sleep** and **episode guard** (beta).
- **Per-show rules** and local **binge suggestions**.

Everything runs locally in your browser — no accounts, no telemetry.

---

## ✨ What’s inside

### Core
- ⏰ **Sleep Timer** — Start a custom timer or use presets (15/30/60). Presets now **add** to the current time on each click.
- 🔕 **Mute Instead of Pause** — Choose to mute, pause, or **lower volume to a set level** at timeout.
- 🌙 **Dim Screen** — Optional dim overlay when the timer ends.
- ⏳ **On-Player Countdown** — Compact overlay shows the live time remaining.
- ➕➖ **Adjust on the Fly** — Add/subtract 10 minutes while the timer runs.
- 🛑 **Smart Start/Pause** — If the video isn’t playing when you start, the timer **waits**. Pausing playback **pauses** the timer; resuming playback resumes the countdown.

### Skipper
- ⏭ **Auto Skips** — Clicks **Skip Intro**, **Skip Credits**, and similar prompts automatically.
- 🧠 **Rule-aware** — Honors your **Per-Show Rules** (e.g., never skip intros for a specific show).

### Beta (toggle in the **Beta** tab)
- 🛡 **Episode Guard** — Auto-stop after **N** consecutive episodes; resets after >10 minutes idle.
- 🔈 **Fade-to-Sleep** — Gently lowers volume (~5% every 30s) during the final **N** minutes.
- 🎛 **Per-Show Rules** — Floating **Rules** chip on Plex pages to toggle:
  - Skip intro (per show)
  - Skip credits (per show)
  - Lower volume for this show
- 💡 **Binge Suggestions** — Local insights in the popup:
  - “You usually stop after ~N eps — set guard to N?”
  - “Keep watching” — recent titles from your history

> Beta features are **off by default** and can be enabled per your preference.

---

## 🚀 Getting started

1. Open **Plex Web** (`https://app.plex.tv`) in your browser.
2. Click the **Plex Plus** extension icon.
3. In **Sleep Timer**, pick a preset or set a custom duration.
4. (Optional) Open **Skipper** to enable automatic skip.
5. (Optional) Open **Beta** to flip on experimental features like Episode Guard.

> Tip: Clicking **15m/30m/60m** multiple times stacks the time (e.g., 15 + 15 + 30 → 60m).

---

## 🧩 Install (unpacked)

Until published in the store:

1. Download this repository (Code → Download ZIP) and extract it.
2. In Chrome/Edge, go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.
5. Open Plex and use the extension.

---

## 🔐 Privacy

- No accounts, no analytics, no remote requests.
- All data (settings, per-show rules, local watch history for suggestions) stays in **`chrome.storage.local`**.
- Permissions are minimal and extension-scoped.

**Permissions used**
- `activeTab` — to message the active Plex tab.
- `scripting` — to run content scripts on Plex pages.
- `storage` — to save settings and local history.
- `host_permissions: https://*.plex.tv/*` — only Plex sites.

---

## 🛠 Troubleshooting

- **Timer doesn’t start?** If your video is paused, the timer waits in “Waiting” state and auto-starts when playback begins.
- **Skips not clicking?** Ensure **Skipper** is enabled in the popup. UI changes in Plex may occasionally move buttons; we try multiple selectors.
- **No “Rules” chip?** Enable **Beta → Per-Show Rules** and open a show playback page; the chip appears in the top-right.
- **Icons missing?** Verify icon paths in `manifest.json` or remove the `icons` entries temporarily.

---

## 📝 Changelog

See **`CHANGELOG.md`** for version history.  
Latest: **v1.3.0 (2025-11-08)** — rename to Plex Plus, Beta tab, Episode Guard, Fade-to-Sleep, Per-Show Rules, Binge Suggestions, additive presets, smarter timer start/pause.

---

## 🤝 Contributing

Issues and PRs are welcome. Please keep features **local-only** and respect the privacy first approach.

---

## 📄 License

MIT — do what you like; attribution appreciated.
