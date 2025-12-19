// popup.js — three tabs: Sleeper / Skipper / Global (with explicit Save for Global)

let currentSeriesDisplay = 'Unknown Series';
let currentSeriesKey = 'unknown';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireTabs(['sleeper','skipper','global']);

  const settings = await getSettings();

  // resolve series
  const fromLocal = await readActiveSeriesFromLocal();
  currentSeriesDisplay = fromLocal?.title || (await resolvePlexSeriesViaTab()) || 'Unknown Series';
  currentSeriesKey = normalizeTitle(canonicalizeSeriesTitle(currentSeriesDisplay));
  setText('seriesName', currentSeriesDisplay);

  const s = withDefaults(settings);

  // ---- Sleeper ----
  setChecked('countdownVisible', !!s.countdownVisible);
  onChange('countdownVisible', async () => {
    const show = getChecked('countdownVisible');
    await updateSetting('countdownVisible', show);
    sendToActiveTab({ type: 'overlay:toggle', show });
  });
  for (const el of document.querySelectorAll('[data-add]')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      sendToActiveTab({ type: 'timer:add', minutes: parseInt(el.dataset.add, 10) });
    });
  }
  $('sub10').addEventListener('click', (e) => { e.preventDefault(); sendToActiveTab({ type: 'timer:sub', minutes: 10 }); });
  $('cancel').addEventListener('click', (e) => { e.preventDefault(); sendToActiveTab({ type: 'timer:cancel' }); });

  // ---- Global (explicit SAVE) ----
  setChecked('globalEnabled', !!s.globalEnabled);
  setValue('skipDelayMs', s.skipDelayMs);
  setValue('volumeLevel', s.volumeLevel);
  setChecked('muteInsteadOfPause', !!s.muteInsteadOfPause);
  setChecked('dimScreen', !!s.dimScreen);

  $('saveGlobal').addEventListener('click', async () => {
    const statusEl = $('saveStatus');
    statusEl.textContent = 'Saving…';

    // read values
    const payload = {
      globalEnabled: getChecked('globalEnabled'),
      skipDelayMs: clampInt($('skipDelayMs').value, 0, 10000, 500),
      volumeLevel: clampInt($('volumeLevel').value, 0, 100, 50),
      muteInsteadOfPause: getChecked('muteInsteadOfPause'),
      dimScreen: getChecked('dimScreen'),
    };

    try {
      await Promise.all(Object.entries(payload).map(([k, v]) => updateSetting(k, v)));
      statusEl.textContent = 'Saved ✓';
      setTimeout(() => statusEl.textContent = '', 1400);
    } catch (e) {
      statusEl.textContent = 'Failed to save';
      console.error('[Popup] Save error', e);
    }
  });

  // ---- Skipper (per-show rules) ----
  const rules = ensureDefaultRules((s.perShowRulesByKey || {})[currentSeriesKey]);
  setChecked('skipIntro', !!rules.skipIntro);
  setChecked('skipCredits', !!rules.skipCredits);
  setChecked('lowerVolume', !!rules.lowerVolume);
  ['skipIntro','skipCredits','lowerVolume'].forEach(id => onChange(id, persistPerShow));

  const disabledSet = new Set(s.disabledSeriesKeys || []);
  paintDisableUI(disabledSet.has(currentSeriesKey));
  $('toggleDisableSeries').addEventListener('click', toggleDisableSeries);

  async function persistPerShow() {
    const fresh = withDefaults(await getSettings());
    const allByKey = fresh.perShowRulesByKey || {};
    const prev = ensureDefaultRules(allByKey[currentSeriesKey]);
    const updated = {
      ...prev,
      skipIntro: getChecked('skipIntro'),
      skipCredits: getChecked('skipCredits'),
      lowerVolume: getChecked('lowerVolume'),
    };
    allByKey[currentSeriesKey] = updated;

    const byDisplay = fresh.perShowRules || {};
    byDisplay[currentSeriesDisplay] = updated;

    await updateSetting('perShowRulesByKey', allByKey);
    await updateSetting('perShowRules', byDisplay);
  }

  async function toggleDisableSeries() {
    const fresh = withDefaults(await getSettings());
    const set = new Set(fresh.disabledSeriesKeys || []);
    const willDisable = !set.has(currentSeriesKey);

    if (willDisable) {
      set.add(currentSeriesKey);
      setChecked('skipIntro', false);
      setChecked('skipCredits', false);
    } else {
      set.delete(currentSeriesKey);
      if (!getChecked('skipIntro') && !getChecked('skipCredits')) {
        setChecked('skipIntro', true);
        setChecked('skipCredits', true);
      }
    }
    await updateSetting('disabledSeriesKeys', Array.from(set));

    const byKey = fresh.perShowRulesByKey || {};
    if (!byKey[currentSeriesKey]) {
      byKey[currentSeriesKey] = ensureDefaultRules(null);
      await updateSetting('perShowRulesByKey', byKey);
    }
    paintDisableUI(willDisable);
  }
}

