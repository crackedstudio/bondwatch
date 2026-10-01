// Reads protocol + every signer-manager and builds a plain state model.
// Every read is isolated: one failure yields `{ error }` for that field or
// card, never a thrown exception out of `readAll`.

import {
  PROTOCOL, MANAGERS, FEE_MUTATORS, ADMIN_MUTATORS, CAP_CONSTANTS, BIPS_DENOMINATOR,
} from '../config.js';
import { getDataVarHex, getInterface, getSource, getPoxInfo, HttpError } from './hiro.js';
import { decodeBool, decodeUint, decodePrincipal, decoderFor } from './clarity.js';

const PROTOCOL_DECODERS = { principal: decodePrincipal, bool: decodeBool, uint: decodeUint };

async function safe(fn) {
  try { return { value: await fn(), error: null }; }
  catch (err) { return { value: null, error: err }; }
}

// ---------------------------------------------------------------- protocol

export async function readProtocol(opts) {
  const { address, name, vars } = PROTOCOL;
  const entries = await Promise.all(
    Object.entries(vars).map(async ([varName, type]) => {
      const r = await safe(async () =>
        PROTOCOL_DECODERS[type](await getDataVarHex(address, name, varName, opts)));
      return [varName, r];
    }),
  );
  const fields = Object.fromEntries(entries);
  const bondAdmin = fields['bond-admin'].value;
  const pauseAdmin = fields['pause-admin'].value;
  return {
    contractId: `${address}.${name}`,
    fields,
    sameAdmin: bondAdmin != null && pauseAdmin != null && bondAdmin === pauseAdmin,
    anyError: entries.some(([, r]) => r.error),
  };
}

// ---------------------------------------------------------------- managers

