// Orchestration: self-test, initial load, auto-refresh, manual refresh, theme.

import { MANAGERS, PROTOCOL, REFRESH_MS, REPO_URL, FINDINGS_URL } from '../config.js';
import { selfTest } from './clarity.js';
import { apiKey } from './hiro.js';
import { readAll } from './monitor.js';
import {
  renderProtocol, renderPools, renderProtocolSkeleton, renderPoolsSkeleton,
  renderBanner, contractUrl, fmtTime,
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
$('repo-link').href = REPO_URL;

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
      renderPools(els.pools, state.managers);
      lastOk = state.readAt;
      els.updated.textContent = fmtTime(state.readAt);
      els.updated.title = state.readAt.toISOString();

      const failed = state.managers.filter((m) => m.error).length;
      if (state.protocol.anyError || failed) {
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
      if (!lastOk) { els.protocol.innerHTML = ''; els.pools.innerHTML = ''; }
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
