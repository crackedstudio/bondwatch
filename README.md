# bondwatch

A verification spike for a pox-5 (SIP-045 Bitcoin Staking) bond-state monitor.

**Narrow goal:** prove that pox-5 bond state — and each pool's mutable fee/admin
surface — can be read programmatically off a Stacks node, and check five ranked
claims against ground truth.

That verification held up, and two things came out of leaving it running against
mainnet rather than stopping at the writeup: a pool fee that the chain's own
variable reports as `0%` while it is actually charging 4.5% and accruing, and a
monitored surface that grew from 160 to 665 sBTC in ten days. Both are recorded
with dated evidence below. The repo now also carries a live read-only dashboard
(`web/`) that any reviewer can open.

## What's here

```
FINDINGS.md                        verified results for items 1–6 (start here)
evidence/
  pox-5-interface.json             deployed contract interface (119 functions)
  pox-5-constants.txt              constant values + rewards-paused write sites
  live-state.json                  decoded live mainnet reads (2026-09-13)
  live-state-2026-10-01.json       second dated snapshot; shows what moved since
  live-state-2026-10-11.json       third dated snapshot (cycle 145), all 7 managers
scripts/
  read_bond_state.py               reads + decodes live bond state (stdlib only)
  clarinet-console-commands.md     devnet-console equivalent to run on the Mac
web/                               live read-only dashboard (static, no build step)
```

## Run it

```bash
python3 scripts/read_bond_state.py           # reads mainnet via api.hiro.so
```

## Live dashboard

`web/` is a static, client-side dashboard that performs the same reads as
`scripts/read_bond_state.py` from the browser against mainnet and renders the
protocol pause/admin state plus every pool signer-manager's fee/admin surface,
auto-refreshing every 60 s. No wallet, no backend.

It leads with **what a delegator would actually pay**: one table across all
seven managers, sorted by the rate in force now, showing the worst case each
contract permits, how fast it can get there, and whether the fee is on-chain at
all. The speed column is the part a published fee schedule cannot tell you —
Xverse can move on the next transaction, Juice needs an admin confirmation after
144 blocks, and Fast Pool needs no transaction at all. Per-contract detail
follows underneath.

Reads fail over across node hosts rather than depending on one endpoint.

- **Deployed:** https://bondwatch.vercel.app
- **Run locally:** `python3 -m http.server -d web 8080` then open http://localhost:8080
- Details, deploy steps and the optional Hiro API key: [`web/README.md`](web/README.md)

## Headline results

- **`pause-rewards` is irreversible** — the only writer of `rewards-paused` sets
  it to `true`; no path sets it back. Highest-severity monitor rule, confirmed.
- **One principal holds both `bond-admin` and `pause-admin`** on mainnet.
- **Real pool managers diverge from the reference**: Fast Pool caps fees at 5%
  and delays changes 2 cycles; Xverse allows up to 100%; Native Pool exposes no
  on-chain fee surface at all. The monitor must be per-manager-contract-aware —
  that's the wedge.
- **A pool's fee variable can be wrong, and is.** Fast Pool's `fees-bips` has
  read `0` in every snapshot since 2026-09-13 while the contract has charged
  **4.5%** since cycle 142,
  because it resolves a queued rate at read time and never writes it back. As of
  cycle 145 its `earned-fees` has accrued **4,644,704 sats** at a rate the
  variable still reports as zero. No transaction marks the change, so nothing in
  the mempool or the event log can catch it (items 4a, 4b).
- **The exposed surface is growing fast**: `total-sbtc-staked` went
  **160.17 → 664.86 sBTC between 2026-10-01 and 2026-10-11** as bond capacity
  stepped up. Every finding above is denominated in value a staker cannot
  withdraw (item 6).

## A note on method

Verification was done against the **deployed mainnet contract**, not a devnet
mirror of it. Devnet reproduces the contract; mainnet is the contract, and the
pool signer-managers that turned out to be the interesting part exist only
there. Every number in FINDINGS.md is therefore a live read with a date and a
reproducible command against it.

`scripts/clarinet-console-commands.md` gives the devnet-console equivalents for
anyone who wants to run the same reads locally (Docker running, Clarinet
3.23.0+); `clarinet devnet start` was not run from the build environment, which
had no reachable Docker daemon.
