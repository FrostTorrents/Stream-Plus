// skip.js — Intro skipper (series-key aware; defaults ON; honors series-wide "disabled")

(() => {
  if (window.__SMART_SKIPPER__) return;
  window.__SMART_SKIPPER__ = true;

  let settings = {};
  let seriesTitle = '';
  let mo = null;
  let pollTimer = null;

  const POLL_MS = 250;
  const CLICK_COOLDOWN_MS = 300;
  let lastClickTs = 0;

  const INTRO_WORDS = /\b(intro|recap|opening|theme)\b/i;

  // Avoid 10s transport controls
  const TRANSPORT_LABEL_NEG = /\b(10\s*(sec|seconds)|ten\s*seconds|seek|scrub|timeline|progress|jump|rewind|replay\s*10|forward\s*10|skip\s*(ahead|back)\s*10)\b/i;
  const TRANSPORT_CLASS_NEG = /(Transport|control|Controls|Seek|SkipForward|SkipBack|Replay|Timeline|Scrub|Progress|OSD)/i;

  window.initSkipper = function initSkipper(loadedSettings, currentSeries) {
    settings = loadedSettings || {};
    seriesTitle = (currentSeries || 'Unknown Series').trim();
    if (!settings?.globalEnabled) return;
    start();
  };

  window.updateSkipperSettings = function updateSkipperSettings(newSettings, currentSeries) {
    settings = newSettings || settings;
    if (currentSeries) seriesTitle = currentSeries;
  };

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync') return;
    Object.keys(changes).forEach(k => (settings[k] = changes[k].newValue));
  });

  function start() {
    if (mo) mo.disconnect();
    if (pollTimer) clearInterval(pollTimer);

    mo = new MutationObserver(() => trySkipOnce());
    mo.observe(document, { childList: true, subtree: true });

    pollTimer = setInterval(() => trySkipOnce(), POLL_MS);
    trySkipOnce();
  }

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

  function getSeriesRules() {
    const key = seriesKeyFrom(seriesTitle);

    const disabledKeys = settings?.disabledSeriesKeys || [];
    const isDisabled = disabledKeys.includes(key);

    // Preferred rules map by key
    const byKey = settings?.perShowRulesByKey || {};
    let r = byKey[key];

    // Fallback to display-name map
    if (!r) {
      const byDisplay = settings?.perShowRules || {};
      if (byDisplay[seriesTitle]) {
        r = byDisplay[seriesTitle];
      } else {
        for (const k of Object.keys(byDisplay)) {
          if (seriesKeyFrom(k) === key) { r = byDisplay[k]; break; }
        }
      }
    }

    // Defaults → Intro/Credits ON
    if (!r) r = { skipIntro: true, skipCredits: true, lowerVolume: false };

    // Apply series-wide disable
    if (isDisabled) r = { ...r, skipIntro: false, skipCredits: false };

    return r;
  }

  function trySkipOnce() {
    const r = getSeriesRules();
    if (!r?.skipIntro) return;

    const cands = findIntroCandidates();
    if (!cands.length) return;

    cands.sort((a, b) => (b.score || 0) - (a.score || 0));
    const delay = Number.isFinite(settings.skipDelayMs) ? settings.skipDelayMs : 500;

    for (const cand of cands) {
      const now = Date.now();
      if (now - lastClickTs < CLICK_COOLDOWN_MS) return;
      lastClickTs = now;

      const target = resolveClickable(cand.el);
      if (!target) continue;

      setTimeout(() => {
        if (!document.contains(target) || !isVisible(target)) return;
        simulatedClick(target);
        console.debug(`[SmartSkipper:intro] ✅ Clicked INTRO (delay ${delay}ms)`, {
          series: seriesTitle,
          label: getElementLabel(target)
        });
      }, delay);
      break;
    }
  }

  const SELECTORS = [
    'button', '[role=button]', 'a[role=button]',
    '[class*="OverlayButton"]', '[class*="overlayButton"]',
    '[class*="FullPlayer"] [class*="Button"]',
    '[data-testid*="skip" i]', '[data-qa-id*="skip" i]',
    '[class*="Skip" i]', '[class*="skip" i]'
  ];

  function findIntroCandidates() {
    const out = [];
    for (const el of deepQueryAllRoots([document], SELECTORS, 0, 6)) {
      if (!isElement(el) || !isVisible(el)) continue;
      if (isTransportElement(el)) continue;

      const label = getElementLabel(el);
      if (TRANSPORT_LABEL_NEG.test(label)) continue;

      const hasSkipWord = /\bskip\b/i.test(label);
      const isIntroish = INTRO_WORDS.test(label);
      const overlayish = hasOverlayAncestry(el);

      if ((hasSkipWord || overlayish) && isIntroish) {
        out.push({ el, score: scoreIntroCandidate(el, label) });
      }
    }
    return out;
  }

  function getElementLabel(el) {
    const aria = el.getAttribute?.('aria-label') || '';
    const title = el.getAttribute?.('title') || '';
    const own = (el.textContent || '');
    const near = el.closest?.('[class*="Overlay"], [class*="overlay"], [data-testid*="overlay" i]') || el.parentElement || {};
    const nearText = (near.textContent || '');
    return `${aria}\n${title}\n${own}\n${nearText}`.replace(/\s+/g, ' ').trim();
  }

  function scoreIntroCandidate(el, label) {
    let s = 0;
    if (/\bskip\b/i.test(label)) s += 2;
    if (INTRO_WORDS.test(label)) s += 3;
    if (hasOverlayAncestry(el)) s += 2;
    if (/\b(play|next)\b/i.test(label)) s -= 2;
    return s;
  }

  function hasOverlayAncestry(el) {
    for (let n = el, i = 0; n && i < 8; i++, n = n.parentElement) {
      const cls = (n.className || '').toString();
      if (/Overlay|overlay|FullPlayer|UpNext|Intro/i.test(cls)) return true;
    }
    return false;
  }

  function isTransportElement(el) {
    for (let n = el, i = 0; n && i < 8; i++, n = n.parentElement) {
      const cls = (n.className || '').toString();
      if (TRANSPORT_CLASS_NEG.test(cls)) return true;
    }
    return false;
  }

  function resolveClickable(node) {
    let el = node;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      if (!isElement(el)) continue;
      const tag = (el.tagName || '').toLowerCase();
      const role = (el.getAttribute?.('role') || '').toLowerCase();
      const style = getComputedStyle(el);
      const clickable =
        tag === 'button' || role === 'button' || el.hasAttribute('onclick') ||
        (parseFloat(style.opacity || '1') > 0.06 &&
         style.pointerEvents !== 'none' &&
         (style.cursor === 'pointer' || tag === 'a'));
      if (clickable && !isTransportElement(el)) return el;
    }
    return isElement(node) && !isTransportElement(node) ? node : null;
  }

  function simulatedClick(el) {
    try {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown',   { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mouseup',     { bubbles: true, cancelable: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('click',       { bubbles: true, cancelable: true, buttons: 1 }));
    } catch { try { el.click?.(); } catch {} }
  }

  function isElement(x) { return x && x.nodeType === 1; }
  function isVisible(el) {
    if (!isElement(el)) return false;
    let r, s;
    try { r = el.getBoundingClientRect(); s = getComputedStyle(el); } catch { return false; }
    return (
      r.width >= 8 && r.height >= 8 &&
      r.bottom >= 0 && r.right >= 0 &&
      r.top <= (window.innerHeight || 0) && r.left <= (window.innerWidth || 0) &&
      s.display !== 'none' && s.visibility !== 'hidden' &&
      parseFloat(s.opacity || '1') > 0.06
    );
  }

  function* deepQueryAllRoots(roots, selectors, depth = 0, maxDepth = 6) {
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
})();
