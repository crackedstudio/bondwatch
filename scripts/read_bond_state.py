#!/usr/bin/env python3
"""
read_bond_state.py — prove you can read pox-5 bond state programmatically.

Reads the DEPLOYED mainnet pox-5 contract and every pool signer-manager
contract straight off a Stacks node (no wallet, no privileged access),
and decodes the serialized Clarity values into human-readable state.

This is the "prove you can read bond state" artifact. It talks to a public
node API; the exact same reads are reproducible in the Clarinet devnet console
(see scripts/clarinet-console-commands.md) against the pox-5 snapshot.

The fee a staker actually pays is NOT always the pool's active fee variable.
Each manager has its own activation rule, so this script reads the chain's
current reward cycle and resolves the EFFECTIVE rate per contract. See
FINDINGS.md item 4a — on a lazy-activation manager the active variable goes
stale permanently and reading it alone understates the fee.

Usage:
    python3 read_bond_state.py
    python3 read_bond_state.py --node https://api.hiro.so
    python3 read_bond_state.py --json          # machine-readable snapshot

No dependencies beyond the Python 3 standard library.
"""
import argparse, hashlib, json, ssl, sys, urllib.error, urllib.request

POX5 = ("SP000000000000000000002Q6VF78", "pox-5")

# Pool signer-managers observed calling into pox-5 on mainnet (item 4).
# `activation` is how a queued fee becomes the rate actually charged:
#   lazy-cycle    pending applies automatically once its cycle is reached and is
#                 never written back — the active var goes stale FOREVER.
#   confirm-block pending is only a proposal; an admin must confirm it after a
#                 burn-block cooldown, which writes the active var.
#   direct        the mutator writes the active var immediately.
#   none          no on-chain fee surface at all.
# Kept in step with web/config.js, which the dashboard reads.
MANAGERS = [
    dict(addr="SPMPMA1V6P430M8C91QS1G9XJ95S59JS1TZFZ4Q4", name="fastpool-max500-signer-manager",
         label="Fast Pool", activation="lazy-cycle",
         active=["fees-bips"], pending_bips=["pending-fees-bips"], pending_cycle=["pending-fees-cycle"],
         earned=["earned-fees"]),
    dict(addr="SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE", name="xverse-signer-manager-1",
         label="Xverse", activation="direct", active=["fees-bips"], earned=["earned-fees"]),
    dict(addr="SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE", name="xverse-signer-manager-2",
         label="Xverse (manager 2)", activation="direct", active=["fees-bips"], earned=["earned-fees"]),
    dict(addr="SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE", name="xverse-signer-manager-3",
         label="Xverse (manager 3)", activation="direct", active=["fees-bips"], earned=["earned-fees"]),
    dict(addr="SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22", name="juice-pool-stx-signer",
         label="Juice Pool", activation="confirm-block",
         active=["fees-bips", "fee-bips"], pending_bips=["pending-fees-bips", "pending-fee"],
         pending_cycle=["pending-fees-cycle", "pending-fee-height"], earned=["earned-fees"]),
    dict(addr="SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG", name="native-pool-signer-manager",
         label="Native Pool", activation="none", active=["fees-bips", "fee-bips"]),
    dict(addr="SP3ZA8J49HPS7M3KD7EB01Y0ZAJS7VJS2NG87MDGN", name="planbetter-signer-manager",
         label="PlanBetter", activation="direct", active=["fees-bips", "fee-bips"], earned=["earned-fees"]),
]

C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
HEX = "0123456789abcdef"


# --- minimal Clarity value decoders (only what bond state uses) ---------------
def decode_bool(h):
    h = h[2:] if h.startswith("0x") else h
    return {"03": True, "04": False}[h[:2]]


def decode_uint(h):
    h = h[2:] if h.startswith("0x") else h
    assert h[:2] == "01", f"not a uint: {h[:2]}"
    return int(h[2:], 16)


