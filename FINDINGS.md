# BondWatch — pox-5 verification findings

Goal (narrow): prove bond state can be read programmatically, and check the five
ranked claims from the mutable-parameters notes against ground truth. Not to
build anything.

**How these were verified.** `clarinet devnet start` could not be launched from
the working environment (the shell reaching the Mac runs in an isolated Linux
sandbox that does not see the host's Docker/Clarinet, and no Docker daemon is
reachable). Devnet is only a local mirror of the deployed contract, so
verification was done against the **authoritative source instead**: the raw
`pox-5.clar` at the `4.0.1` tag, the deployed contract's interface and
`data_var` reads from a Stacks node (`api.hiro.so`), and the real pool
signer-managers on mainnet. `scripts/read_bond_state.py` reproduces every live
read; `scripts/clarinet-console-commands.md` gives the devnet-console equivalent
to run on the Mac.

Contract: `SP000000000000000000002Q6VF78.pox-5`. Live reads dated 2026-09-13.

---

## Item 1 — Is `pause-rewards` reversible?  **NO. The "permanent" claim holds.**

Verified at source level, not just by the absence of an `unpause` name.
`rewards-paused` appears in exactly three places in `pox-5.clar` (4.0.1):

| Line | Code | Role |
|---|---|---|
| 354 | `(define-data-var rewards-paused bool false)` | initial value |
| 493 | `(var-set rewards-paused true)` inside `(pause-rewards)` | **the only writer** |
| 2404 | `(asserts! (not (var-get rewards-paused)) ERR_REWARDS_PAUSED)` | read guard |

There is **no** `(var-set rewards-paused false)` anywhere in the 119-function
contract. The full interface confirms no `unpause-rewards` / `resume-rewards` /
`set-rewards-paused` exists; `set-pause-admin` only changes *who* may pause.
Once `pause-rewards` fires, the flag can never return to `false` without a hard
fork. **This is the single highest-severity monitoring rule, and it survives a
technical reviewer's check.**

`pause-rewards` is gated `(asserts! (is-eq contract-caller (var-get pause-admin)) ERR_UNAUTHORIZED)`.

Live value: `rewards-paused = false` (not currently paused).

## Item 2 — Do the Layer 1 function names exist as written?  **YES, all four.**

Confirmed against the deployed interface: `set-bond-admin`, `set-pause-admin`,
`setup-bond`, `update-bond-registration` all present as `public` functions.
(Also confirmed: `register-signer`, `grant-signer-key`, `revoke-signer-grant`,
`stake`, `stake-update`, `unstake`, `unstake-sbtc`, `register-for-bond`,
`announce-l1-early-exit`, `pause-rewards`, `calculate-rewards`, `claim-rewards`,
`claim-staker-rewards-for-signer`, `set-burnchain-parameters`.)

## Item 3 — Constant values (names trusted, numbers verified).

Read from `pox-5.clar` @ 4.0.1:

| Constant | Value | Meaning |
|---|---|---|
| `BOND_LENGTH_CYCLES` | `u12` | bond term in signer cycles |
| `BOND_GAP_CYCLES` | `u2` | gap between bond openings |
| `MAX_NUM_CYCLES` | `u96` | cap on cycles in one operation |
| `SIGNER_SET_MIN_USTX` | `u50000000000` | 50,000 STX minimum |
| `BITCOIN_LOCKTIME_THRESHOLD` | `u500000000` | height-vs-timestamp locktime split |
| `PRECISION` | `u1000000000000000000` | 1e18 fixed-point scale |
| `RESERVE_RATIO` | `u1500` | 1500 bips = 15% |

## Item 5 — Live `bond-admin` (read, not assumed).

Read off mainnet and decoded (c32-check; encoder self-tested against the boot
address `SP000000000000000000002Q6VF78`):

- `bond-admin`  = `SP72DMR3MJKS7RVBY33JVV7EEJSQ1PYDVKDP10FX`
- `pause-admin` = `SP72DMR3MJKS7RVBY33JVV7EEJSQ1PYDVKDP10FX`

It happens to still equal the source default (not rotated since deploy). **New
finding worth flagging:** `bond-admin == pause-admin` — a *single* principal
holds both roles, so one key can both rotate the admin set *and* fire the
irreversible reward pause. That concentration is itself an alert condition.

Other live protocol state: `configured = true`, `reserve-balance ≈ 1.2019 sBTC`,
`total-sbtc-staked ≈ 160.17 sBTC`.

---

## Item 4 — Real deployed signer-managers (the wedge). **They diverge from the reference — this is the finding.**

Found by parsing pox-5's emitted events for the recorded signer
(`contract-of signer-manager`). Real managers on mainnet include Xverse
(`-1/-2/-3`), Fast Pool, Native Pool, Juice, PlanBetter. Three read in detail:

| Pool manager | `update-fees` / `update-admin`? | Fee cap | Delay | Live fee |
|---|---|---|---|---|
| `SPMPMA…TZFZ4Q4.fastpool-max500-signer-manager` | yes / yes | **`MAX_FEE_BIPS = 500` (5%)** | **`FEE_ACTIVATION_DELAY_CYCLES = 2`** | active **0%**, **pending 4.5% at cycle 142** |
| `SP8HK16…XVERSE.xverse-signer-manager-1` | yes / yes | `MAX_BIPS = 10000` (**100% — effectively none**) | none seen | **4.95%** |
| `SP4SZE4…VMDPBG.native-pool-signer-manager` | **no / no** | n/a | n/a | **no on-chain fee surface at all** (6 functions, no fee var, no admins map) |

