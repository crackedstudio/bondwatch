// Orchestration: self-test, initial load, auto-refresh, manual refresh, theme.

import { MANAGERS, PROTOCOL, REFRESH_MS, REPO_URL, FINDINGS_URL } from '../config.js';
import { selfTest } from './clarity.js';
import { apiKey } from './hiro.js';
import { readAll } from './monitor.js';
import {
  renderProtocol, renderPools, renderProtocolSkeleton, renderPoolsSkeleton,
  renderBanner, renderChainPos, renderComparison, contractUrl, fmtTime,
} from './render.js';

const $ = (id) => document.getElementById(id);
const els = {
  protocol: $('protocol'),
  pools: $('pools'),
  banner: $('global-banner'),
  updated: $('last-updated-value'),
  refresh: $('refresh-btn'),
  theme: $('theme-btn'),
  auto: $('auto-refresh'),
  chainPos: $('chain-pos'),
  comparison: $('comparison'),
  about: $('about-modal'),
  aboutBtn: $('about-btn'),
  aboutClose: $('about-close'),
  aboutDismiss: $('about-dismiss'),
  autoText: $('auto-refresh-text'),
};

// ---------------------------------------------------------------- theme

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  els.theme.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  try { localStorage.setItem('bondwatch-theme', t); } catch { /* ignore */ }
}
(function initTheme() {
  let t = 'dark';
  try { t = localStorage.getItem('bondwatch-theme') || t; } catch { /* ignore */ }
  applyTheme(t);
  els.theme.addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
})();

// ---------------------------------------------------------------- links

$('protocol-contract-link').href = contractUrl(`${PROTOCOL.address}.${PROTOCOL.name}`);
$('findings-link').href = FINDINGS_URL;
$('about-findings-link').href = FINDINGS_URL;
$('repo-link').href = REPO_URL;

// ---------------------------------------------------------------- about modal

// Opens automatically on a first visit so a newcomer gets the context before
// the numbers; afterwards it's on demand via the About button. The "seen" flag
// is a per-viewer convenience only — if storage is unavailable the modal simply
// shows again, which is the safe failure.
const SEEN_KEY = 'bondwatch-about-seen';
let lastFocus = null;

function aboutOpen() {
  if (!els.about.hidden) return;
  lastFocus = document.activeElement;
  els.about.hidden = false;
  document.body.classList.add('modal-open');
  els.aboutClose.focus();
}

function aboutHide() {
  if (els.about.hidden) return;
  els.about.hidden = true;
  document.body.classList.remove('modal-open');
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  else els.aboutBtn.focus();
}

els.aboutBtn.addEventListener('click', aboutOpen);
els.aboutClose.addEventListener('click', aboutHide);
els.aboutDismiss.addEventListener('click', aboutHide);
// Backdrop click, but not clicks inside the dialog itself.
els.about.addEventListener('click', (e) => { if (e.target === els.about) aboutHide(); });

document.addEventListener('keydown', (e) => {
  if (els.about.hidden) return;
  if (e.key === 'Escape') { aboutHide(); return; }
  if (e.key !== 'Tab') return;
  // Keep focus inside the dialog while it is open.
  const focusable = els.about.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

(function maybeShowAbout() {
  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { /* ignore */ }
  if (!seen) aboutOpen();
})();

// ---------------------------------------------------------------- refresh

let inflight = null;
let lastOk = null;
let timer = null;
let countdownTimer = null;
let nextAt = 0;

function setBusy(busy) {
  els.refresh.disabled = busy;
  els.refresh.classList.toggle('loading', busy);
  els.auto.classList.toggle('busy', busy);
  if (busy) els.autoText.textContent = 'refreshing…';
}

function scheduleNext() {
  clearTimeout(timer);
  nextAt = Date.now() + REFRESH_MS;
  timer = setTimeout(() => refresh('auto'), REFRESH_MS);
  clearInterval(countdownTimer);
  countdownTimer = setInterval(tickCountdown, 1000);
  tickCountdown();
}
function tickCountdown() {
  if (inflight) return;
  const s = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
  els.autoText.textContent = `auto-refresh in ${s}s`;
}

async function refresh(reason = 'manual') {
  if (inflight) return inflight;
  setBusy(true);
  const first = !lastOk;
  if (first) { renderProtocolSkeleton(els.protocol); renderPoolsSkeleton(els.pools, MANAGERS); }

  inflight = (async () => {
    try {
      const state = await readAll();
      renderProtocol(els.protocol, state.protocol);
      renderChainPos(els.chainPos, state.chain);
      renderComparison(els.comparison, state.managers);
      renderPools(els.pools, state.managers);
      lastOk = state.readAt;
      els.updated.textContent = fmtTime(state.readAt);
      els.updated.title = state.readAt.toISOString();

      const failed = state.managers.filter((m) => m.error).length;
      if (state.chainError) {
        renderBanner(els.banner, {
          kind: '',
          text: 'Could not read the current PoX cycle, so fee-activation rules could not be evaluated — fees shown are raw contract variables and may understate the rate actually charged.',
        });
      } else if (state.protocol.anyError || failed) {
        renderBanner(els.banner, {
          kind: '',
          text: `Some reads failed${failed ? ` (${failed} pool${failed > 1 ? 's' : ''} unavailable)` : ''} — showing what could be read. The Hiro API may be rate-limiting; add <code>?hiroKey=…</code> for a higher limit.`,
        });
      } else {
        renderBanner(els.banner, {});
      }
    } catch (err) {
      console.error('[bondwatch] refresh failed', err);
      renderBanner(els.banner, {
        kind: lastOk ? '' : 'bad',
        text: `${lastOk ? 'Refresh failed; showing data from ' + fmtTime(lastOk) : 'Could not load data'} — ${escapeText(err.message)}`,
      });
      if (!lastOk) { els.protocol.innerHTML = ''; els.pools.innerHTML = ''; els.comparison.innerHTML = ''; }
    } finally {
      inflight = null;
      setBusy(false);
      scheduleNext();
    }
  })();
  return inflight;
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

els.refresh.addEventListener('click', () => refresh('manual'));

// If the tab was hidden past a refresh boundary, refresh as soon as it returns.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() >= nextAt && !inflight) refresh('visible');
});

// ---------------------------------------------------------------- boot

(async function boot() {
  try {
    await selfTest();
    console.info('[bondwatch] c32 self-test passed');
  } catch (err) {
    renderBanner(els.banner, { kind: 'bad', text: `Decoder self-test failed — refusing to display data. ${escapeText(err.message)}` });
    els.refresh.disabled = true;
    return;
  }
  if (apiKey()) console.info('[bondwatch] using Hiro API key from URL/window');
  refresh('initial');
})();
