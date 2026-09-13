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

## What this proves

Every field a delegator is exposed to after their bond is locked — the
protocol-level admin/pause flags and each pool's fee/admin surface — is readable
from public node endpoints with no privileged access, and decodes to concrete,
current values. The monitor is therefore a thin, verifiable layer over reads any
party can perform. `scripts/read_bond_state.py` is the working proof.
