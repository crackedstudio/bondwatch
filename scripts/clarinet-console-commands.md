# Reproducing bond-state reads in the Clarinet devnet console

Devnet gives you Epoch 4.0 / Clarity 6 / pox-5 from a snapshot at block 163, so
you can read the same state locally without waiting on mainnet. Run these on the
Mac (where Docker + Clarinet 3.23.0+ live). **Verify every flag against
`clarinet --help` / `clarinet devnet --help` first — do not trust the exact
syntax below blindly, the CLI surface changes between releases.**

```bash
# Docker must be running first.
clarinet new bondwatch
cd bondwatch
clarinet devnet start          # boots the pox-5 snapshot; leave it running
```

In another terminal, open the console wired to the running devnet
(check `clarinet console --help` for the current flag name — historically
`--enable-network`/`--devnet` or similar):

```clojure
;; --- pox-5 protocol layer (read-only, no signer needed) ---
(contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-reserve-balance)
(contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-total-sbtc-staked)
(contract-call? 'SP000000000000000000002Q6VF78.pox-5 current-pox-reward-cycle)
(contract-call? 'SP000000000000000000002Q6VF78.pox-5 current-distribution-cycle)

;; data-vars have no getters for the admin/paused flags, so read them directly:
(var-get rewards-paused)     ;; from inside the pox-5 contract context
(var-get bond-admin)
(var-get pause-admin)

;; per-staker / per-signer bond state:
(contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-staker-info <staker-principal>)
(contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-info <signer-principal>)
(contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-protocol-bond <bond-index>)
```

Note: the mainnet pool signer-managers (Fast Pool, Xverse, etc.) are **not** in
the devnet snapshot — they are third-party deployments. Read those against a
real node instead, which is exactly what `read_bond_state.py` does:

```bash
python3 scripts/read_bond_state.py            # defaults to https://api.hiro.so
```

The node-API reads and the console reads return the same underlying state; the
API path is what a monitoring service would actually use in production.
