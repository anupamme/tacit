// worker/src/bridgemint-admit.js for a stealth bridge mint (OP_BRIDGE_STEALTH_MINT, a burn that pays someone else): admitted only when it is the
// mint of a recorded burn, to the stealth lock that burn pinned, built on the burn set the pool holds. The relay's own stealth kit is the
// small one the worker builds (no signing, no transfer), which must hash a lock exactly as the client's does.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { signSchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';
import { makeConfidentialAirdrop } from '../dapp/confidential-airdrop.js';
import { makeConfidentialBridgeMint, txidInternal } from '../dapp/confidential-bridge-mint.js';
import { admitBridgeStealthMint } from '../worker/src/bridgemint-admit.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const stealth = makeConfidentialStealth({ keccak256: keccak_256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer: ct });
const airdrop = makeConfidentialAirdrop({ stealth, secp, sha256, keccak256: keccak_256, curveOrder: SECP_N, pool, transfer: ct });
const bm = makeConfidentialBridgeMint({ pool, ct, stealth, airdrop });
const relayStealth = makeConfidentialStealth({ keccak256: keccak_256, secp, curveOrder: secp.CURVE.n, pool });

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const ASSET = '0x' + 'a5'.repeat(32), CHAIN_BINDING = '0x' + '7c'.repeat(32), AUTH_KEY = '0x' + '00'.repeat(31) + 'b7';
const SPENT_TXID = txidInternal('33'.repeat(31) + '44'), SPENT_VOUT = 1;
const LOCKER_SCAN_PRIV = hx(new Uint8Array(32).fill(0x11));
const RECIPIENT_PUB = hx(secp.getPublicKey(0x7e57c0ffee1234567n, true));
const DEADLINE = bm.stealthDeadline(1_760_000_000);

function mint(sourceClass, burnValue = 1_000_000n) {
  const owner = sourceClass === 0 ? pool.outpointKey(SPENT_TXID, SPENT_VOUT) : AUTH_KEY;       // a burn-deposit note is owned by its own outpoint
  const burned = { value: burnValue, blinding: randomScalar(), owner };
  const { cx, cy } = pool.commitXY(burned.value, burned.blinding);
  const srcLeaf = bm.sourceLeaf({ sourceClass, asset: ASSET, cx, cy, owner, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, chainBinding: CHAIN_BINDING });
  const sd = bm.stealthDestFor({ asset: ASSET, lockerScanPriv: LOCKER_SCAN_PRIV, nullifier: pool.nullifier(srcLeaf), recipientSpendPub: RECIPIENT_PUB, value: burnValue, deadline: DEADLINE });
  const burnId = pool.bridgeBurnId(sourceClass === 0 ? 2 : 1, SPENT_TXID, SPENT_VOUT, srcLeaf, CHAIN_BINDING);
  const burns = pool.makeUtxoAccumulator();
  burns.insert('0x' + '00'.repeat(31) + '07', '0x' + '00'.repeat(31) + '99');
  burns.insert(burnId, sd.lockLeaf);
  const snapshot = { noteLeaves: ['0x' + '01'.repeat(32), srcLeaf, '0x' + '03'.repeat(32)], burnNodes: burns.nodes() };
  const built = bm.buildBridgeStealthMintOp({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, sourceClass, burned, stealthDest: sd, snapshot });
  return { op: JSON.parse(JSON.stringify(built.op)), root: built.op.bitcoinBurnRoot, burnId: built.burnId };
}
const admit = (op, knownRoot) => admitBridgeStealthMint({ pool, stealth: relayStealth, op, knownRoot });

for (const cls of [0, 1, 2]) {
  test(`the stealth mint of a recorded burn (source class ${cls}) is admitted, with its burn id`, () => {
    const m = mint(cls);
    const r = admit(m.op, m.root);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.burnId.toLowerCase(), m.burnId.toLowerCase());
  });
}

test('a stealth mint built on an older burn set is turned back as stale, so the client rebuilds it', () => {
  const m = mint(2);
  const r = admit(m.op, '0x' + 'ab'.repeat(32));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'stale_root');
  assert.equal(r.status, 409);
});

test('a stealth mint to another lock than the burn pinned is refused (recipient, deadline, locker, commitment)', () => {
  const m = mint(2);
  for (const [k, v] of [['ownerPub', '0x' + 'dd'.repeat(32)], ['locker', '0x' + 'ee'.repeat(32)], ['deadline', m.op.deadline + 86400], ['lCx', '0x' + 'cc'.repeat(32)]]) {
    const r = admit({ ...m.op, [k]: v }, m.root);
    assert.equal(r.ok, false, k);
    assert.equal(r.code, 'not_a_burn', k);
  }
});

test('a stealth mint of a burn that is not recorded (another outpoint) is refused', () => {
  const m = mint(2);
  assert.equal(admit({ ...m.op, spentVout: SPENT_VOUT + 1 }, m.root).ok, false);
  assert.equal(admit({ ...m.op, spentTxid: txidInternal('44'.repeat(32)) }, m.root).ok, false);
});

test('junk of any shape is refused without throwing, as the free-settle abuse posted it', () => {
  const m = mint(2);
  for (const junk of [null, undefined, 'x', 7, {}, [], { ...m.op, bmPath: [] }, { ...m.op, bmPath: m.op.bmPath.map(() => 'zz') }, { ...m.op, inCx: 'nope' },
    { ...m.op, deadline: 'soon' }, { ...m.op, deadline: 0 }, { ...m.op, sourceClass: 9 }, { ...m.op, bitcoinBurnRoot: m.root, bmNext: '0x' + '00'.repeat(32), inOwner: '0x' + '00'.repeat(32) }]) {
    const r = admit(junk, m.root);
    assert.equal(r.ok, false, JSON.stringify(junk)?.slice(0, 80));
    assert.equal(r.code, 'not_a_burn');
  }
});

test('when the pool\'s root could not be read nothing is held back (a failed read never blocks a mint)', () => {
  const m = mint(2);
  assert.equal(admit(m.op, null).ok, true);
});