def _c32encode(hexstr):
    if len(hexstr) % 2:
        hexstr = "0" + hexstr
    hexstr = hexstr.lower()
    res, carry = [], 0
    for i in range(len(hexstr) - 1, -1, -1):
        if carry < 4:
            cur = HEX.index(hexstr[i]) >> carry
            nxt = HEX.index(hexstr[i - 1]) if i else 0
            bits = 1 + carry
            low = (nxt % (1 << bits)) << (5 - bits)
            res.insert(0, C32[cur + low])
            carry = bits
        else:
            carry = 0
    lead = 0
    for ch in res:
        if ch == "0":
            lead += 1
        else:
            break
    res = res[lead:]
    nz, i = 0, 0
    while i + 1 < len(hexstr) and hexstr[i:i + 2] == "00":
        nz += 1; i += 2
    return "0" * nz + "".join(res)


def decode_principal(h):
    """Standard principal 0x05 <version> <20-byte hash160> -> SP/ST address."""
    h = h[2:] if h.startswith("0x") else h
    assert h[:2] == "05", "only standard principals handled here"
    version = int(h[2:4], 16)
    hash160 = h[4:]
    data = bytes([version]) + bytes.fromhex(hash160)
    checksum = hashlib.sha256(hashlib.sha256(data).digest()).digest()[:4]
    return "S" + C32[version] + _c32encode(hash160 + checksum.hex())


# --- node reads ---------------------------------------------------------------
# A stock python.org build on macOS ships no CA bundle unless the bundled
# "Install Certificates.command" has been run, so the default context fails
# with CERTIFICATE_VERIFY_FAILED. Fall back to certifi's bundle if it is
# importable. Verification is never disabled.
_CTX = None


def _ctx():
    global _CTX
    if _CTX is None:
        _CTX = ssl.create_default_context()
    return _CTX


def _fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=25, context=_ctx()) as r:
            return json.load(r)
    except urllib.error.URLError as e:
        if not isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            raise
        global _CTX
        try:
            import certifi
        except ImportError:
            sys.exit(
                "TLS certificate verification failed and certifi is not installed.\n"
                "This Python has no CA bundle. Fix with either:\n"
                "  /Applications/Python\\ 3.12/Install\\ Certificates.command\n"
                "  python3 -m pip install certifi\n"
                "Nothing was read; no state is reported."
            )
        _CTX = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(url, timeout=25, context=_CTX) as r:
            return json.load(r)


def get_data_var(node, addr, name, var):
    return _fetch(f"{node}/v2/data_var/{addr}/{name}/{var}?proof=0")["data"]


def get_interface(node, addr, name):
    return _fetch(f"{node}/v2/contracts/interface/{addr}/{name}")


def get_pox(node):
    return _fetch(f"{node}/v2/pox")


def has_fn(iface, fn):
    return any(f["name"] == fn for f in iface.get("functions", []))


def declared_vars(iface):
    return {v["name"] for v in iface.get("variables", [])}


def read_first(node, m, iface_vars, keys):
    """Read the first candidate var name the contract actually declares."""
    for var in m.get(keys, []) or []:
        if var in iface_vars:
            try:
                return var, decode_uint(get_data_var(node, m["addr"], m["name"], var))
            except Exception:
                continue
    return None, None