function parseCapsFromSource(source) {
  const out = {};
  const find = (names) => {
    for (const n of names) {
      const m = source.match(new RegExp(`\\(define-constant\\s+${n}\\s+u(\\d+)\\)`));
      if (m) return Number(m[1]);
    }
    return undefined;
  };
  for (const [key, names] of Object.entries(CAP_CONSTANTS)) {
    const v = find(names);
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

async function readVarGroup(m, iface, names, opts) {
  // Only try names the interface says exist; decode by the declared type.
  const declared = new Map((iface.variables || []).map((v) => [v.name, v]));
  for (const name of names || []) {
    const decl = declared.get(name);
    if (!decl || decl.access !== 'variable') continue;
    const decode = decoderFor(decl.type);
    if (!decode) continue;
    try {
      const hex = await getDataVarHex(m.address, m.contract, name, opts);
      return { name, value: await decode(hex), error: null };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) continue; // absent
      return { name, value: null, error: err };
    }
  }
  return null; // not present
}

export async function readManager(m, chain, opts) {
  const contractId = `${m.address}.${m.contract}`;
  const base = { ...m, contractId };

  let iface;
  try {
    iface = await getInterface(m.address, m.contract, opts);
  } catch (err) {
    return { ...base, error: err, risk: riskFor({ ...base, error: err }) };
  }

  const fns = new Set((iface.functions || []).filter((f) => f.access === 'public').map((f) => f.name));
  const canChangeFee = fns.has('update-fees');
  const canChangeAdmin = fns.has('update-admin');
  const feeMutators = FEE_MUTATORS.filter((f) => fns.has(f));
  const adminMutators = ADMIN_MUTATORS.filter((f) => fns.has(f));

  const declaredVars = (iface.variables || []).filter((v) => v.access === 'variable').map((v) => v.name);
  const declaredConsts = (iface.variables || []).filter((v) => v.access === 'constant').map((v) => v.name);

  const [active, pendingBips, pendingCycle, earned, paused] = await Promise.all([
    readVarGroup(m, iface, m.feeVars?.active, opts),
    readVarGroup(m, iface, m.feeVars?.pendingBips, opts),
    readVarGroup(m, iface, m.feeVars?.pendingCycle, opts),
    readVarGroup(m, iface, m.feeVars?.earned, opts),
    readVarGroup(m, iface, m.feeVars?.paused, opts),
  ]);

  // Caps: config first; else best-effort parse of the deployed source.
  let caps = m.caps ?? null;
  let capsSource = m.caps ? 'config' : 'none';
  if (!caps) {
    const hasCapConst = Object.values(CAP_CONSTANTS).flat().some((n) => declaredConsts.includes(n));
    if (hasCapConst) {
      const r = await safe(() => getSource(m.address, m.contract, opts));
      if (r.value) { caps = parseCapsFromSource(r.value); if (caps) capsSource = 'source'; }
    }
  }

  const hasFeeSurface = feeMutators.length > 0 || !!active;
  const fee = resolveFee(m, { active, pendingBips, pendingCycle }, chain);

  const model = {
    ...base,
    error: null,
    functions: [...fns],
    declaredVars,
    canChangeFee, canChangeAdmin, feeMutators, adminMutators,
    hasFeeSurface,
    active, pendingBips, pendingCycle, earned, paused,
    fee,
    caps, capsSource,
  };
  model.risk = riskFor(model);
  return model;
}

/**
 * Resolve the rate actually charged right now, per the contract's own
 * activation rule, plus the state of any queued change.
 *
 * The important case is 'lazy-cycle' (Fast Pool): once the activation cycle is
 * reached the contract starts charging `pending-fees-bips` but never writes it
 * back to `fees-bips`, so the active var is stale and reading it alone
 * understates the fee. We reproduce `get-active-fee-bips`:
 *
 *   (if (>= (current-cycle) pending-fees-cycle) pending-fees-bips fees-bips)
 *
 * Returns null when the manager exposes no fee at all.
 */
export function resolveFee(m, vars, chain) {
  const { active, pendingBips, pendingCycle } = vars;
  const raw = active && !active.error ? active.value : null;
  const pBips = pendingBips && !pendingBips.error ? pendingBips.value : null;
  const pAt = pendingCycle && !pendingCycle.error ? pendingCycle.value : null;
  if (raw == null && pBips == null) return null;

  const mode = m.activation || 'direct';
  const base = { mode, rawBips: raw, effectiveBips: raw, rawIsStale: false, pending: null };

  // A queued change only counts as one when it actually differs from the
  // active rate; an untouched contract leaves both vars at 0.
  const hasQueued = pBips != null && (raw == null || pBips !== raw);

  if (mode === 'lazy-cycle') {
    const cycle = chain?.cycle;
    if (pAt == null || cycle == null) return base;
    const inForce = BigInt(cycle) >= pAt;
    const effective = inForce ? (pBips ?? raw) : raw;
    return {
      ...base,
      effectiveBips: effective,
      rawIsStale: inForce && pBips != null && raw != null && pBips !== raw,
      pending: hasQueued
        ? { bips: pBips, at: pAt, unit: 'cycle', inForce, automatic: true }
        : null,
    };
  }

  if (mode === 'confirm-block') {
    // Pending is a proposal; it never applies on its own. `raw` stays correct.
    if (!hasQueued) return base;
    const cooldown = m.caps?.delayBlocks ?? 0;
    const executableAt = pAt != null ? pAt + BigInt(cooldown) : null;
    const executable =
      executableAt != null && chain?.burnHeight != null
        ? BigInt(chain.burnHeight) >= executableAt
        : null;
    return {
      ...base,
      pending: { bips: pBips, at: executableAt, unit: 'block', inForce: false, executable, automatic: false },
    };
  }

  return { ...base, pending: hasQueued ? { bips: pBips, at: pAt, unit: 'cycle', inForce: false, automatic: false } : null };
}

/**
 * Risk badge. Severity order: bad > warn > ok > neutral.
 *   canChangeFee && cap >= 100%      -> bad   "Fee can be raised without limit"
 *   pending > active                 -> warn  "Fee increase scheduled"
 *   fee mutable, cap unknown         -> warn  "Fee mutable — cap not read"
 *   cap <= 5% with delay             -> ok    "Capped + delayed"
 *   cap <= 5% no delay               -> ok    "Capped"
 *   cap > 5% (< 100%) with delay     -> warn  "Capped at X% + delayed"
 *   no fee surface                   -> neutral
 */
export function riskFor(m) {
  if (m.error) return { level: 'neutral', label: 'Unavailable', detail: 'Could not read this manager.' };
  if (!m.hasFeeSurface) {
    return {
      level: 'neutral',
      label: 'No on-chain fee — terms off-chain (unverifiable)',
      detail: 'The contract exposes no fee variable and no fee mutator.',
    };
  }
  const denom = m.caps?.bipsDenominator ?? BIPS_DENOMINATOR;
  const capPct = m.caps?.maxFeeBips != null ? (m.caps.maxFeeBips / denom) * 100 : null;
  const delayed = (m.caps?.delayCycles ?? 0) > 0 || (m.caps?.delayBlocks ?? 0) > 0;
  const mutable = m.canChangeFee || m.feeMutators.length > 0;

  if (mutable && capPct != null && capPct >= 100) {
    return { level: 'bad', label: 'Fee can be raised without limit', detail: `Cap is ${fmtPct(capPct)} — no effective ceiling.` };
  }
  const pending = m.fee?.pending;
  // Only a change that has NOT yet taken effect is a scheduled risk; one that is
  // already in force is simply the current rate, reflected in effectiveBips.
  if (pending && !pending.inForce && m.fee.effectiveBips != null && pending.bips > m.fee.effectiveBips) {
    return {
      level: 'warn',
      label: pending.automatic ? 'Fee increase scheduled' : 'Fee increase proposed',
      detail: pending.automatic
        ? 'A higher fee is queued and will apply automatically.'
        : 'A higher fee is proposed; an admin must confirm it after the cooldown.',
    };
  }
  if (mutable && capPct == null) {
    return { level: 'warn', label: 'Fee mutable — cap not read', detail: 'Operator can change the fee; the ceiling could not be determined.' };
  }
  if (capPct != null && capPct <= 5) {
    return delayed
      ? { level: 'ok', label: 'Capped + delayed', detail: `Ceiling ${fmtPct(capPct)}; changes take effect only after a delay.` }
      : { level: 'ok', label: 'Capped', detail: `Ceiling ${fmtPct(capPct)}; changes take effect immediately.` };
  }
  if (capPct != null) {
    return delayed
      ? { level: 'warn', label: `Capped at ${fmtPct(capPct)} + delayed`, detail: 'Higher ceiling, but changes are delayed.' }
      : { level: 'warn', label: `Capped at ${fmtPct(capPct)}`, detail: 'Higher ceiling; changes take effect immediately.' };
  }
  return { level: 'ok', label: 'Fee fixed', detail: 'No fee mutator on this contract.' };
}

function fmtPct(p) {
  return `${Number.isInteger(p) ? p : p.toFixed(2).replace(/\.?0+$/, '')}%`;
}

// ---------------------------------------------------------------- all

export async function readAll(opts) {
  // Chain position first: fee activation rules are evaluated against it.
  // If it fails we still render, just without lazy-activation resolution.
  const chainRes = await safe(() => getPoxInfo(opts));
  const chain = chainRes.value;

  const [protocol, managers] = await Promise.all([
    readProtocol(opts),
    Promise.all(MANAGERS.map((m) => readManager(m, chain, opts))),
  ]);
  return { protocol, managers, chain, chainError: chainRes.error, readAt: new Date() };
}
