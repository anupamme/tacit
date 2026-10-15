// What the splitter page says to the EthSplitter contract and how it reads the answers: the calldata of each call, the arguments of the
// deploy, the way the contract rounds a payout (so the page can show what a distribute will send before anyone sends it), and the
// batch file a Safe imports. No network, no wallet, no storage: the page's app.js does those, and tests/splitter-abi.test.mjs checks
// every encoding here against `cast`.

export const MAX_RECIPIENTS = 8;
export const MAX_WEIGHT = (1n << 96n) - 1n;

// Selectors and the two event topics, from `cast sig` / `cast keccak` on the contract's own signatures.
export const SEL = {
  distribute: '0xe4fc6b6d',
  shares: '0x03314efa',
  owner: '0x8da5cb5b',
  setShares: '0xc8389ce5',
};
export const TOPIC = {
  distributed: '0xddc9c30275a04c48091f24199f9c405765de34d979d6847f5b9798a57232d2e5',
  sharesSet: '0x20661c596feeaaef9e2b07e035dbaf255f70dd45d2527c319788279a662af1e5',
};

const strip = (h) => String(h).replace(/^0x/i, '');
export const word = (v) => BigInt(v).toString(16).padStart(64, '0');
export const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '')) && !/^0x0{40}$/.test(a);
const sameAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// A list of recipients and weights as the contract takes it: addresses and whole numbers from 1 to 2^96 - 1, one to eight of them,
// none of them the zero address or the splitter itself. Returns the first problem in words, or null.
export function sharesProblem(to, weight, self = null) {
  if (!Array.isArray(to) || !Array.isArray(weight) || to.length !== weight.length) return 'Each wallet needs a weight.';
  if (!to.length) return 'Add at least one wallet.';
  if (to.length > MAX_RECIPIENTS) return `At most ${MAX_RECIPIENTS} wallets.`;
  for (let i = 0; i < to.length; i++) {
    if (!isAddress(to[i])) return `Wallet ${i + 1} is not an address.`;
    if (self && sameAddr(to[i], self)) return `Wallet ${i + 1} is the splitter itself.`;
    let w;
    try { w = BigInt(weight[i]); } catch { return `The weight of wallet ${i + 1} is not a whole number.`; }
    if (w <= 0n || w > MAX_WEIGHT) return `The weight of wallet ${i + 1} must be a whole number above zero.`;
  }
  return null;
}

// address[] then uint96[], each as a length and its words (the body that follows the two offsets).
function arrays(to, weight, base) {
  const a = word(to.length) + to.map(addrWord).join(''), w = word(weight.length) + weight.map(word).join('');
  return { head: word(base) + word(base + a.length / 2), tail: a + w };
}

export function encSetShares(to, weight) {
  const { head, tail } = arrays(to, weight, 64);
  return SEL.setShares + head + tail;
}
export const encDistribute = () => SEL.distribute;

// constructor(address owner_, address[] to, uint96[] weight): the arguments a deploy appends to the creation code.
export function encDeployArgs(owner, to, weight) {
  const { head, tail } = arrays(to, weight, 96);
  return addrWord(owner) + head + tail;
}
export const deployData = (initcode, owner, to, weight) => '0x' + strip(initcode) + encDeployArgs(owner, to, weight);

// The two arrays shares() returns, and the owner() word.
export function decodeShares(hex) {
  const d = strip(hex), at = (i) => BigInt('0x' + d.slice(i * 64, (i + 1) * 64));
  const offA = Number(at(0)) / 32, offW = Number(at(1)) / 32, n = Number(at(offA)), m = Number(at(offW));
  if (n !== m || n > MAX_RECIPIENTS) throw new Error('splitter: unreadable shares');
  const to = [], weight = [];
  for (let i = 0; i < n; i++) {
    to.push('0x' + d.slice((offA + 1 + i) * 64 + 24, (offA + 2 + i) * 64));
    weight.push(at(offW + 1 + i));
  }
  return { to, weight };
}
export const decodeAddress = (hex) => '0x' + strip(hex).slice(24, 64);

// What distribute() sends, to the wei: each of the first n-1 gets balance * weight / total rounded down, the last gets what is left.
export function payouts(balance, weight) {
  const b = BigInt(balance), ws = weight.map(BigInt), total = ws.reduce((x, y) => x + y, 0n);
  if (!ws.length || total === 0n) return [];
  const out = [];
  let left = b;
  for (let i = 0; i < ws.length - 1; i++) { const p = b * ws[i] / total; out.push(p); left -= p; }
  out.push(left);
  return out;
}

// A weight as a share of the total, in percent with up to two decimals ("70", "33.33").
export function percent(weight, i) {
  const ws = weight.map(BigInt), total = ws.reduce((x, y) => x + y, 0n);
  if (total === 0n) return '0';
  const bp = ws[i] * 10000n / total, whole = bp / 100n, frac = bp % 100n;
  return frac === 0n ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

// ETH from wei, trimmed: "0.00021", "1.5", "0".
export function fmtEth(wei, dp = 6) {
  const v = BigInt(wei), base = 10n ** 18n, whole = v / base, frac = (v % base).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

// Safe's Transaction Builder import file: the calls as raw calldata, in order, to one contract.
export function safeBatch({ chainId = 1, to, name, calls }) {
  return {
    version: '1.0', chainId: String(chainId), createdAt: 0,
    meta: { name, description: 'Created on the tacit splitter page', txBuilderVersion: '1.17.0' },
    transactions: calls.map((data) => ({ to, value: '0', data, contractMethod: null, contractInputsValues: null })),
  };
}
