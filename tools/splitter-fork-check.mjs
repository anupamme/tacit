// Runs the exact creation code the splitter page deploys against a fork of mainnet: the real wrap tip forwarder sends a tip to the new splitter,
// distribute() pays the real TacBuyback (which must accept plain ETH), the ops multisig changes the list and the old list can no longer be
// changed by anyone else. Nothing is sent to a live network: anvil forks it in memory.
//
//   node tools/splitter-fork-check.mjs [fork-rpc-url]     (default https://ethereum-rpc.publicnode.com)

import { spawn, execFileSync } from 'node:child_process';
import { SPLITTER_INITCODE } from '../dapp/splitter/bytecode.js';
import { deployData, encDistribute, encSetShares, decodeShares, decodeAddress, SEL, payouts } from '../dapp/splitter/abi.js';

const FORK = process.argv[2] || 'https://ethereum-rpc.publicnode.com';
const PORT = 28000 + Math.floor(Math.random() * 1000);
const OPS = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', DEPLOYER = '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7', SETTLE = '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331', BUYBACK = '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250';
const FORWARDER = '0x000000D218B03db5837943b0b05DeA2965AE956e', ANVIL0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', STRANGER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const E = 10n ** 18n, lc = (a) => a.toLowerCase();
let fails = 0;
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };

const anvil = spawn('anvil', ['--fork-url', FORK, '--port', String(PORT), '--silent', '--chain-id', '1'], { stdio: 'ignore' });
const rpc = async (method, params = []) => { const j = await (await fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data }); return j.result; };
for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
const bal = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const send = async (tx) => { const h = await rpc('eth_sendTransaction', [tx]); const r = await rpc('eth_getTransactionReceipt', [h]); if (r.status !== '0x1') throw new Error('tx failed ' + h); return r; };
const hex = (v) => '0x' + BigInt(v).toString(16);

try {
  // ── deploy, as the page does: a wallet sends the creation code and the constructor arguments, owner = the ops multisig ──
  const data = deployData(SPLITTER_INITCODE, OPS, [DEPLOYER, SETTLE, BUYBACK], [63n, 27n, 10n]);
  const dep = await send({ from: ANVIL0, data });
  const splitter = dep.contractAddress;
  ok(/^0x[0-9a-f]{40}$/.test(splitter), `deployed at ${splitter} for ${parseInt(dep.gasUsed, 16).toLocaleString()} gas`);
  ok(lc(decodeAddress(await rpc('eth_call', [{ to: splitter, data: SEL.owner }, 'latest']))) === lc(OPS), 'the owner is the ops multisig, not the wallet that deployed it');
  const sh = decodeShares(await rpc('eth_call', [{ to: splitter, data: SEL.shares }, 'latest']));
  ok(sh.to.map(lc).join() === [DEPLOYER, SETTLE, BUYBACK].map(lc).join() && sh.weight.join() === '63,27,10', 'it starts at 63 / 27 / 10: deployer wallet, settle wallet, TAC buyback');

  // ── a real wrap tip, through the real forwarder, to the splitter ──
  const poolWrap = '0x' + 'ab'.repeat(32), tip = 3n * E / 10000n, amount = E / 100n;
  const sig = execFileSync('cast', ['calldata', 'wrapWithTip(bytes32,uint256,address)', poolWrap, String(amount), splitter], { encoding: 'utf8' }).trim();
  await send({ from: ANVIL0, to: FORWARDER, data: sig, value: hex(amount + tip) });
  ok((await bal(splitter)) === tip, `the real WrapTipForwarder sent the 0.0003 ETH tip to the splitter, and it is held there (${Number(tip) / 1e18} ETH)`);

  // ── anyone can send it on; the real TacBuyback takes plain ETH ──
  const before = { d: await bal(DEPLOYER), s: await bal(SETTLE), b: await bal(BUYBACK) };
  const sent = await send({ from: STRANGER, to: splitter, data: encDistribute() });
  const [pd, ps, pb] = payouts(tip, [63n, 27n, 10n]);
  ok((await bal(DEPLOYER)) - before.d === pd && (await bal(SETTLE)) - before.s === ps && (await bal(BUYBACK)) - before.b === pb && (await bal(splitter)) === 0n, `a stranger sent it on for ${parseInt(sent.gasUsed, 16).toLocaleString()} gas: ${Number(pd) / 1e18} / ${Number(ps) / 1e18} / ${Number(pb) / 1e18} ETH to the deployer wallet, settle wallet and the real TacBuyback, nothing left`);

  // ── only the owner can change the list ──
  let refused = false;
  try { await send({ from: STRANGER, to: splitter, data: encSetShares([STRANGER], [1n]) }); } catch { refused = true; }
  ok(refused, 'a stranger cannot change who is paid');
  await rpc('anvil_impersonateAccount', [OPS]); await rpc('anvil_setBalance', [OPS, hex(10n * E)]);
  await send({ from: OPS, to: splitter, data: encSetShares([DEPLOYER, SETTLE], [70n, 30n]) });
  const sh2 = decodeShares(await rpc('eth_call', [{ to: splitter, data: SEL.shares }, 'latest']));
  ok(sh2.to.length === 2 && sh2.weight.join() === '70,30', 'the ops multisig changed it to 70 / 30 between the two wallets, dropping the buyback');
  await send({ from: ANVIL0, to: splitter, value: hex(E) });
  const b2 = { d: await bal(DEPLOYER), s: await bal(SETTLE) };
  await send({ from: STRANGER, to: splitter, data: encDistribute() });
  ok((await bal(DEPLOYER)) - b2.d === 7n * E / 10n && (await bal(SETTLE)) - b2.s === 3n * E / 10n, 'and the next 1 ETH went 0.7 / 0.3');
  await send({ from: OPS, to: splitter, data: encSetShares([DEPLOYER, SETTLE, BUYBACK], [63n, 27n, 10n]) });
  ok(decodeShares(await rpc('eth_call', [{ to: splitter, data: SEL.shares }, 'latest'])).weight.join() === '63,27,10', 'and back again: beneficiaries and weights are the owner\'s to set whenever');
} catch (e) { fails++; console.log('FAIL', e.message.split('\n')[0]); }
finally { anvil.kill(); }
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
