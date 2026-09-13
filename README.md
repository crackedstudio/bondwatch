# bondwatch

A verification spike for a pox-5 (SIP-045 Bitcoin Staking) bond-state monitor.

**Narrow goal:** prove that pox-5 bond state — and each pool's mutable fee/admin
surface — can be read programmatically off a Stacks node, and check five ranked
claims against ground truth. Nothing is built here beyond a read script.

## What's here

```
FINDINGS.md                        verified results for items 1–5 (start here)
evidence/
  pox-5-interface.json             deployed contract interface (119 functions)
  pox-5-constants.txt              constant values + rewards-paused write sites
  live-state.json                  decoded live mainnet reads (2026-09-13)
scripts/
  read_bond_state.py               reads + decodes live bond state (stdlib only)
  clarinet-console-commands.md     devnet-console equivalent to run on the Mac
```

## Run it

```bash
python3 scripts/read_bond_state.py           # reads mainnet via api.hiro.so
```

## Headline results

- **`pause-rewards` is irreversible** — the only writer of `rewards-paused` sets
  it to `true`; no path sets it back. Highest-severity monitor rule, confirmed.
- **One principal holds both `bond-admin` and `pause-admin`** on mainnet.
- **Real pool managers diverge from the reference**: Fast Pool caps fees at 5%
  and delays changes 2 cycles (0% active, 4.5% *pending* for cycle 142); Xverse
  allows up to 100%; Native Pool exposes no on-chain fee surface at all. The
  monitor must be per-manager-contract-aware — that's the wedge.

## Environment note

`clarinet devnet start` was not launched from the build environment (the shell
reaching the Mac is an isolated Linux sandbox without the host's Docker/Clarinet,
and no Docker daemon was reachable). Verification used the authoritative deployed
contract instead — see FINDINGS.md. To run devnet locally, use the commands in
`scripts/clarinet-console-commands.md` on the Mac (Docker running, Clarinet
3.23.0+), verifying flags against `clarinet --help` first.
