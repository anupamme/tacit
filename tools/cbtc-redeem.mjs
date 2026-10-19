// Redeems a cBTC lock (T_CBTC_REDEEM): burns cBTC notes held on this key's Bitcoin address and unlocks the lock's BTC, using
// dapp/cbtc-redeem.js. Read-only by default: it reads Bitcoin and Ethereum, builds and checks both transactions, writes them to
// OUT_FILE and prints the plan. It broadcasts only with --broadcast, commit then reveal.
//
// Needs: the lock (confirmed, unspent, this key's); cBTC notes on Bitcoin at this key's Taproot address, confirmed and credited,
// summing to exactly the lock's sats (a cross-out lands the note less the relay fee, so bridge lock sats plus the fee); and a
// little plain bitcoin at the key's P2WPKH address for both fees.
//
// Env: WALLET_JSON={ "priv_hex": "0x.." }  LOCK=<txid>:<vout>  [FEE_RATE=sat/vB]  [FUNDING=<txid>:<vout>:<sats>,..]
//      [OUT_FILE=path]  [FORCE_UNMINTED=1]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realFetch = globalThis.fetch, realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
await import(pathToFileURL(resolve(ROOT, 'tests/_domshim.mjs')).href);   // tacit.js touches document/localStorage at load
globalThis.fetch = realFetch; globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;
const load = (p) => import(pathToFileURL(resolve(ROOT, p)).href);

const { secp, hmac, sha256, keccak_256 } = await load('dapp/vendor/tacit-deps.min.js');
if (!secp.etc.hmacSha256Sync) secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const d = await load('dapp/tacit.js');
const { makeConfidentialPoolUx } = await load('dapp/confidential-pool-ux.js');
const { makeBtcWallet } = await load('dapp/bitcoin-taproot-wallet.js');
const { makeCbtcRedeem, CBTC_ZK_ASSET_ID } = await load('dapp/cbtc-redeem.js');

const BROADCAST = process.argv.includes('--broadcast');
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(2); } return v; };
const fail = (m, code = 3) => { console.error(`\nSTOPPED: ${m}\nNothing was broadcast.`); process.exit(code); };
const stripHex = (h) => String(h).replace(/^0x/, '');
const OUT_FILE = process.env.OUT_FILE || './cbtc-redeem-txs.json';

const [lockTxid, lockVoutS] = need('LOCK').split(':');
const lockVout = Number(lockVoutS);
if (!/^[0-9a-fA-F]{64}$/.test(lockTxid) || !Number.isInteger(lockVout)) fail('LOCK must be <64-hex txid>:<vout>', 2);
const priv = d.hexToBytes(stripHex(JSON.parse(readFileSync(need('WALLET_JSON'), 'utf8')).priv_hex));
d.wallet.priv = priv; d.wallet.pub = secp.getPublicKey(priv, true);
await d.ensurePrivkey();

