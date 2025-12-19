# 📦 Stream Plus

Smart sleep timer + intro or credits skipper for Plex Web. Minimal overlay, per-show rules, and a safe skipper that only clicks when it’s clearly an intro, recap, opening, credits, or outro. No accounts, no telemetry.

---

## ✨ Why Stream Plus
- 🎯 Per-series control so it skips only when you want
- ⏱️ Timer pauses with playback and resumes on play
- ➕ Additive presets for fast stacking
- 🌙 Optional fade-to-sleep volume ramp

---

## 🧩 Features
- 🎛️ **Per-Show Rules chip**
  - 🎬 Skip intro
  - 🎞️ Skip credits
  - 🔉 Lower volume (optional)
  - 💾 Rules saved per series

- 🛡️ **Safer skipper**
  - ✅ Clicks only if overlay text matches Intro, Recap, Opening, Credits, or Outro and the series rule is on
  - 🔒 When a rule is off, the skip button is locked (`pointer-events: none`)
  - ⏭️ Transport controls ignored to prevent accidental 10s jumps
  - 🗂️ Better series title resolution with cached fallback

- 🪟 **Floating timer overlay**
  - 🧲 Tiny draggable bar, ~200×33
  - ➖ −10m   ➕ +10m   ✖ Cancel
  - 🖱️ Shift + wheel adjusts opacity
  - ⌚ Presets 15, 30, 60 are additive

- 🌗 **Fade to Sleep**
  - 🔊 Lowers volume ~5% every 30s during final minutes
  - ⏸️ Auto-pauses when the main timer is paused

- 🧱 **Episode Guard**
  - 🛑 Auto-stop after N consecutive episodes
  - 🔁 Counter resets after 10 minutes idle

- 🧠 **Binge Suggestions** *(Planned)*
  - 💡 Suggests Episode Guard values and quick continue picks

---

## 🧪 Compatibility
- 🖥️ Plex Web
- 🧭 Chromium-based browsers: Chrome, Edge, Brave, Opera
- 🦊 Firefox (legacy outdated compared to chrome version) (temporary install supported)

---

## 🔐 Permissions
- ⚙️ `activeTab`, `scripting`, `storage`
- 💾 Used for overlay injection, skipper logic, and saving settings
- 🏠 All data stays local in your browser

---

## 📥 Install

### 🧭 Chrome / Edge / Brave / Opera

1. ⬇️ Download the release zip or clone the repo
2. 🔧 Open `chrome://extensions`
3. 🧰 Enable **Developer mode**
4. 📂 Click **Load unpacked** and select the project folder
5. 🎞️ Open Plex Web
6. 📌 Pin **Stream Plus** from your extensions

### 🦊 Firefox (Temporary)

1. ⬇️ Download the ZIP and extract it
2. 🔧 Visit `about:debugging#/runtime/this-firefox`
3. 📂 Click **Load Temporary Add-on**
4. 🧩 Select `manifest.json` from the extracted folder
5. 🎞️ Open Plex Web and the extension will activate

> ⚠ Firefox unloads temporary extensions on browser restart — re-load it as needed

---

## ♻️ Update

- ⬆️ Pull or download the new release into the same folder
- 🔄 Visit `chrome://extensions` or `about:debugging#/runtime/this-firefox`
- 🔁 Reload the extension and refresh Plex

---

## 🚀 Quick start

1. ▶️ Start an episode or movie in Plex Web
2. ⏱️ Open the popup and pick a preset or set a custom time
3. 🎛️ Use the **Rules** chip to set **Skip intro** or **Skip credits** for that series
4. 🌗 Optional: enable **Fade to Sleep** or **Episode Guard** in **Beta**

---

## 📝 Notes on naming

- 🏷️ The project name is **Stream Plus** in code and docs
- 📦 The extension manifest name is **Stream Plus** starting with the next packaged build

---

## 💡 Tips

- ⚠️ If Plex has **Automatically skip intros** enabled, Plex may still jump the playhead  
  👉 Disable that in Plex settings or leave our overlay lock on for shows where you do not want skips
- 🧼 Unknown skip buttons are ignored unless a matching rule is on
- 🦊 On Firefox, the native **Skip Intro** button may become unclickable if auto-skip is disabled — a known issue

---

## 🛠️ Troubleshooting

- 🕶️ **Timer not visible**
  - ✅ Ensure the extension is loaded and the Plex tab is active
  - 🔃 Refresh the Plex page

- ⏩ **Skips happen when rules are off**
  - 🔍 Check Plex setting **Automatically skip intros**
  - 🔒 Keep **overlay lock** on for that show

- 📌 **Rules don’t stick**
  - 🍪 Ensure the browser isn’t clearing site data on close
  - 🔐 Confirm storage is allowed in your profile

- 🖱️ **Manual skip button not working in Firefox**
  - ❌ This may happen when auto-skip is off — it’s a known limitation in current builds

---

## 🗺️ Roadmap

- 🏷️ Manifest rename already planned and safe
- 📤 Export or import settings
- ⏳ Optional tiny countdown in the Plex control bar
- 🦊 Firefox build

---

## 🔏 Privacy

- 🚫 No accounts, no analytics, no remote servers
- 💽 All settings and rules live in `chrome.storage` on your machine

---

## 🤝 Contributing

- 🐛 Open issues for bugs or ideas
- 🔧 PRs welcome — keep code small, readable, and safe by default

---

## 📄 License

- 📝 MIT