Consequences for the notes and for the monitor design:

1. **The reference is not the reality.** My earlier note said the manager fee
   "can be raised toward `u9999` (99.99%) with no lockout." That is true only of
   the bare reference contract. Fast Pool **caps fees at 5% and delays any
   change by 2 cycles**; Xverse permits up to **100%**; Native Pool exposes **no
   fee mutator on-chain**. The worst-case value and the reaction time are
   *per-pool*, not universal.
2. **A generic "watch `update-fees`" monitor is insufficient and can give false
   comfort.** For Native Pool it would find nothing to watch even though a
   delegator still pays a fee somewhere off-chain. For Fast Pool it must read
   `pending-fees-bips` / `pending-fees-cycle` (via `get-pending-fees`), not just
   the active `fees-bips`, or it misses a fee that is *already scheduled* — as is
   the case live right now (0% active, 4.5% pending for cycle 142).
3. **The monitor must be per-manager-contract-aware**: resolve each staker's
   actual signer-manager, read *that* contract's fee variables, cap constant,
   and delay constant, and alert on the pool's own mechanism. This per-pool
   surfacing is the product wedge.

---

## Item 4a — Fee activation is *lazy*: reading the active variable is not enough. (Added 2026-10-01, cycle 144.)

The 2026-09-13 reading recorded Fast Pool at **0% active with 4.5% pending for
cycle 142**. Re-reading on **2026-10-01, at cycle 144**, the chain says:

| Var | Value |
|---|---|
| `fees-bips` | `u0` |
| `pending-fees-bips` | `u450` |
| `pending-fees-cycle` | `u142` |

The activation cycle passed two cycles ago, yet `fees-bips` **still reads 0**.
Nothing wrote the new rate back. The contract resolves it at read time instead,
and its own source comment says to read `get-active-fee-bips` rather than either
variable directly:

```clarity
(define-read-only (get-active-fee-bips)
  (if (>= (current-cycle) (var-get pending-fees-cycle))
    (var-get pending-fees-bips)
    (var-get fees-bips)))
```

Since `144 >= 142`, **the fee actually charged is 4.5% and has been since cycle
142**, while the variable a naive monitor reads says 0% and will keep saying 0%
indefinitely.

### This sharpens the wedge rather than contradicting it

Item 4 said a monitor must read `pending-fees-bips`, not just the active var, or
it misses a scheduled change. That is right but understates the problem. On a
lazy-activation contract **neither raw variable is ever authoritative on its
own** — the effective rate is a function of chain position, so the monitor has
to evaluate the contract's activation rule against the current cycle.

And the rule is not shared. Across the real managers there are three distinct
activation models, which have to be handled separately:

| Model | Pools | Behaviour | Is the active var trustworthy? |
|---|---|---|---|
| **lazy-cycle** | Fast Pool | Pending applies automatically once its cycle is reached; never written back | **No** — goes stale permanently |
| **confirm-block** | Juice | Pending is a *proposal*; an admin must call `confirm-fee-bips` after `FEE_COOLDOWN` (144 burn blocks), which writes the var | Yes |
| **direct** | Xverse ×3, Native, PlanBetter | The mutator writes the active var immediately | Yes |

Applying the wrong model is wrong in both directions: use Juice's rule on Fast
Pool and you under-report a fee that is already being charged; use Fast Pool's
rule on Juice and you invent a fee increase that an admin may never confirm, or
may cancel outright via `cancel-fee-bips`.

### Found in production, by the tool itself

This is not a hypothetical. The BondWatch dashboard shipped on 2026-09-18 read
`fees-bips` directly and therefore displayed *"Active fee 0%"* with a badge
reading *"activates cycle 142"* — a cycle already in the past — for roughly two
weeks. It was making precisely the mistake this document warns about, and the
error only became visible because the monitor was left running against mainnet
while the chain moved underneath it.

Fixed in `3d5d394`: chain position is read from `/v2/pox` and the effective rate
is resolved per manager through an explicit `activation` model. Note that
`POST /v2/contracts/call-read-only` returns 404 on the public Hiro endpoint, so
the rule is reproduced client-side rather than executed on a node; if `/v2/pox`
is unavailable the dashboard falls back to raw variables and says so, rather
than silently reporting a stale number.

**Monitoring rule this yields:** alert on the *effective* rate changing, not on
`update-fees` being called. A lazy activation changes what a staker pays with no
transaction at all — there is no event to subscribe to, and nothing in the
mempool. Fee monitoring that watches only for transactions cannot see it.

---

## What this proves

Every field a delegator is exposed to after their bond is locked — the
protocol-level admin/pause flags and each pool's fee/admin surface — is readable
from public node endpoints with no privileged access, and decodes to concrete,
current values. The monitor is therefore a thin, verifiable layer over reads any
party can perform. `scripts/read_bond_state.py` is the working proof.
