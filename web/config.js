// BondWatch configuration — every address, manager and known cap lives here.
// No secrets. An optional Hiro API key is read at runtime from `?hiroKey=...`
// or `window.HIRO_API_KEY`; it is never stored in this file.

export const HIRO_BASE = 'https://api.hiro.so';
export const EXPLORER_BASE = 'https://explorer.hiro.so';
export const CHAIN = 'mainnet';

export const REFRESH_MS = 60_000;

// Repo links shown in the "why" section and footer.
export const REPO_URL = 'https://github.com/crackedstudio/bondwatch';
export const FINDINGS_URL = `${REPO_URL}/blob/main/FINDINGS.md`;
export const SIP_045_URL =
  'https://github.com/stacksgov/sips/blob/main/sips/sip-045/sip-045-pox-5-bitcoin-staking.md';

// Layer 1 — the protocol contract.
export const PROTOCOL = {
  address: 'SP000000000000000000002Q6VF78',
  name: 'pox-5',
  vars: {
    'bond-admin': 'principal',
    'pause-admin': 'principal',
    'rewards-paused': 'bool',
    'configured': 'bool',
    'reserve-balance': 'uint',
    'total-sbtc-staked': 'uint',
  },
};

export const SATS_PER_SBTC = 100_000_000n;
export const BIPS_DENOMINATOR = 10_000;

// Layer 2 — pool signer-manager contracts.
//
// `caps` are values verified from each contract's source (see FINDINGS.md /
// evidence/live-state.json). They are constants, not data vars, so they can't
// be read through /v2/data_var; when a manager has no entry here the monitor
// tries to parse them from /v2/contracts/source, and otherwise shows "not read".
//
// `feeVars` are the candidate data-var names to try. The monitor first fetches
// the interface and only reads names that actually exist, so a missing var is
// "not present", never an error.
export const MANAGERS = [
  {
    id: 'fastpool',
    name: 'Fast Pool',
    address: 'SPMPMA1V6P430M8C91QS1G9XJ95S59JS1TZFZ4Q4',
    contract: 'fastpool-max500-signer-manager',
    primary: true,
    caps: { maxFeeBips: 500, delayCycles: 2, bipsDenominator: 10_000 },
    feeVars: {
      active: ['fees-bips'],
      pendingBips: ['pending-fees-bips'],
      pendingCycle: ['pending-fees-cycle'],
      earned: ['earned-fees'],
    },
  },
  {
    id: 'xverse-1',
    name: 'Xverse',
    address: 'SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE',
    contract: 'xverse-signer-manager-1',
    primary: true,
    caps: { maxFeeBips: 10_000 }, // 100% — effectively uncapped
    feeVars: { active: ['fees-bips'], earned: ['earned-fees'] },
  },
  {
    id: 'native',
    name: 'Native Pool',
    address: 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG',
    contract: 'native-pool-signer-manager',
    primary: true,
    caps: null,
    feeVars: { active: ['fees-bips', 'fee-bips'] },
    note: 'Exposes no fee or admin surface on-chain — fee terms are set off-chain and cannot be verified here.',
  },
  // Best-effort: detected dynamically from each interface.
  {
    id: 'xverse-2',
    name: 'Xverse (manager 2)',
    address: 'SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE',
    contract: 'xverse-signer-manager-2',
    caps: { maxFeeBips: 10_000 },
    feeVars: { active: ['fees-bips'], earned: ['earned-fees'] },
  },
  {
    id: 'xverse-3',
    name: 'Xverse (manager 3)',
    address: 'SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE',
    contract: 'xverse-signer-manager-3',
    caps: { maxFeeBips: 10_000 },
    feeVars: { active: ['fees-bips'], earned: ['earned-fees'] },
  },
  {
    id: 'juice',
    name: 'Juice Pool',
    address: 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22',
    contract: 'juice-pool-stx-signer',
    caps: null, // parsed from source at runtime (MAX_FEE_BIPS / FEE_COOLDOWN)
    feeVars: {
      active: ['fees-bips', 'fee-bips'],
      pendingBips: ['pending-fees-bips', 'pending-fee'],
      pendingCycle: ['pending-fees-cycle', 'pending-fee-height'],
      earned: ['earned-fees'],
      paused: ['paused'],
    },
  },
  {
    id: 'planbetter',
    name: 'PlanBetter',
    address: 'SP3ZA8J49HPS7M3KD7EB01Y0ZAJS7VJS2NG87MDGN',
    contract: 'planbetter-signer-manager',
    caps: null,
    feeVars: { active: ['fees-bips', 'fee-bips'], earned: ['earned-fees'] },
  },
];

// Function names that mean "the operator can change the fee" / "…the admin set".
// `update-fees` / `update-admin` are the reference names; the others are
// variants seen on deployed managers (e.g. Juice's propose/confirm flow).
export const FEE_MUTATORS = ['update-fees', 'propose-fee-bips', 'confirm-fee-bips', 'set-fee-bips', 'set-fees'];
export const ADMIN_MUTATORS = ['update-admin', 'set-admin', 'add-admin', 'remove-admin'];

// Constant names to look for when parsing caps out of contract source.
export const CAP_CONSTANTS = {
  maxFeeBips: ['MAX_FEE_BIPS', 'MAX_BIPS'],
  delayCycles: ['FEE_ACTIVATION_DELAY_CYCLES'],
  delayBlocks: ['FEE_COOLDOWN'],
  bipsDenominator: ['BIPS_DENOMINATOR'],
};