// ---- Bitcoin reads (public esplora mirrors, rotated) ----
const BASES = ['https://mempool.space/api', 'https://blockstream.info/api'];
async function esplora(path, opts) {
  let err;
  for (let a = 0; a < 6; a++) {
    try { const r = await realFetch(BASES[a % BASES.length] + path, { ...opts, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`); return r; }
    catch (e) { err = e; await new Promise((res) => realST(res, 400 * (a + 1))); }
  }
  throw err;
}
const ejson = async (p) => (await esplora(p)).json();
const feeRate = Number(process.env.FEE_RATE) || (await ejson('/v1/fees/recommended').then((f) => f.fastestFee).catch(() => 0)) || 5;
const { prims, wallet } = makeBtcWallet({
  priv, hrp: 'bc', fetchUtxos: (a) => ejson(`/address/${a}/utxo`),
  broadcastTx: async (hex) => (await esplora('/tx', { method: 'POST', body: hex })).text(), fetchFeeRate: async () => feeRate,
});

// ---- Ethereum reads (the pool's own record of the lock) ----
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256 });
const pool = ux.pool;
const R = makeCbtcRedeem({ pool, secp, sha256, prims });
const selector = (sig) => Array.from(keccak_256(new TextEncoder().encode(sig)).slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('');

console.log(`key        ${wallet.address()}  (x-only ${d.bytesToHex(wallet.xonly())})`);
console.log(`lock       ${lockTxid}:${lockVout}`);
const ltx = await ejson(`/tx/${lockTxid}`);
const lo = ltx.vout?.[lockVout];
if (!lo) fail('that transaction has no such output');
if (!ltx.status?.confirmed) fail('the lock transaction is not confirmed yet');
const lock = { txid: lockTxid.toLowerCase(), vout: lockVout, value: lo.value, spk: lo.scriptpubkey };
console.log(`           ${lock.value} sats at ${lo.scriptpubkey_address || lo.scriptpubkey}`);

const lockState = await ux.cbtcLockState(lockTxid, lockVout);
const mintedRaw = lockState.vBtc > 0n ? await ux.ethCall(ux.cfg.pool, '0x' + selector('cbtcMinted(bytes32)') + stripHex(lockState.outpoint)) : '0x0';
lockState.minted = BigInt(mintedRaw && mintedRaw !== '0x' ? mintedRaw : '0x0') !== 0n;
console.log(`pool       records ${lockState.vBtc} sats · minted ${lockState.minted} · spent ${lockState.spent} · redeemed ${lockState.redeemed}`);

// ---- the cBTC notes this key holds on Bitcoin ----
console.log('notes      looking for cBTC at this key\'s Taproot address…');
const found = await d.crossoutNotes().discover({ walletPriv: priv, assetIds: [CBTC_ZK_ASSET_ID] });
if (found.unread) console.log(`           (${found.unread} output(s) could not be read; the list may be incomplete)`);
for (const n of found) console.log(`           ${n.txid.slice(0, 12)}…:${n.vout}  ${n.amount == null ? `amount not opened (${n.openErr || '?'})` : `${n.amount} sats`}  confirmed ${n.confirmed}  credited ${n.credited}`);

// ---- can this go ahead? ----
const outspent = async (txid, vout) => (await ejson(`/tx/${txid}/outspend/${vout}`)).spent === true;
const chosen = R.pickNotes(found, lockState.vBtc || BigInt(lock.value));
const verdict = R.assessRedeem({
  lock, lockState, notes: chosen || [], force: process.env.FORCE_UNMINTED === '1',
  unspent: { lock: !(await outspent(lock.txid, lock.vout)), notes: chosen ? await Promise.all(chosen.map(async (n) => !(await outspent(n.txid, n.vout)))) : [] },
});
if (!verdict.ok) fail(verdict.problems.join('\n  · '));
if (!chosen) {
  const have = found.filter((n) => n.amount != null).reduce((s, n) => s + BigInt(n.amount), 0n);
  fail(`no cBTC notes on Bitcoin add up to exactly ${lock.value} sats (credited and confirmed ones hold ${have} in total).\n`
    + `  Bridge cBTC to Bitcoin so that the note that arrives is exactly ${lock.value} sats; the cross-out's relay fee comes out of the note, so send ${lock.value} plus that fee.`);
}
console.log(`burn       ${chosen.length} note(s) = ${chosen.reduce((s, n) => s + BigInt(n.amount), 0n)} sats`);

// ---- fee funding: this key's safe plain utxos (Tacit's own classifier keeps notes and live locks out) ----
let funding;
if (process.env.FUNDING) {
  funding = process.env.FUNDING.split(',').map((s) => { const [txid, vout, value] = s.split(':'); return { txid, vout: Number(vout), value: Number(value) }; });
} else {
  const all = await d.getUtxos(wallet.address(), null, { forSpend: true });
  funding = (await d.pickSafeCommitSats(all)).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
}

const built = R.buildRedeemTxs({ prims, lock, notes: chosen, funding, feeRate, expectedVBtc: lockState.vBtc });
console.log(`\nBUILT      ${built.lockKind} lock · ${built.notes} note(s) · ${feeRate} sat/vB`);
console.log(`           fees ${built.commitFee} (commit, ${built.commitVb} vB) + ${built.revealFee} (reveal, ${built.revealVb} vB)`);
console.log(`           you receive ${built.outputSats} sats at ${wallet.address()}`);
console.log(`           commit ${built.commitTxid}\n           reveal ${built.revealTxid}`);
for (const c of built.checks) console.log(`           ✓ ${c}`);
writeFileSync(OUT_FILE, JSON.stringify({ commitHex: built.commitHex, commitTxid: built.commitTxid, revealHex: built.revealHex, revealTxid: built.revealTxid, envelopeScriptHex: built.envelopeScriptHex, commitValue: built.commitValue, lock, notes: chosen.map((n) => ({ txid: n.txid, vout: n.vout, sats: n.sats, amount: String(n.amount) })) }, null, 1));
console.log(`WROTE      ${OUT_FILE}`);

if (!BROADCAST) {
  console.log('\nNOT broadcast. This burns the notes and unlocks the lock for good; to send it, run again with --broadcast.');
  process.exit(0);
}
console.log('\nBROADCASTING (commit, then reveal)…');
const out = await R.send({
  built, broadcast: prims.broadcast, broadcastWithRetry: prims.broadcastWithRetry,
  isUnspent: async (txid, vout) => !(await outspent(txid, vout)), onProgress: (s) => console.log(`  ${s}`),
});
console.log(`SENT       commit ${out.commitTxid}\n           reveal ${out.revealTxid}`);
console.log('The reflection folds it in the block that confirms it; the lock then reads redeemed and the bond can be taken back.');
process.exit(0);
