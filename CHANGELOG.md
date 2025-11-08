# 📦 Stream Plus — Changelog _(formerly Plex Plus)_

All notable changes to this project will be documented in this file.

---

## [Unreleased] – Rebrand prep (no code release yet)

### 🏷 Renamed
- Project name changed from **Plex Plus** to **Stream Plus** across README, Wiki, and in-app/UI text (popup title, toasts, overlay labels).

### 📌 Notes
- The browser extension **manifest `"name"` will switch to “Stream Plus” in the next code update**.
- No functional changes in this entry; brand/copy updates only.  
- Storage keys and settings are unchanged; no migration needed.

---

## [v1.3.0] – 2025-11-08

### 🏷 Renamed
- Project renamed from **Plex Sleep Timer** to **Plex Plus**.

### ✨ Added
- **Beta tab** in the popup with a master toggle.
- **Episode Guard**: auto-stop after _N_ consecutive episodes; counter resets after >10 minutes of inactivity.
- **Fade-to-Sleep**: progressively reduces volume (~5% every 30s) during the final _N_ minutes of the timer.
- **Per-Show Rules**: floating **Rules** chip on Plex pages to toggle “skip intro”, “skip credits”, and optional “lower volume” per series.
- **Skipper honors rules**: intro/credits skipping respects the per-show settings.
- **Binge Suggestions** (local-only): cards in the Beta tab that (a) suggest an Episode Guard value based on your habits, and (b) surface “keep watching” titles from recent history.
- **Additive presets**: 15m/30m/60m buttons now **increment** the timer each click (e.g., 15m + 15m + 30m → 60m).

### 🔁 Changed
- **Timer behavior**: starting a timer while the video is **paused** now pauses the timer (“Waiting”) and auto-resumes when playback starts. Pausing video mid-timer also pauses the countdown; resuming playback resumes the timer.
- **UI polish**: refreshed popup styling (cards, pills, fieldsets).

### 🧹 Internal
- Refactored content script to support paused/resumed timer state, and to gate fade logic while paused.

---

## [v1.2.0] – 2025-10-31

### ✨ Added
- **Skipper Automation** tab in the popup UI
- Auto-click for:
  - 🎬 Skip Intro
  - 🎞 Skip Credits
  - ⏭ Play Next Episode
- MutationObserver integration for real-time DOM updates
- Simulated mouse events for robust button clicking
- Playback progress awareness to distinguish intro vs credits
- Configurable delay (ms) between skip checks
- Persistent enable/disable state and delay via `chrome.storage`

---

## [v1.1.0] – 2025-10-25

### ✨ Added
- Option to **lower volume** instead of pausing or muting
- Volume level selector input (%)
- Option persists across sessions

---

## [v1.0.0] – 2025-10-20

### 🎉 Initial Release
- Sleep timer with custom time input
- Preset buttons: 15m, 30m, 60m
- Mute instead of pause toggle
- Dim screen when timer ends
- Countdown display toggle
- Timer history logging
