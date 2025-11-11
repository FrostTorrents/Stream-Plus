# 📦 Stream Plus

Smart **sleep timer** + **intro/credits skipper** for **Plex Web**.

- Minimal **floating overlay** you can **drag, resize, and fade**
- **Per-show rules** (intro/credits; optional lower volume)
- **Safe skipper** (clicks only when the label clearly matches)
- **Playback-aware timer** (pauses with the video; resumes on play)
- Everything is **local** (no accounts, no telemetry)

---

## 🔖 Versions

- **Chrome / Chromium: v2.0.0** (current)
- **Firefox (legacy 1.x)** – outdated but still functional; temporary install only

---

## 🧩 What’s inside

### 💤 Sleeper (popup tab)
- **Floating timer overlay** (tiny bar)
  - **Drag** to move (position saves)
  - **Resize** with the built-in handle (size saves)
  - **Shift + Mouse Wheel** changes opacity (saves)
- **Additive presets**: **+15m / +30m / +60m**, **−10m**, **Cancel**
- **Playback-aware**: countdown **only** while the video is playing
  - **Auto-pause** timer when video pauses or ends
  - **Auto-resume** timer on play
- **Optional**:
  - **Fade-to-Sleep** (volume ramps ~5% every 30s in the final minutes)
  - **Dim screen** on timer end
  - **Mute instead of pause** on timer end

### 🎬 Skipper (popup tab)
- **Per-Show Rules** (persisted per series)
  - **Skip Intro**
  - **Skip Credits**
  - **Lower volume during credits** (optional)
- **Series-wide Disable**: one click to disable automation for the entire series
- **Safe clicker**:
  - Clicks only if the overlay text matches **Intro / Recap / Opening / Credits / Outro**
  - When a rule is **off**, the button is **locked** (`pointer-events: none`)
  - Transport controls are ignored to avoid accidental 10s jumps
- **Better series matching** with canonicalized titles (stable across episodes)

### 🌍 Global (popup tab)
- **Enable all automation** (master switch)
- **Delay (ms) before clicking** skip buttons
- **Volume level (%)** used by volume-related features
- **Mute instead of pause** on timer end
- **Dim screen** on timer end

---

## 🗂️ Storage & Privacy

- Settings live in `chrome.storage` / `browser.storage`
- Per-show rules are saved by a **canonicalized, stable series key**
- Overlay position, size, and opacity are saved in `overlayState`
- **No analytics, no remote servers, no accounts**

---

## 🔐 Permissions

- `activeTab`, `scripting`, `storage`  
Used for overlay injection, safe skipper logic, and saving settings locally.

---

## 📥 Install

### 🧭 Chrome / Edge / Brave / Opera (v2.0.0)
1. Download the release ZIP or clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select the extension folder (where `manifest.json` lives)
5. Open **Plex Web** and pin **Stream Plus** for quick access

### 🦊 Firefox (legacy, temporary)
1. Download the ZIP and extract
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on** → pick `manifest.json`
4. Open **Plex Web**

> Firefox temporary add-ons unload on restart. Re-load as needed. Feature parity lags behind Chrome v2.0.0.

---

## 🚀 Quick start

1. Start playing something in **Plex Web**
2. Open the **popup → Sleeper**: toggle **Show floating timer overlay**, then tap **+15 / +30 / +60**
3. In **Skipper**, turn on **Skip Intro** / **Skip Credits** for that series
4. Drag/resize the overlay; Shift+Wheel to fade it — it’ll **remember** your prefs

---

## 🛠️ Troubleshooting

**Timer shows but doesn’t count down**  
- The timer only ticks while the video is **playing**. Hit Play to resume the countdown.

**Buttons in the popup do nothing**  
- Pin the extension and make sure the **Plex tab is active**.  
- If Plex is on a **local IP/hostname**, it’s supported; just keep the tab focused once to establish messaging.

**Skips happen even when rules are off**  
- Plex’s built-in **“Automatically skip intros”** might still jump. Disable that in Plex or keep our rules off for that series.

**Rules don’t stick**  
- Ensure your browser/profile doesn’t auto-clear site data on close.

**Firefox quirks**  
- Temporary add-ons unload on restart
- Some behaviors may differ from Chrome v2.0.0

---

## 🗺️ Roadmap

- Suggestions (local-only helper) — **returning in a future release**
- Settings export/import
- Optional tiny countdown in the Plex control bar
- Firefox parity with Chrome v2.x

---

## ☕ Support

If Stream Plus helps you binge more responsibly, consider a coffee:  
**https://square.link/u/JZUUls2L**

---

## 🤝 Contributing

Issues and PRs welcome! Keep changes small, safe by default, and easy to review.

---

## 📄 License

**MIT**