def resolve_effective(activation, active, pending_bips, pending_cycle, cycle):
    """The rate a staker is actually charged, per the contract's own rule."""
    if activation == "lazy-cycle":
        if pending_bips is not None and pending_cycle is not None and cycle >= pending_cycle:
            return pending_bips, f"pending rate in force since cycle {pending_cycle} (now {cycle})"
        return active, "pending not yet reached; active var is current"
    if activation == "confirm-block":
        return active, "pending is a proposal only until an admin confirms it"
    if activation == "direct":
        return active, "mutator writes the active var immediately"
    return None, "no on-chain fee surface"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default="https://api.hiro.so")
    ap.add_argument("--json", action="store_true", help="emit a machine-readable snapshot")
    args = ap.parse_args()
    node = args.node.rstrip("/")
    addr, name = POX5

    pox = get_pox(node)
    cycle = pox["reward_cycle_id"]
    burn = pox.get("current_burnchain_block_height")

    bond_admin = decode_principal(get_data_var(node, addr, name, "bond-admin"))
    pause_admin = decode_principal(get_data_var(node, addr, name, "pause-admin"))
    paused = decode_bool(get_data_var(node, addr, name, "rewards-paused"))
    configured = decode_bool(get_data_var(node, addr, name, "configured"))
    reserve = decode_uint(get_data_var(node, addr, name, "reserve-balance"))
    staked = decode_uint(get_data_var(node, addr, name, "total-sbtc-staked"))

    snapshot = {
        "contract": f"{addr}.{name}",
        "node": node,
        "chain": {"pox_reward_cycle": cycle, "burn_block_height": burn},
        "bond-admin": bond_admin,
        "pause-admin": pause_admin,
        "bond_admin_equals_pause_admin": bond_admin == pause_admin,
        "rewards-paused": paused,
        "configured": configured,
        "reserve-balance_sats": reserve,
        "total-sbtc-staked_sats": staked,
        "managers": {},
    }

    if not args.json:
        print(f"# pox-5 protocol state  ({addr}.{name})  via {node}")
        print(f"# chain at reward cycle {cycle}, burn block {burn}\n")
        print(f"  bond-admin        : {bond_admin}")
        print(f"  pause-admin       : {pause_admin}")
        if bond_admin == pause_admin:
            print("    !! one principal holds BOTH roles (can rotate admin AND permanently pause)")
        print(f"  rewards-paused    : {paused}"
              + ("   !! IRREVERSIBLE ONCE TRUE — no unpause path in the contract" if paused else ""))
        print(f"  configured        : {configured}")
        print(f"  reserve-balance   : {reserve} sats ({reserve/1e8:.8f} sBTC)")
        print(f"  total-sbtc-staked : {staked} sats ({staked/1e8:.8f} sBTC)")
        print("\n# pool signer-managers — EFFECTIVE fee, resolved per contract's own"
              " activation rule\n# (item 4/4a: the rules diverge, and a raw active var can be stale)\n")

    for m in MANAGERS:
        key = f"{m['addr']}.{m['name']}"
        try:
            iface = get_interface(node, m["addr"], m["name"])
        except Exception as e:
            if not args.json:
                print(f"  {m['label']}: interface unavailable ({e})\n")
            snapshot["managers"][key] = {"error": f"interface unavailable: {e}"}
            continue

        ivars = declared_vars(iface)
        has_fee = has_fn(iface, "update-fees") or has_fn(iface, "propose-fee-bips") \
            or has_fn(iface, "set-fee-bips") or has_fn(iface, "set-fees")
        has_admin = has_fn(iface, "update-admin") or has_fn(iface, "set-admin") \
            or has_fn(iface, "add-admin")

        av, active = read_first(node, m, ivars, "active")
        pv, pending_bips = read_first(node, m, ivars, "pending_bips")
        cv, pending_cycle = read_first(node, m, ivars, "pending_cycle")
        ev, earned = read_first(node, m, ivars, "earned")

        eff, why = resolve_effective(m["activation"], active, pending_bips, pending_cycle, cycle)
        stale = eff is not None and active is not None and eff != active

        rec = {
            "activation_model": m["activation"],
            "fee_mutator_present": has_fee,
            "admin_mutator_present": has_admin,
            "active_var": av,
            "active_bips": active,
            "pending_bips": pending_bips,
            "pending_cycle": pending_cycle,
            "effective_bips": eff,
            "effective_rule": why,
            "active_var_is_stale": stale,
            "earned_fees_sats": earned,
        }
        snapshot["managers"][key] = rec

        if not args.json:
            print(f"  {m['label']}  ({key})")
            print(f"    activation={m['activation']}  update-fees={has_fee}  update-admin={has_admin}")
            if m["activation"] == "none" or (not has_fee and active is None):
                print("    no on-chain FEE surface — fee terms are off-chain and unverifiable here")
                print(f"    admin mutator present: {has_admin}")
            else:
                if eff is None:
                    print("    EFFECTIVE fee: not readable")
                else:
                    print(f"    EFFECTIVE fee: {eff} bips ({eff/100:.2f}%)   <- what a staker pays")
                if active is not None:
                    flag = "  !! STALE — reading this alone understates the fee" if stale else ""
                    print(f"    active var ({av}): {active} bips ({active/100:.2f}%){flag}")
                if pending_bips is not None:
                    pc = pending_cycle if pending_cycle is not None else "?"
                    print(f"    pending     : {pending_bips} bips ({pending_bips/100:.2f}%) @ cycle {pc}")
                print(f"    rule        : {why}")
            print()

    if args.json:
        print(json.dumps(snapshot, indent=2))
    else:
        print("# reproduce in Clarinet devnet console: see scripts/clarinet-console-commands.md")


if __name__ == "__main__":
    main()
