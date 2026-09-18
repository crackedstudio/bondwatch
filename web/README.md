# BondWatch — web dashboard

A pure client-side static site that reads Stacks mainnet **pox-5** (SIP-045
Bitcoin Staking) bond-risk state and every pool signer-manager's fee/admin
surface straight from the public Hiro API, and renders it. No backend, no
bundler, no framework, no build step — `web/` is served as-is.

```
web/
  index.html      loads src/main.js as an ES module
  styles.css      dark theme by default, light toggle, system font stack
  config.js       every contract address, manager, and known cap (no secrets)
  src/
    clarity.js    Clarity hex decoders (uint / bool / optional / principal -> c32)
    hiro.js       fetch helpers: optional API key, 429 backoff, bounded concurrency
    monitor.js    reads pox-5 + each manager, builds the state model + risk badge
    render.js     turns the state model into DOM
    main.js       boot: c32 self-test, load, 60 s auto-refresh, manual refresh, theme
  vercel.json     static-site config
```

## Run locally

Any static file server works. Opening `index.html` directly via `file://`
will **not** work because ES modules need an HTTP origin.

```bash
npx serve web
```

or

```bash
python3 -m http.server -d web 8080
```

then open the printed URL (e.g. http://localhost:8080). The page loads live
mainnet data immediately; watch the browser console for
`[bondwatch] c32 self-test passed`.

### Optional Hiro API key

The public endpoint is rate-limited. To use a key, pass it at runtime — it is
never stored in the repo:

- URL param: `http://localhost:8080/?hiroKey=YOUR_KEY`
- or set `window.HIRO_API_KEY = 'YOUR_KEY'` before `src/main.js` runs
  (e.g. an inline `<script>` injected by your host).

If present it is sent as the `x-api-key` header.

## What it reads

| Layer | Contract | Fields |
|---|---|---|
| Protocol | `SP000000000000000000002Q6VF78.pox-5` | `bond-admin`, `pause-admin`, `rewards-paused`, `configured`, `reserve-balance`, `total-sbtc-staked` |
| Pool | each signer-manager in `config.js` | interface (does `update-fees` / `update-admin` exist?), then whichever fee data vars the interface declares (`fees-bips`, `pending-fees-bips`, `pending-fees-cycle`, `earned-fees`, `fee-bips`, `pending-fee`, …) |

Fee caps come from `config.js` where they were verified in `FINDINGS.md`;
for other managers the monitor parses `MAX_FEE_BIPS` / `MAX_BIPS` /
`FEE_COOLDOWN` from `/v2/contracts/source` best-effort, and otherwise shows
"cap: not read". A failed read renders as "unavailable" for that field or card
and never breaks the page.

Endpoints used (all `GET`, CORS-enabled):

- `/v2/data_var/{address}/{contract}/{var}?proof=0`
- `/v2/contracts/interface/{address}/{contract}`
- `/v2/contracts/source/{address}/{contract}?proof=0` (only when a cap constant is declared and not in config)

## Deploy

### Vercel

From the repo root:

```bash
vercel deploy --cwd web
```

Or in the dashboard: import the repo, set **Root Directory** to `web`,
**Framework Preset** to *Other*, leave **Build Command** empty, **Output
Directory** `.`. `web/vercel.json` already sets these plus a few static
headers. To ship to production:

```bash
vercel deploy --cwd web --prod
```

### Netlify

Drag-and-drop the `web` folder onto https://app.netlify.com/drop, or connect
the repo with **Base directory** `web`, no build command, **Publish directory**
`web`.

### GitHub Pages

Settings → Pages → Deploy from a branch → `main` / `/ (root)`, then open
`https://<user>.github.io/<repo>/web/`. (Or copy `web/` into a `gh-pages`
branch root.) Because paths in `index.html` are relative, it works from any
sub-path.

## Adding a pool

Append an entry to `MANAGERS` in `config.js` with the contract's address and
name, the candidate fee var names to try, and (optionally) verified `caps`.
Everything else — mutator detection, var existence, decoding, risk badge — is
derived from the deployed interface at runtime.