/* ---------- Tabs ---------- */
function wireTabs(names){
  const tabs = names.map(n => ({ btn: document.querySelector(`.tab[data-tab="${n}"]`), pnl: $(`panel-${n}`) }));
  tabs.forEach(({btn}) => btn.addEventListener('click', () => {
    tabs.forEach(({btn,pnl}) => { btn.classList.remove('active'); pnl.classList.remove('active'); });
    const t = tabs.find(x => x.btn === btn);
    btn.classList.add('active'); t.pnl.classList.add('active');
  }));
}

/* ---------- Helpers ---------- */
function clampInt(v, min, max, fallback){
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return fallback;
}

function withDefaults(s = {}) {
  return {
    globalEnabled: s.globalEnabled !== false,
    skipDelayMs: Number.isFinite(s.skipDelayMs) ? s.skipDelayMs : 500,
    volumeLevel: Number.isFinite(s.volumeLevel) ? s.volumeLevel : 50,
    muteInsteadOfPause: !!s.muteInsteadOfPause,
    dimScreen: !!s.dimScreen,
    countdownVisible: !!s.countdownVisible,
    perShowRulesByKey: s.perShowRulesByKey || {},
    perShowRules: s.perShowRules || {},
    disabledSeriesKeys: s.disabledSeriesKeys || []
  };
}
function ensureDefaultRules(r){ const b=r||{}; return { skipIntro:b.skipIntro!==false, skipCredits:b.skipCredits!==false, lowerVolume:!!b.lowerVolume, playNext:b.playNext!==false }; }
function canonicalizeSeriesTitle(s){ let t=(s||'').trim(); t=t.replace(/\s*[-–—]\s*S\d+\s*[·x×]?\s*E\d+\s*$/i,''); t=t.replace(/\s*\(\s*S\d+\s*[·x×]?\s*E\d+\s*\)\s*$/i,''); t=t.replace(/\s*\bS(?:eason)?\s*\d+\s*[·x×.]?\s*E(?:pisode)?\s*\d+\b.*$/i,''); t=t.replace(/\s*\bS\d+\s*E\d+\b.*$/i,''); t=t.replace(/\s*[-–—]\s*Season\s*\d+\s*Episode\s*\d+\s*$/i,''); t=t.replace(/\s*\bSeason\s*\d+\s*Episode\s*\d+\b.*$/i,''); return t.trim(); }
function normalizeTitle(s){ return (s||'').toLowerCase().replace(/\s+/g,' ').replace(/[^\p{L}\p{N}\s]+/gu,'').trim(); }
function paintDisableUI(disabled){
  const btn=$('toggleDisableSeries'), hint=$('disableHint');
  const lock = on => ['skipIntro','skipCredits','lowerVolume'].forEach(id => { $(id).disabled = on; });
  if(disabled){ btn.textContent='✅ Enable this series'; btn.classList.remove('danger'); hint.textContent='This series is disabled'; lock(true); }
  else{ btn.textContent='🚫 Disable this series'; btn.classList.add('danger'); hint.textContent=''; lock(false); }
}

/* ---------- Chrome plumbing ---------- */
function getSettings(){ return new Promise(r => chrome.runtime.sendMessage({type:'getSettings'}, r)); }
function updateSetting(key,value){ return new Promise(r => chrome.runtime.sendMessage({type:'updateSetting', key, value}, () => r())); }
function readActiveSeriesFromLocal(){ return new Promise(r => chrome.storage.local.get(['activeSeriesTitle','activeSeriesKey'], v => r({title:v.activeSeriesTitle,key:v.activeSeriesKey}))); }
async function resolvePlexSeriesViaTab(){ try{ const tabs=await queryTabs('*://*.plex.tv/*'); if(!tabs.length) return null; const active=tabs.find(t=>t.active)||tabs[0]; return await execInTab(active.id, () => { const pick=(...ss)=>{for(const s of ss){const el=document.querySelector(s); if(el&&el.textContent) return el.textContent.trim();} return null;}; return pick('[data-testid="metadataGrandparentTitle"]','[data-qa-id="metadataGrandparentTitle"]','.PrePlayTitle .grandparent-title','[data-testid="metadata-title"]') || (document.title||'').replace(/\s+-\s*Plex.*/i,'').trim() || 'Unknown Series'; }); } catch { return null; } }
function queryTabs(url){ return new Promise(r => chrome.tabs.query({url}, r)); }
function execInTab(tabId, func){ return new Promise(r => chrome.scripting.executeScript({target:{tabId}, func}, res => r(res?.[0]?.result || null))); }

/* ---------- Tiny DOM ---------- */
function $(id){return document.getElementById(id)}
function setText(id,v){$(id).textContent=v}
function setChecked(id,v){$(id).checked=!!v}
function getChecked(id){return !!$(id).checked}
function setValue(id,v){$(id).value=v}
function onChange(id,fn){ $(id).addEventListener('change',e=>{ const val=e.target.type==='checkbox'?e.target.checked:parseInt(e.target.value,10); fn(val); }); }
