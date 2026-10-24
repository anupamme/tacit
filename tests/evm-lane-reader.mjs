#!/usr/bin/env node
// EVM-lane balance reader (task #6). Locks: inert until pool+address are set; reads the canonical-ERC20
// balance per resolver asset (via canonicalTokenFor → balanceOf) normalized to in-system base units;
// uses the resolver's known ERC20 address when present (skips the lookup); skips zero balances; and
// merges injected extra readers (confidential notes / tETH) without one failure sinking the rest.
//
// Run: node tests/evm-lane-reader.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { makeCrossChainAssets } from '../dapp/cross-chain-asset-resolver.js';
import { makeEvmLaneReader } from '../dapp/evm-lane-reader.js';

const keccak256 = (b) => keccak_256(b);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const sel = (sig) => '0x' + Buffer.from(keccak256(new TextEncoder().encode(sig))).slice(0, 4).toString('hex');
const CANON = sel('canonicalTokenFor(bytes32)'), BAL = sel('balanceOf(address)');
const word = (hex) => '0x' + hex.replace(/^0x/, '').padStart(64, '0');
const addrWord = (a) => word(a.replace(/^0x/, ''));

const POOL = '0x' + 'po'.replace('p', 'a').replace('o', 'b').padEnd(40, '0'); // 0xabb0... (any addr)
const EVM = '0x' + '11'.repeat(20);
const TAC = '0x' + 'aa'.repeat(32), tETH = '0x' + 'bb'.repeat(32);
const TAC_ERC20 = '0x' + 'ee'.repeat(20), tETH_ERC20 = '0x' + 'ff'.repeat(20);

const X = makeCrossChainAssets({ sha256 });
X.ingestBitcoin({ assetIdHex: TAC, ticker: 'TAC', decimals: 8 });
X.ingestEvm({ assetIdHex: TAC, ticker: 'TAC', decimals: 8, canonicalErc20: TAC_ERC20 }, 1); // ERC20 known → no lookup
X.ingestBitcoin({ assetIdHex: tETH, ticker: 'tETH', decimals: 8 });
X.ingestEvm({ assetIdHex: tETH, ticker: 'tETH', decimals: 8 }, 1);                          // ERC20 unknown → canonicalTokenFor

// mock ethCall: canonicalTokenFor(tETH) → tETH_ERC20; balanceOf(TAC_ERC20) → 30·1e18; balanceOf(tETH_ERC20) → 0
function makeEthCall(balances) {
  return async (to, data) => {
    if (data.startsWith(CANON)) {
      const id = '0x' + data.slice(CANON.length); // padded assetId
      if (id.endsWith('bb'.repeat(32))) return addrWord(tETH_ERC20);
      return word('0'); // unknown → zero address
    }
    if (data.startsWith(BAL)) return word((balances[to.toLowerCase()] ?? 0n).toString(16));
    return '0x';
  };
}

// ── 1. inert until configured ──
{
  assert.deepStrictEqual(await makeEvmLaneReader({}).readEvmLanes(), [], 'no config → empty');
  assert.deepStrictEqual(await makeEvmLaneReader({ ethCall: () => {}, keccak256, resolver: X, evmAddress: EVM, pool: null }).readEvmLanes(), [], 'no pool → empty');
  ok('the reader is inert (empty) until pool + evmAddress are set');
}

// ── 2. reads the canonical-ERC20 lane per asset, normalized to base units; skips zero ──
{
  const ethCall = makeEthCall({ [TAC_ERC20.toLowerCase()]: 30n * 10n ** 18n, [tETH_ERC20.toLowerCase()]: 0n });
  const r = makeEvmLaneReader({ ethCall, keccak256, resolver: X, evmAddress: EVM, pool: POOL });
  const lanes = await r.readEvmLanes();
  assert.strictEqual(lanes.length, 1, 'only the non-zero balance is returned (tETH was 0)');
  const tac = lanes.find((l) => l.assetId === TAC.replace(/^0x/, ''));
  assert.ok(tac, 'TAC canonical balance present');
  assert.strictEqual(tac.balance, 30n * 10n ** 8n, '30·1e18 ERC20 → 30·1e8 base units (÷ unitScale 1e10)');
  assert.strictEqual(tac.lane, 'ethereum', 'lane tagged ethereum');
  assert.strictEqual(tac.source, 'eth-canonical', 'source tagged');
  ok('reads the canonical-ERC20 balance per asset (known + looked-up ERC20), normalized; skips zero');
}

