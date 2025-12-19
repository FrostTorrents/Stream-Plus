// outro.js — Credits/Outro skipper (series-key aware; defaults ON; honors series-wide "disabled"; transport-safe)

(() => {
  if (window.__SMART_OUTRO_SKIPPER__) return;
  window.__SMART_OUTRO_SKIPPER__ = true;

  let settings = {};
  let seriesTitle = '';
  let mo = null;
  let pollTimer = null;
  let loweredVolume = false;
  let savedVolume = null;


  const POLL_MS = 250;
  const CLICK_COOLDOWN_MS = 300;
  let lastClickTs = 0;

  const NEGATIVE_WORDS = /\b(up ?next|play next|next episode|autoplay|continue)\b/i;
  const CREDITS_WORDS = /\b(credits?|end\s*credits?|ending|outro|post[-\s]?credits?|postcredits?|credits?\s*scene|finale|gen[eé]rique|abspann|cr[eé]ditos|cr[eê]ditos|titres de fin|finais|fim)\b/i;
  const SKIP_WORD = /\b(skip|saltar|salta|pular|überspringen|omitir|passer|ignora|пропустить|skippa)\b/i;

  const TRANSPORT_LABEL_NEG = /\b(10\s*(sec|seconds)|ten\s*seconds|seek|scrub|timeline|progress|jump|rewind|replay\s*10|forward\s*10|skip\s*(ahead|back)\s*10)\b/i;
  const TRANSPORT_CLASS_NEG = /(Transport|control|Controls|Seek|SkipForward|SkipBack|Replay|Timeline|Scrub|Progress|OSD)/i;

  window.initOutroSkipper = function initOutroSkipper(loadedSettings, currentSeries) {
    settings = loadedSettings || {};
    seriesTitle = (currentSeries || 'Unknown Series').trim();
    if (!settings?.globalEnabled) return;
    start();
  };

  window.updateOutroSettings = function updateOutroSettings(newSettings, currentSeries) {
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

    // Preferred: keyed rules
    const byKey = settings?.perShowRulesByKey || {};
    let r = byKey[key];

    // Fallback: display rules
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

  
  function clamp01(n) { return Math.max(0, Math.min(1, n)); }

  function handleCreditsVolume(phase, rules) {
    // Only lower during credits when the per-show rule is enabled
    const shouldLower = !!(rules?.lowerVolume) && phase === 'credits' && settings?.globalEnabled !== false;
    const v = document.querySelector('video');
    if (!v) return;

    const levelPct = Number.isFinite(settings?.volumeLevel) ? settings.volumeLevel : 50;
    const target = clamp01(levelPct / 100);

    if (shouldLower) {
      if (!loweredVolume) {
        savedVolume = Number.isFinite(v.volume) ? v.volume : 1;
        loweredVolume = true;
      }
      try { v.volume = Math.min(savedVolume ?? v.volume, target); } catch {}
    } else if (loweredVolume) {
      try { if (savedVolume != null) v.volume = savedVolume; } catch {}
      loweredVolume = false;
      savedVolume = null;
    }
  }

function getPhase() {
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) {
      return { p: 0, phase: 'unknown' };
    }
    const p = (v.currentTime || 0) / v.duration;
    const phase = p > 0.65 ? 'credits' : (p < 0.30 ? 'intro' : 'middle');
    return { p, phase };
  }

  function trySkipOnce() {
    if (settings?.globalEnabled === false) { handleCreditsVolume('unknown', { lowerVolume: false }); return; }
    const r = getSeriesRules();

    const { phase } = getPhase();
    handleCreditsVolume(phase, r);

    if (!r?.skipCredits) return;

    const cands = findCreditsCandidates(phase);
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
        console.debug(`[SmartSkipper:outro] ✅ Clicked CREDITS (delay ${delay}ms)`, { label: getElementLabel(target) });
      }, delay);
      break;
    }
  }

  const SELECTORS = [
    'button', '[role=button]', 'a[role=button]',
    '[class*="OverlayButton"]', '[class*="overlayButton"]',
    '[class*="FullPlayer"] [class*="Button"]',
    '[class*="UpNext"] [class*="Button"]',
    '[data-testid*="skip" i]', '[data-qa-id*="skip" i]',
    '[class*="Skip" i]', '[class*="skip" i]'
  ];

  function findCreditsCandidates(phase) {
    const out = [];
    for (const el of deepQueryAllRoots([document], SELECTORS, 0, 8)) {
      if (!isElement(el) || !isVisible(el)) continue;
      if (isTransportElement(el)) continue;

      const label = getElementLabel(el);
      if (TRANSPORT_LABEL_NEG.test(label)) continue;
      if (NEGATIVE_WORDS.test(label)) continue;

      const isCreditsish = CREDITS_WORDS.test(label);
      const hasSkip = SKIP_WORD.test(label);
      const overlayish = hasOverlayAncestry(el);

      if (phase === 'credits') {
        if (hasSkip || (overlayish && isCreditsish)) {
          out.push({ el, score: scoreCredits(el, label, true) });
          continue;
        }
      } else {
        if (hasSkip && isCreditsish) {
          out.push({ el, score: scoreCredits(el, label, false) });
          continue;
        }
      }

      const overlay = closestOverlay(el);
      if (overlay) {
        const overlayText = (overlay.textContent || '').replace(/\s+/g, ' ');
        if (!NEGATIVE_WORDS.test(overlayText)) {
          const creditsInOverlay = CREDITS_WORDS.test(overlayText);
          const skipInOverlay = SKIP_WORD.test(overlayText);
          if ((phase === 'credits' && (skipInOverlay || creditsInOverlay)) ||
              (phase !== 'credits' && skipInOverlay && creditsInOverlay)) {
            const clickDesc = overlay.querySelector('button,[role=button],a[role=button],*[onclick]');
            if (clickDesc && isVisible(clickDesc) && !isTransportElement(clickDesc)) {
              out.push({ el: clickDesc, score: scoreCredits(clickDesc, overlayText, phase === 'credits') + 1 });
            }
          }
        }
      }
    }
    return out;
  }

  function getElementLabel(el) {
    const aria = el.getAttribute?.('aria-label') || '';
    const title = el.getAttribute?.('title') || '';
    const own = el.textContent || '';
    const near = closestOverlay(el) || el.parentElement || {};
    const nearText = near.textContent || '';
    return `${aria}\n${title}\n${own}\n${nearText}`.replace(/\s+/g, ' ').trim();
  }

  function closestOverlay(el) {
    return el.closest?.('[class*="Overlay"], [class*="overlay"], [class*="UpNext"], [class*="Credits"], [data-testid*="overlay" i]') || null;
  }

  function scoreCredits(el, label, late) {
    let s = 0;
    if (SKIP_WORD.test(label)) s += 2;
    if (CREDITS_WORDS.test(label)) s += 4;
    if (hasOverlayAncestry(el)) s += 3;
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
      if (/Overlay|overlay|FullPlayer|UpNext|Credits/i.test(cls)) return true;
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

  function resolveClickable(node) {
    let el = node;
    for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
      if (!isElement(el)) continue;
      const tag = (el.tagName || '').toLowerCase();
      const role = (el.getAttribute?.('role') || '').toLowerCase();
      const style = getComputedStyle(el);
      const clickable =
        tag === 'button' || role === 'button' || el.hasAttribute('onclick') ||
        (parseFloat(style.opacity || '1') > 0.06 && style.pointerEvents !== 'none' &&
         (style.cursor === 'pointer' || tag === 'a'));
      if (clickable && !isTransportElement(el)) return el;
    }
    let desc;
    try { desc = node.querySelector?.('button,[role=button],a[role=button],*[onclick]'); } catch {}
    if (desc && isVisible(desc) && !isTransportElement(desc)) return desc;
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
    let r, s; try { r = el.getBoundingClientRect(); s = getComputedStyle(el); } catch { return false; }
    return r.width >= 8 && r.height >= 8 && r.bottom >= 0 && r.right >= 0 &&
           r.top <= (window.innerHeight || 0) && r.left <= (window.innerWidth || 0) &&
           s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.06;
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
        try { const doc = f.contentDocument; if (doc) yield* deepQueryAllRoots([doc], selectors, depth + 1, maxDepth); } catch {}
      }
    }
  }
})();
