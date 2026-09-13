#!/usr/bin/env python3
"""
read_bond_state.py — prove you can read pox-5 bond state programmatically.

Reads the DEPLOYED mainnet pox-5 contract and any pool signer-manager
contract straight off a Stacks node (no wallet, no privileged access),
and decodes the serialized Clarity values into human-readable state.

This is the "prove you can read bond state" artifact. It talks to a public
node API; the exact same reads are reproducible in the Clarinet devnet console
(see scripts/clarinet-console-commands.md) against the pox-5 snapshot.

Usage:
    python3 read_bond_state.py
    python3 read_bond_state.py --node https://api.hiro.so

No dependencies beyond the Python 3 standard library.
"""
import argparse, hashlib, json, urllib.request

POX5 = ("SP000000000000000000002Q6VF78", "pox-5")

# Pool signer-managers observed calling into pox-5 on mainnet (item 4).
MANAGERS = [
    ("SPMPMA1V6P430M8C91QS1G9XJ95S59JS1TZFZ4Q4", "fastpool-max500-signer-manager"),
    ("SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE", "xverse-signer-manager-1"),
    ("SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG", "native-pool-signer-manager"),
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
def get_data_var(node, addr, name, var):
    url = f"{node}/v2/data_var/{addr}/{name}/{var}?proof=0"
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.load(r)["data"]


def get_interface(node, addr, name):
    url = f"{node}/v2/contracts/interface/{addr}/{name}"
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.load(r)


def has_fn(iface, fn):
    return any(f["name"] == fn for f in iface.get("functions", []))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default="https://api.hiro.so")
    args = ap.parse_args()
    node = args.node.rstrip("/")
    addr, name = POX5

    print(f"# pox-5 protocol state  ({addr}.{name})  via {node}\n")
    bond_admin = decode_principal(get_data_var(node, addr, name, "bond-admin"))
    pause_admin = decode_principal(get_data_var(node, addr, name, "pause-admin"))
    paused = decode_bool(get_data_var(node, addr, name, "rewards-paused"))
    reserve = decode_uint(get_data_var(node, addr, name, "reserve-balance"))
    staked = decode_uint(get_data_var(node, addr, name, "total-sbtc-staked"))
    print(f"  bond-admin        : {bond_admin}")
    print(f"  pause-admin       : {pause_admin}")
    if bond_admin == pause_admin:
        print("    !! one principal holds BOTH roles (can rotate admin AND permanently pause)")
    print(f"  rewards-paused    : {paused}"
          + ("   !! IRREVERSIBLE ONCE TRUE — no unpause path in the contract" if paused else ""))
    print(f"  reserve-balance   : {reserve} sats ({reserve/1e8:.8f} sBTC)")
    print(f"  total-sbtc-staked : {staked} sats ({staked/1e8:.8f} sBTC)")

    print("\n# pool signer-managers — fee/admin surface (item 4: they DIVERGE)\n")
    for maddr, mname in MANAGERS:
        try:
            iface = get_interface(node, maddr, mname)
        except Exception as e:
            print(f"  {mname}: interface unavailable ({e})"); continue
        has_fee = has_fn(iface, "update-fees")
        has_admin = has_fn(iface, "update-admin")
        print(f"  {maddr}.{mname}")
        print(f"    update-fees={has_fee}  update-admin={has_admin}")
        if has_fee:
            try:
                active = decode_uint(get_data_var(node, maddr, mname, "fees-bips"))
                print(f"    active fee : {active} bips ({active/100:.2f}%)")
            except Exception:
                pass
            # Fast Pool telegraphs a pending fee; most managers do not.
            try:
                pend = decode_uint(get_data_var(node, maddr, mname, "pending-fees-bips"))
                pcyc = decode_uint(get_data_var(node, maddr, mname, "pending-fees-cycle"))
                print(f"    PENDING fee: {pend} bips ({pend/100:.2f}%) activating at cycle {pcyc}"
                      "  <- invisible if you only read the active fee")
            except Exception:
                pass
        else:
            print("    no on-chain fee/admin surface to monitor here")
    print("\n# reproduce in Clarinet devnet console: see scripts/clarinet-console-commands.md")


if __name__ == "__main__":
    main()
