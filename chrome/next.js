// next.js — "Play Next / Next Episode" skipper (series-key aware; transport-safe + FORCE-REVEAL)
// Plex-tuned:
//   - Fast path: click [AudioVideoUpNext-poster] Play Next button when autoPlayCheck is checked
//   - Generic path: only click elements whose OWN label mentions "next"
//   - Never clicks playlist/context menus or transport controls

(() => {
  if (window.__SMART_NEXT_SKIPPER__) return;
  window.__SMART_NEXT_SKIPPER__ = true;

  let settings = {};
  let seriesTitle = '';
  let mo = null;
  let pollTimer = null;

  const POLL_MS = 250;
  const CLICK_COOLDOWN_MS = 300;
  let lastClickTs = 0;

  const NEXT_WORDS = /\b(play\s*next|next\s*episode|watch\s*next|continue(?!\s*watching\s*from)|continue\s*to\s*next|up\s*next)\b/i;
  const NEGATIVE_WORDS = /\b(autoplay\s*(on|off)?|settings|preferences|audio|subtitles|resume)\b/i;

  // transport exclusions
  const TRANSPORT_LABEL_NEG = /\b(10\s*(sec|seconds)|ten\s*seconds|seek|scrub|timeline|progress|jump|rewind|replay\s*10|forward\s*10|skip\s*(ahead|back)\s*10)\b/i;
  const TRANSPORT_CLASS_NEG = /(Transport|control|Controls|Seek|SkipForward|SkipBack|Replay|Timeline|Scrub|Progress|OSD)/i;

  // class names commonly used to hide elements
  const HIDE_CLASSES = ['hidden','opacity-0','invisible','sr-only','is-hidden','u-hidden','visually-hidden'];

  // ----- menu / context guard -----
  function isInMenuOrContext(el) {
    return !!el.closest(
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

  // Public API
  window.initNextSkipper = function initNextSkipper(loadedSettings, currentSeries) {
    settings = loadedSettings || {};
    seriesTitle = (currentSeries || 'Unknown Series').trim();
    if (!isEnabledForSeries()) return;
    start();
  };

  window.updateNextSettings = function updateNextSettings(newSettings, currentSeries) {
    settings = newSettings || settings;
    if (currentSeries) seriesTitle = currentSeries;
  };

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync') return;
    Object.keys(changes).forEach(k => (settings[k] = changes[k].newValue));
  });

  // ---- canonicalize + normalize -> stable series key ----
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

  function normalizeTitle(s) {
    return (s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]+/gu, '')
      .trim();
  }

  function seriesKeyFrom(title) {
    return normalizeTitle(canonicalizeSeriesTitle(title));
  }

  function isEnabledForSeries() {
    if (settings.globalEnabled === false) return false;

    // series-wide disable set
    const key = seriesKeyFrom(seriesTitle);
    const disabledKeys = settings?.disabledSeriesKeys || [];
    if (disabledKeys.includes(key)) return false;

    // per-show playNext (default true)
    const byKey = settings?.perShowRulesByKey || {};
    const r = byKey[key] ||
              (settings?.perShowRules || {})[seriesTitle] || null;

    const playNext = (r && r.playNext !== false) || (r == null); // default true
    const globalOn = settings.playNextEnabled !== false;         // default true
    return globalOn && playNext;
  }

  function start() {
    if (mo) mo.disconnect();
    if (pollTimer) clearInterval(pollTimer);

    mo = new MutationObserver(() => tryClickOnce());
    mo.observe(document, { childList: true, subtree: true });

    pollTimer = setInterval(() => tryClickOnce(), POLL_MS);

    tryClickOnce();
    log('Next skipper started for:', seriesTitle, 'frame:', window.top === window ? 'top' : 'iframe');
  }

  // ----- video phase -----
  function isLatePhase() {
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return false;
    const p = (v.currentTime || 0) / v.duration;
    return p >= 0.80;
  }

  // ----- PLEX FAST PATH: AudioVideoUpNext-poster Play Next button -----
  function clickPlexUpNextIfPresent() {
    const auto = document.getElementById('autoPlayCheck');
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
    log('✅ Clicked Plex Play Next (fast path)', { label: getElementLabel(target) });
    return true;
  }

  // ----- pass -----
  function tryClickOnce() {
    if (!isEnabledForSeries()) return;

    // First: Plex-specific Up-Next button, if present
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

        // Try visible click first
        if (!isVisible(target)) {
          // Force-reveal: work on the overlay container and the button itself
          const overlay = closestOverlay(target) || target.parentElement || document.body;
          const restore = forceReveal(overlay, target);
          await wait(120); // let styles/animations settle

          // target might have changed size/visibility; update reference
          target = resolveClickable(target) || target;

          if (!isVisible(target)) {
            // try a visible child inside the overlay
            const alt = pickVisibleButton(overlay);
            if (alt) target = alt;
          }

          if (!isVisible(target)) {
            // give it one last short wait
            await wait(80);
          }

          // Click if visible
          if (isVisible(target)) {
            simulatedClick(target);
            restore();
            log(`✅ Clicked NEXT (forced reveal) [${seriesTitle}]`, { label: getElementLabel(target) });
            return;
          }

          // Restore and bail if still hidden
          restore();
          return;
        }

        // Visible → click
        simulatedClick(target);
        log(`✅ Clicked NEXT (delay ${delay}ms) [${seriesTitle}]`, { score: cand.score, label: getElementLabel(target) });
      }, delay);
      break;
    }
  }

  // ----- discovery -----
  const SELECTORS = [
    'button', '[role=button]', 'a[role=button]',
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
      if (isInMenuOrContext(el)) continue; // <-- never menus/context

      const label = getElementLabel(el);
      if (TRANSPORT_LABEL_NEG.test(label)) continue;
      if (NEGATIVE_WORDS.test(label)) continue;

      const hasNext = NEXT_WORDS.test(label);
      if (!hasNext) continue;   // <-- only things whose OWN label talks about "next"

      const overlayish = hasOverlayAncestry(el);
      out.push({ el, score: scoreNextCandidate(el, label, late, overlayish) });
    }

    return out;
  }

  function getElementLabel(el) {
    const aria = el.getAttribute?.('aria-label') || '';
    const title = el.getAttribute?.('title') || '';
    const own = (el.textContent || '');
    const near = closestOverlay(el) || el.parentElement || {};
    const nearText = (near.textContent || '');
    return `${aria}\n${title}\n${own}\n${nearText}`.replace(/\s+/g, ' ').trim();
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
      const cls = (n.className || '').toString();
      if (/Overlay|overlay|FullPlayer|UpNext|Autoplay/i.test(cls)) return true;
    }
    return false;
  }

  function isTransportElement(el) {
    for (let n = el, i = 0; n && i < 10; i++, n = n.parentElement) {
      const cls = (n.className || '').toString();
      if (TRANSPORT_CLASS_NEG.test(cls)) return true;
    }
    return false;
  }

  // ----- FORCE-REVEAL + CLICK TOOLING -----

  function pickVisibleButton(node) {
    if (isVisible(node)) return node;
    try {
      const btn = node.querySelector?.('button,[role=button],a[role=button],*[onclick]');
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
        style: el.getAttribute('style'),
        hidden: el.getAttribute('aria-hidden'),
        class: el.getAttribute('class')
      };
      touched.push(prev);

      // remove common hidden classes
      try {
        const cl = new Set((el.className || '').toString().split(/\s+/));
        let changed = false;
        for (const h of HIDE_CLASSES) if (cl.has(h)) { cl.delete(h); changed = true; }
        if (changed) el.className = [...cl].join(' ');
      } catch {}

      // attributes
      try {
        if (el.hasAttribute('aria-hidden')) el.setAttribute('aria-hidden', 'false');
      } catch {}

      // styles
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

    // work primarily on container, then the button itself
    touch(container, { 'z-index': '2147483647' });
    touch(button,   { 'z-index': '2147483647' });

    // also try the immediate parent to break overflow clipping
    if (button && button.parentElement) touch(button.parentElement, { overflow: 'visible' });

    // center it
    try { container.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}

    // return restore function
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

  function resolveClickable(node) {
    let el = node;
    for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
      if (!isElement(el)) continue;
      if (isInMenuOrContext(el)) break;
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
      if (clickable && !isTransportElement(el)) return el;
    }
    let desc;
    try { desc = node.querySelector?.('button,[role=button],a[role=button],*[onclick]'); } catch {}
    if (desc && !isTransportElement(desc) && !isInMenuOrContext(desc)) return desc;
    return isElement(node) && !isTransportElement(node) && !isInMenuOrContext(node) ? node : null;
  }

  function simulatedClick(el) {
    try {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown',   { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mouseup',     { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('click',       { bubbles: true, cancelable: true, buttons: 1 }));
    } catch {
      try { el.click?.(); } catch {}
    }
  }

  // ----- DOM utils -----
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
      s.display !== 'none' && s.visibility !== 'hidden' &&
      parseFloat(s.opacity || '1') > 0.06 &&
      s.pointerEvents !== 'none'
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
      try { all = root.querySelectorAll('*'); } catch {}
      for (const host of all) {
        const sr = host && host.shadowRoot;
        if (sr) yield* deepQueryAllRoots([sr], selectors, depth + 1, maxDepth);
      }

      let iframes = [];
      try { iframes = root.querySelectorAll('iframe'); } catch {}
      for (const f of iframes) {
        try {
          const doc = f.contentDocument;
          if (doc) yield* deepQueryAllRoots([doc], selectors, depth + 1, maxDepth);
        } catch {}
      }
    }
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function log(...args) {
    try { console.debug('[SmartSkipper:next]', ...args); } catch {}
  }
})();