// ── 3. extra readers (confidential notes / tETH) merge in; a failing one is skipped ──
{
  const ethCall = makeEthCall({ [TAC_ERC20.toLowerCase()]: 10n * 10n ** 18n });
  const confidentialNotes = async () => [{ assetId: TAC.replace(/^0x/, ''), ticker: 'TAC', decimals: 8, balance: 7n * 10n ** 8n, source: 'eth-confidential', lane: 'ethereum' }];
  const broken = async () => { throw new Error('indexer down'); };
  const r = makeEvmLaneReader({ ethCall, keccak256, resolver: X, evmAddress: EVM, pool: POOL, extraReaders: [confidentialNotes, broken] });
  const lanes = await r.readEvmLanes();
  const sources = lanes.map((l) => l.source).sort();
  assert.deepStrictEqual(sources, ['eth-canonical', 'eth-confidential'], 'canonical + confidential merged; the broken reader is skipped');
  ok('extra readers merge in (confidential notes / tETH); a failing reader is skipped, not fatal');
}

// ── 4. external watch-tokens (USDC/USDT/wstETH) surface as display-only rows in token-native units ──
{
  const USDC = '0x' + 'cc'.repeat(20);
  const ethCall = makeEthCall({ [TAC_ERC20.toLowerCase()]: 0n, [USDC.toLowerCase()]: 1234560n }); // 1.23456 USDC (6-dec)
  const r = makeEvmLaneReader({ ethCall, keccak256, resolver: X, evmAddress: EVM, pool: POOL,
    externalErc20: [{ ticker: 'USDC', address: USDC, decimals: 6 }] });
  const lanes = await r.readEvmLanes();
  const usdc = lanes.find((l) => l.external);
  assert.ok(usdc, 'external USDC row present');
  assert.strictEqual(usdc.assetId, USDC.toLowerCase(), 'synthetic assetId = token address (never collides with a 32-byte tacit id)');
  assert.strictEqual(usdc.balance, 1234560n, 'balance stays in token-native base units (no unitScale division)');
  assert.strictEqual(usdc.external, true, 'flagged external so the merge keeps it standalone + out of portfolio totals');
  ok('external watch-tokens surface as display-only rows in token-native units');
}

// ── 5. a failed balance read is not a zero balance: the last one read stands in, marked stale ──
{
  const USDT = '0x' + 'dd'.repeat(20), EVM2 = '0x' + '22'.repeat(20);
  let down = false;
  const live = makeEthCall({ [USDT.toLowerCase()]: 5000000n });
  const ethCall = async (to, data) => { if (down && data.startsWith(BAL)) throw new Error('all Ethereum RPCs failed'); return live(to, data); };
  const reader = (evmAddress) => makeEvmLaneReader({ ethCall, keccak256, resolver: X, evmAddress, pool: POOL, externalErc20: [{ ticker: 'USDT', address: USDT, decimals: 6 }] });
  const first = (await reader(EVM2).readExternalErc20())[0];
  assert.strictEqual(first.balance, 5000000n);
  assert.strictEqual(first.stale, undefined, 'a fresh read is not marked stale');
  down = true;
  const again = (await reader(EVM2).readExternalErc20())[0];
  assert.ok(again, 'the row stays while every node is down');
  assert.strictEqual(again.balance, 5000000n, 'with the last balance read');
  assert.strictEqual(again.stale, true, 'marked stale');
  assert.deepStrictEqual(await reader('0x' + '33'.repeat(20)).readExternalErc20(), [], 'an address never read has no row, as before');
  down = false;
  assert.strictEqual((await reader(EVM2).readExternalErc20())[0].stale, undefined, 'the next good read replaces it');
  ok('a failed balance read keeps the last balance read, marked stale, instead of reading as zero');
}

console.log(`\n${n}/5 EVM-lane reader checks passed`);
