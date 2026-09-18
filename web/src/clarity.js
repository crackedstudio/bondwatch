// Clarity value decoders for the hex returned by /v2/data_var.
//
// Wire format (first byte = type tag):
//   0x01 uint        + 16-byte big-endian value
//   0x03 true / 0x04 false
//   0x05 standard principal + 1 version byte + 20-byte hash160
//   0x09 none / 0x0a some(inner)
//
// The c32 encoder below is the verified one from scripts/read_bond_state.py,
// ported to JS. `selfTest()` must pass on load: version 22 + 20 zero bytes
// encodes to the boot address SP000000000000000000002Q6VF78.

const C32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HEXA = '0123456789abcdef';

function c32encode(hexInput) {
  let hex = hexInput.length % 2 ? '0' + hexInput : hexInput;
  hex = hex.toLowerCase();
  const res = [];
  let carry = 0;
  for (let i = hex.length - 1; i >= 0; i--) {
    if (carry < 4) {
      const cur = HEXA.indexOf(hex[i]) >> carry;
      const nxt = i ? HEXA.indexOf(hex[i - 1]) : 0;
      const bits = 1 + carry;
      const low = (nxt % (1 << bits)) << (5 - bits);
      res.unshift(C32[cur + low]);
      carry = bits;
    } else carry = 0;
  }
  let lead = 0;
  for (const ch of res) { if (ch === '0') lead++; else break; }
  res.splice(0, lead);
  let nz = 0, i = 0;
  while (i + 1 < hex.length && hex.substr(i, 2) === '00') { nz++; i += 2; }
  for (let k = 0; k < nz; k++) res.unshift('0');
  return res.join('');
}

function hexToBytes(h) {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}
function bytesToHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
async function c32checkEncode(version, dataHex) {
  const data = new Uint8Array([version, ...hexToBytes(dataHex)]);
  const ck = (await sha256(await sha256(data))).slice(0, 4);
  return C32[version] + c32encode(dataHex + bytesToHex(ck));
}

const strip = (hex) => (hex.startsWith('0x') ? hex.slice(2) : hex);

/** 0x05 + version + hash160 -> "SP…" / "SM…" c32check address. */
export async function decodePrincipal(hex) {
  hex = strip(hex);
  if (hex.slice(0, 2) !== '05') throw new Error(`not a standard principal (tag ${hex.slice(0, 2)})`);
  const version = parseInt(hex.slice(2, 4), 16);
  return 'S' + (await c32checkEncode(version, hex.slice(4, 44)));
}

/** 0x03 -> true, 0x04 -> false. */
export function decodeBool(hex) {
  hex = strip(hex);
  const tag = hex.slice(0, 2);
  if (tag !== '03' && tag !== '04') throw new Error(`not a bool (tag ${tag})`);
  return tag === '03';
}

/** 0x01 + 16 bytes -> BigInt. */
export function decodeUint(hex) {
  hex = strip(hex);
  if (hex.slice(0, 2) !== '01') throw new Error(`not a uint (tag ${hex.slice(0, 2)})`);
  return BigInt('0x' + hex.slice(2));
}

/** 0x09 -> null, 0x0a + uint -> BigInt. */
export function decodeOptionalUint(hex) {
  hex = strip(hex);
  const tag = hex.slice(0, 2);
  if (tag === '09') return null;
  if (tag === '0a') return decodeUint(hex.slice(2));
  throw new Error(`not an optional (tag ${tag})`);
}

/** Pick a decoder from a Clarity type as the contract interface reports it. */
export function decoderFor(type) {
  if (type === 'uint128' || type === 'uint') return decodeUint;
  if (type === 'bool') return decodeBool;
  if (type === 'principal') return decodePrincipal;
  if (type && typeof type === 'object' && 'optional' in type) {
    const inner = type.optional;
    if (inner === 'uint128' || inner === 'uint') return decodeOptionalUint;
  }
  return null;
}

/** Asserted on load: the c32 encoder must reproduce the pox boot address. */
export async function selfTest() {
  const expected = 'SP000000000000000000002Q6VF78';
  const got = await decodePrincipal('0x0516' + '00'.repeat(20));
  if (got !== expected) throw new Error(`c32 self-test failed: got ${got}, expected ${expected}`);
  if (decodeBool('0x03') !== true || decodeBool('0x04') !== false) throw new Error('bool self-test failed');
  if (decodeUint('0x01000000000000000000000000000001c2') !== 450n) throw new Error('uint self-test failed');
  if (decodeOptionalUint('0x09') !== null) throw new Error('optional self-test failed');
  return true;
}
