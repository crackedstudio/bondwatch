// Renders the state model from monitor.js into the DOM. Pure functions of
// state; no fetching here.

import { EXPLORER_BASE, CHAIN, SATS_PER_SBTC, BIPS_DENOMINATOR } from '../config.js';

// ---------------------------------------------------------------- helpers

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const addrUrl = (addr) => `${EXPLORER_BASE}/address/${addr}?chain=${CHAIN}`;
export const contractUrl = (id) => `${EXPLORER_BASE}/txid/${id}?chain=${CHAIN}`;

export function fmtSbtc(sats) {
  const v = BigInt(sats);
  const whole = v / SATS_PER_SBTC;
  const frac = (v % SATS_PER_SBTC).toString().padStart(8, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}
export function fmtSats(sats) {
  return `${BigInt(sats).toLocaleString('en-US')} sats`;
}
export function fmtBipsPct(bips, denom = BIPS_DENOMINATOR) {
  const pct = (Number(bips) / denom) * 100;
  return `${pct.toFixed(2).replace(/\.?0+$/, '')}%`;
}
export function fmtTime(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const ICON_WARN = `<svg class="warn-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M7.1 1.6a1 1 0 0 1 1.8 0l6 11.3A1 1 0 0 1 14 14.4H2a1 1 0 0 1-.9-1.5zM8 5.2a.8.8 0 0 0-.8.8v3.2a.8.8 0 0 0 1.6 0V6a.8.8 0 0 0-.8-.8zm0 6a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z"/></svg>`;
const ICON_OK = `<svg class="warn-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm3.2 4.6a.8.8 0 0 0-1.1 0L7 8.7 5.9 7.6a.8.8 0 1 0-1.1 1.1l1.6 1.7a.8.8 0 0 0 1.2 0l3.6-3.7a.8.8 0 0 0 0-1.1z"/></svg>`;

const unavailable = (why) =>
  `<span class="unavailable" title="${esc(why || 'read failed')}">unavailable</span>`;

// ---------------------------------------------------------------- skeletons

export function renderProtocolSkeleton(el) {
  el.innerHTML = `
    <div class="card status status-card"><span class="skel skel-pill"></span><span class="skel skel-line w60"></span></div>
    ${['Bond admin', 'Pause admin'].map((t) => `<div class="card wide"><p class="card-title">${t}</p><span class="skel skel-line w90"></span></div>`).join('')}
    ${['Total sBTC staked', 'Reserve balance', 'Configured', 'Rewards paused'].map((t) => `<div class="card"><p class="card-title">${t}</p><span class="skel skel-line w60"></span><span class="skel skel-line w40"></span></div>`).join('')}
  `;
}

export function renderPoolsSkeleton(el, managers) {
  el.innerHTML = managers.map((m) => `
    <article class="card pool-card" data-id="${esc(m.id)}">
      <div class="pool-head"><div><h3 class="pool-name">${esc(m.name)}</h3><span class="pool-contract mono">${esc(m.address)}.${esc(m.contract)}</span></div></div>
      <span class="skel skel-line w60"></span>
      <span class="skel skel-line w90"></span>
      <span class="skel skel-line w40"></span>
    </article>`).join('');
}

// ---------------------------------------------------------------- protocol

export function renderProtocol(el, p) {
  const f = p.fields;
  const paused = f['rewards-paused'];
  const bondAdmin = f['bond-admin'];
  const pauseAdmin = f['pause-admin'];
  const staked = f['total-sbtc-staked'];
  const reserve = f['reserve-balance'];
  const configured = f['configured'];

  let pill, explain;
  if (paused.error) {
    pill = `<span class="status-pill neutral">REWARDS: UNKNOWN</span>`;
    explain = `Could not read <code>rewards-paused</code> (${esc(paused.error.message)}).`;
  } else if (paused.value) {
    pill = `<span class="status-pill bad">REWARDS PAUSED — IRREVERSIBLE</span>`;
    explain = `<code>pause-rewards</code> has fired. pox-5 has no unpause path: the only writer of <code>rewards-paused</code> sets it to <code>true</code>.`;
  } else {
    pill = `<span class="status-pill ok">REWARDS ACTIVE</span>`;
    explain = `<code>rewards-paused = false</code>. If <code>pause-admin</code> ever calls <code>pause-rewards</code>, it cannot be undone — the contract has no unpause path.`;
  }

  const adminCard = (title, r) => `
    <div class="card wide ${r.error ? 'error' : ''}">
      <p class="card-title">${title}</p>
      <div class="card-value mono">${r.error
        ? unavailable(r.error.message)
        : `<a href="${addrUrl(r.value)}" target="_blank" rel="noopener">${esc(r.value)}</a>`}</div>
      <p class="card-sub">${title === 'Bond admin' ? 'Can rotate both admin roles and register bonds.' : 'Can call the irreversible <code>pause-rewards</code>.'}</p>
    </div>`;

  let adminNote = '';
  if (p.sameAdmin) {
    adminNote = `<div class="card full"><div class="warn-box">${ICON_WARN}<div><strong>One principal holds BOTH admin roles</strong> — the same key can rotate admins and trigger the irreversible pause.</div></div></div>`;
  } else if (!bondAdmin.error && !pauseAdmin.error) {
    adminNote = `<div class="card full"><div class="ok-box">${ICON_OK}<div><strong>Admin roles are split</strong> — bond-admin and pause-admin are different principals.</div></div></div>`;
  }

  const sbtcCard = (title, r, sub) => `
    <div class="card ${r.error ? 'error' : ''}">
      <p class="card-title">${title}</p>
      <div class="card-value">${r.error
        ? unavailable(r.error.message)
        : `<abbr title="${fmtSats(r.value)}">${fmtSbtc(r.value)}</abbr> <small style="font-size:.7em;color:var(--fg-muted)">sBTC</small>`}</div>
      <p class="card-sub">${sub}</p>
    </div>`;

  const flagCard = (title, r, sub, okWhen) => {
    let body;
    if (r.error) body = unavailable(r.error.message);
    else {
      const cls = r.value === okWhen ? 'ok' : 'bad';
      body = `<span class="flag ${cls}">${r.value ? 'true' : 'false'}</span>`;
    }
    return `<div class="card ${r.error ? 'error' : ''}"><p class="card-title">${title}</p><div class="card-value">${body}</div><p class="card-sub">${sub}</p></div>`;
  };

  el.innerHTML = `
    <div class="card status status-card">${pill}<p class="status-explain">${explain}</p></div>
    ${adminCard('Bond admin', bondAdmin)}
    ${adminCard('Pause admin', pauseAdmin)}
    ${adminNote}
    ${sbtcCard('Total sBTC staked', staked, 'Locked in bonds across all pools.')}
    ${sbtcCard('Reserve balance', reserve, 'Protocol reserve (RESERVE_RATIO = 15%).')}
    ${flagCard('Configured', configured, 'Bond setup completed on-chain.', true)}
    ${flagCard('Rewards paused', paused, 'Irreversible once true.', false)}
  `;
}

// ---------------------------------------------------------------- pools

function yesNo(bool, via) {
  const viaTxt = via && via.length ? `<span class="via">via <code>${via.map(esc).join('</code>, <code>')}</code></span>` : '';
  return bool
    ? `<span class="yes">Yes</span> ${viaTxt}`
    : `<span class="no">No</span>`;
}

export function renderPool(m) {
  const head = `
    <div class="pool-head">
      <div>
        <h3 class="pool-name">${esc(m.name)}</h3>
        <a class="pool-contract mono" href="${contractUrl(m.contractId)}" target="_blank" rel="noopener">${esc(m.contractId)}</a>
      </div>
      <span class="pool-kind">${m.primary ? 'signer-manager' : 'detected'}</span>
    </div>`;

  if (m.error) {
    return `<article class="card pool-card error" data-id="${esc(m.id)}">${head}
      <span class="badge neutral">Unavailable</span>
      <p class="pool-error">Could not read this manager: ${esc(m.error.message)}</p>
    </article>`;
  }

  const denom = m.caps?.bipsDenominator ?? BIPS_DENOMINATOR;
  const feeMutable = m.canChangeFee || m.feeMutators.length > 0;
  const adminMutable = m.canChangeAdmin || m.adminMutators.length > 0;

  // Active fee
  let feeHtml;
  if (!m.hasFeeSurface) {
    feeHtml = `<div class="fee-big"><span class="unavailable">no on-chain fee</span></div>`;
  } else if (!m.active) {
    feeHtml = `<div class="fee-big"><span class="unavailable">not present</span></div>`;
  } else if (m.active.error) {
    feeHtml = `<div class="fee-big">${unavailable(m.active.error.message)}</div>`;
  } else {
    feeHtml = `<div class="fee-big">${fmtBipsPct(m.active.value, denom)}<small><code>${esc(m.active.name)}</code> = ${m.active.value}</small></div>`;
  }

  // Pending
  let pendingHtml = '';
  if (m.pendingDiffers) {
    const cycle = m.pendingCycle && m.pendingCycle.value != null ? m.pendingCycle.value : null;
    const unit = m.pendingCycle?.name?.includes('height') ? 'block' : 'cycle';
    pendingHtml = `<span class="badge warn">Scheduled fee change → ${fmtBipsPct(m.pendingBips.value, denom)}${cycle != null ? ` (activates ${unit} ${cycle})` : ''}</span>`;
  }

  // Cap
  let capTxt;
  if (m.caps?.maxFeeBips != null) {
    capTxt = fmtBipsPct(m.caps.maxFeeBips, denom);
    if (m.caps.maxFeeBips / denom >= 1) capTxt += ' (effectively uncapped)';
    if (m.caps.delayCycles) capTxt += ` · ${m.caps.delayCycles}-cycle delay`;
    if (m.caps.delayBlocks) capTxt += ` · ${m.caps.delayBlocks}-block cooldown`;
    if (m.capsSource === 'source') capTxt += ' <span class="via">(from source)</span>';
  } else {
    capTxt = m.hasFeeSurface ? '<span class="unavailable">not read</span>' : '—';
  }

  const extra = [];
  if (m.earned && !m.earned.error && m.earned.value != null) {
    extra.push(`<dt>Earned fees</dt><dd><abbr title="${fmtSats(m.earned.value)}">${fmtSbtc(m.earned.value)} sBTC</abbr></dd>`);
  }
  if (m.paused && !m.paused.error && m.paused.value != null) {
    extra.push(`<dt>Pool paused</dt><dd><span class="flag ${m.paused.value ? 'bad' : 'ok'}">${m.paused.value}</span></dd>`);
  }

  const note = m.note && !m.hasFeeSurface ? `<p class="pool-note">${esc(m.note)}</p>` : '';

  return `<article class="card pool-card" data-id="${esc(m.id)}">
    ${head}
    <div class="badge-row"><span class="badge ${m.risk.level}" title="${esc(m.risk.detail)}">${esc(m.risk.label)}</span>${pendingHtml}</div>
    <div class="fee-row">
      <div><p class="card-title">Active fee</p>${feeHtml}</div>
    </div>
    <dl class="kv">
      <dt>Operator can change fee</dt><dd>${yesNo(feeMutable, m.feeMutators)}</dd>
      <dt>Can change admin set</dt><dd>${yesNo(adminMutable, m.adminMutators)}</dd>
      <dt>Fee cap</dt><dd>${capTxt}</dd>
      ${extra.join('')}
      <dt>Public functions</dt><dd class="mono" title="${esc(m.functions.join(', '))}">${m.functions.length}</dd>
    </dl>
    ${note}
  </article>`;
}

export function renderPools(el, managers) {
  el.innerHTML = managers.map(renderPool).join('');
}

// ---------------------------------------------------------------- chrome

export function renderBanner(el, { kind, text } = {}) {
  if (!text) { el.hidden = true; el.textContent = ''; el.className = 'banner'; return; }
  el.hidden = false;
  el.className = `banner ${kind || ''}`;
  el.innerHTML = text;
}
