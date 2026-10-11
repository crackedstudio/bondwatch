// Hiro API helpers: fetch with optional API key, 429 backoff, bounded
// concurrency, and a session cache for immutable reads (interface, source).

import { HIRO_HOSTS } from '../config.js';

/** Optional key from `?hiroKey=` or `window.HIRO_API_KEY`. Never persisted. */
export function apiKey() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('hiroKey');
    if (fromUrl) return fromUrl;
  } catch { /* non-browser */ }
  return (typeof window !== 'undefined' && window.HIRO_API_KEY) || null;
}

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 120)}` : ''}`);
    this.status = status;
    this.url = url;
  }
}

// Bounded concurrency so a refresh doesn't fire 40 requests in one burst.
const MAX_CONCURRENT = 4;
let active = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) { active++; resolve(); }
    else queue.push(resolve);
  });
}
function release() {
  const next = queue.shift();
  if (next) next(); else active--;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hosts to try, newest-first: an explicit `?node=` override, then HIRO_HOSTS. */
function hostList() {
  try {
    const override = new URLSearchParams(location.search).get('node');
    if (override) return [override.replace(/\/+$/, ''), ...HIRO_HOSTS];
  } catch { /* non-browser */ }
  return HIRO_HOSTS;
}

// Index into hostList() that last answered. Starts at the preferred host and
// only moves when that host cannot serve a request at all, so a working host
// is reused for the rest of the session instead of re-probing every refresh.
let hostIdx = 0;

/** The host currently serving reads — shown in the footer for provenance. */
export function currentHost() {
  return hostList()[hostIdx] ?? HIRO_HOSTS[0];
}

/**
 * GET `path` and parse JSON, failing over across hostList().
 *
 * A 404 is NOT a host problem — callers use it to mean "this var/contract is
 * absent" — so it propagates immediately rather than retrying elsewhere.
 * Any other exhausted failure advances to the next host.
 */
export async function getJson(path, opts = {}) {
  const list = hostList();
  let lastErr;
  for (let i = 0; i < list.length; i++) {
    const idx = (hostIdx + i) % list.length;
    // Don't spend the backoff ladder on a host while alternates are untried --
    // a dead host should be abandoned fast. The last host keeps the full ladder
    // so a transient 429/5xx there still gets retried rather than giving up.
    const isLast = i === list.length - 1;
    try {
      const out = await getJsonFrom(list[idx], path, isLast ? opts : { ...opts, retries: 0 });
      if (idx !== hostIdx) {
        console.warn(`[bondwatch] failed over to ${list[idx]}`);
        hostIdx = idx;
      }
      return out;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (err instanceof HttpError && err.status === 404) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * GET `base + path` and parse JSON.
 * Retries on 429 / 5xx / network failure with short exponential backoff.
 * 404 is thrown immediately as HttpError(404) so callers can treat it as "absent".
 */
async function getJsonFrom(base, path, { retries = 3, signal } = {}) {
  const url = `${base}${path}`;
  const headers = { Accept: 'application/json' };
  const key = apiKey();
  if (key) headers['x-api-key'] = key;

  let attempt = 0;
  for (;;) {
    await acquire();
    let res, text;
    try {
      res = await fetch(url, { headers, signal, cache: 'no-store' });
      text = await res.text();
    } catch (err) {
      release();
      if (signal?.aborted) throw err;
      if (attempt >= retries) throw err;
      await sleep(backoff(attempt++));
      continue;
    }
    release();

    if (res.ok) {
      try { return JSON.parse(text); }
      catch { throw new Error(`Bad JSON from ${url}`); }
    }
    if (res.status === 404) throw new HttpError(404, url, text);
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 && ra < 30 ? ra * 1000 : backoff(attempt));
      attempt++;
      continue;
    }
    throw new HttpError(res.status, url, text);
  }
}

function backoff(attempt) {
  // 1.5s, 3s, 6s (+ jitter)
  return 1500 * 2 ** attempt + Math.random() * 400;
}

/** Raw hex of a data var, e.g. "0x04". */
export async function getDataVarHex(address, contract, varName, opts) {
  const j = await getJson(
    `/v2/data_var/${address}/${contract}/${encodeURIComponent(varName)}?proof=0`, opts,
  );
  if (!j || typeof j.data !== 'string') throw new Error(`No data for ${varName}`);
  return j.data;
}

// Contract interface and source never change after deploy: cache for the session.
const cache = new Map();
async function cached(key, loader) {
  if (cache.has(key)) return cache.get(key);
  const p = loader().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, p);
  return p;
}

export function getInterface(address, contract, opts) {
  return cached(`iface:${address}.${contract}`, () =>
    getJson(`/v2/contracts/interface/${address}/${contract}`, opts));
}

/**
 * Chain position: the current PoX reward cycle and burn block height.
 * Needed to evaluate fee-activation rules that contracts apply lazily at read
 * time (see monitor.js). Not cached — it moves.
 */
export async function getPoxInfo(opts) {
  const j = await getJson('/v2/pox', opts);
  const cycleId = j?.current_cycle?.id ?? j?.reward_cycle_id;
  if (cycleId == null) throw new Error('No current cycle in /v2/pox');
  return {
    cycle: Number(cycleId),
    burnHeight: Number(j.current_burnchain_block_height ?? 0),
  };
}

export function getSource(address, contract, opts) {
  return cached(`src:${address}.${contract}`, async () => {
    const j = await getJson(`/v2/contracts/source/${address}/${contract}?proof=0`, opts);
    return j?.source ?? '';
  });
}
