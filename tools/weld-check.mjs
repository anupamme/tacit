// Checks dapp/index.html (the front page, formerly /weld/) in a real browser against an anvil fork of Ethereum: public RPC hosts are routed to
// the fork and window.ethereum is an EIP-1193 stub that sends as the chosen account (anvil's first key, or an
// impersonated one). The relay's submit and the EVM-pool keepers are stubbed, so nothing reaches a live service.
//   airdrop  a listed recipient claims its TAC; the tile updates
//   links    friendly links open the right sheet and tab (#swap, #points, #earn), the address bar follows the tab, and
//            every sheet has a copy-link button
//   ux       the page's shell: a toast over an open sheet can be pressed, a drag ending on the backdrop leaves the sheet open, an
//            unreadable amount says so, one sheet replacing another keeps its link in the address bar, a hash naming nothing is ignored
//   apr      every farm row shows its APR now, and the public farm's card spells it out; the Farm tile leads with the public farm's APR
//   farmgate nobody connected: the public farm offers a browser wallet or, in place, the ways into a Tacit wallet, and back
//   farmpos  a private farm's card with positions: each named and leading the card, unbond held back while a real reward is
//            unharvested, harvested rewards and unbonded liquidity above the farms, a harvest pointing at its next step
//   farmsteps joining a private farm with tETH but no TAC opens on tETH alone; both sides says where TAC is made (with a way back
//            to the farm) or to farm with tETH alone
//   hxbal   the card's balance line and Max, the picker's balances, and what Your Tacit and the header say it is all worth
//   hxborrow the card's Borrow tab with a key open: the lock it follows step by step with what the key holds, and the bond posted from
//           the card with wstETH already held (a permit and the post in one transaction), after which the lock waits to mint
//   hxborrowback a return visit with a bond still on its way (in Activity): the Borrow tab says so in place of its button, and the
//           dashboard's cBTC opens that tab
//   hxteth  a key holding private tETH: Shield says so with Send, Swap and Back to ETH a press away; Back to ETH and Send quote their relay
//           fees as their forms will (Max keeping the fee that combines notes), and each hands its form the amount
//   hxsend  the card's Send for every asset it offers: tETH, TAC, cUSD and cBTC quoted in their own ticker, each opening its form with the amount and the
//           recipient; TAC and BTC on Bitcoin carried into Pay's link; a key with only cUSD opens on it; none of the chosen asset says so; a #card=send link
//   farmcoming a private farm opened while a wrap is settling says the tETH is on its way instead of asking for it again
//   farmzap  one side alone farms: Max takes the whole balance, the quote says what is swapped and what both sides add, and the
//            press cuts the swap note, swaps it in the farm's pool, cuts what pairs with the return and bonds both
//   farmmarket a private pool priced far from the market says so on its card; tETH alone shows its cost against the market and waits for it to be accepted
//   hxearntac the card's Earn tab takes a wallet's TAC (the public pool, the form's TAC tab) and private TAC (the pool that pairs it), each with its amount
//   farmcusd  private cUSD held: the Borrow sheet offers to farm it, which opens the cUSD pool on its own side; selling cUSD into a pool that prices it dear shows no cost against the market
//   farmqueue a cut still in the relay's queue when the wait runs out says so, says how to carry on, and offers the paying account
//   hxtip    the card's wrap tip is the relay's for the amount typed (3% of a small one, capped), not one figure read for 0.1 ETH
//   farmheld  a harvest still in the relay's queue when the wait runs out offers the paying account too
//   farmreuse a stopped zap's two notes (one of the swapped amount, one that pairs with its return) are spent whole: Max takes both and
//            nothing is split again
//   farmexit Exit on a private position is one press: harvest what is worth harvesting, unbond giving up what accrued since (a plain
//            unbond refuses it), take the liquidity out, each step named as it runs
//   farmclaim Claim rewards harvests the positions with a real reward and none holding dust, then unwraps the wTAC
//   swap     the Swap tab of the Tacit pool: its link, a swap of a note that is exactly the amount, an amount no note matches (cut
//            first), a swap between two assets that are not tETH (through tETH), and a refusing relay (offered from the account)
//   pair     with no TAC held, Max fills the ETH side and says TAC is missing; then ETH + TAC staked in one transaction
//            with an EIP-2612 permit
//   farm     a one-sided ETH zap waits for its typed loss acceptance (its preview's APR never above the farm's APR now),
//            stakes, claims, then withdraws everything; what is
//            earned and earned a day also read in ETH, the dashboard says what there is to claim, and a claim then shows
//            under Claimed so far
//   reinvest a stake's claim opens the add form on TAC with exactly what was paid, and farming it stakes it again
//   buy      TAC bought with ETH through zRouter
//   tacfarm  TAC alone zapped in with a permit; half withdrawn as ETH; LP held staked again; the rest withdrawn as TAC
//   sell     TAC sold for ETH through zRouter in one transaction, the permit riding as its first leg
//   v1       the identity signature unlocks the key; a tipped wrap lands and its settle is submitted
//   v1refuse the relay refuses a wrap's settle after its deposit landed: the form empties and the line points to Finish
//   devsend  the EVM pool's Send opens tacit pay on the same chain, and Receive keeps the pool and deposit addresses
//   device   a deposit into the EVM pool, proved in the page's worker
//   borrow   the Bitcoin deposit address renders; a bond for a lock record posts through the escrow helper
//   keys     an Ethereum signature opens a key; after locking, "continue" reopens the same tacit1 address; a pasted key opens
//   tacopen  a key opened from inside the TAC sheet (reached by link): the sheet's balance reads again for it at once
//   saved    a passphrase-locked key saved the way tacit.finance saves it opens through tacit.js's own prompt; the TAC
//            sheet, reached by link with no key open, offers it too
//   bitcoin  a (stubbed, deterministic) UniSat wallet opens a key through tacit.js, then funds a lock in one call
//   passkey  a virtual authenticator with PRF creates a passkey wallet, and signing in again opens the same key
//   acct     a pasted key and no wallet: its Tacit account (as pool-ux derives it), funded from outside, buys TAC,
//            stakes ETH + TAC with a permit it signs, sends ETH out; a connected wallet then tops it up
//   devmove  (after acct) the Tacit account deposits into the EVM pool, sweeps a small arrival in, moves pool ETH into
//            V1 through a keeper-relayed withdrawToV1 whose note settle is then submitted, and asks to bridge to Base
//   pts      a listed address claims its points reward; a pasted key's Tacit account registers a .wei name through
//            zRouter's commit and reveal and publishes its tacit1 address on it
//   retention the points sheet's Retention section: shown with what this browser proved while the service has the holding reward on, absent while it is off
//   ptsview  the points sheet from a stubbed service: recent activity in time order across chains grouped by day, each
//            linked to its chain's explorer, the newest activity's holder boost, rank, claimed so far, today's share and
//            countdown; the day's pot and rate, the gap to the rank above, the change since an earlier day, the points-per-day
//            bars, the all-time and Today boards; the program's terms as the service states them (dates, the limit per point and its
//            next change, what each way of earning pays, the early bonus, the holder tiers) and the page's own where it states none or
//            something unreadable; and, with nobody connected, the public board and finding an address in it
//   csend    the Borrow sheet's Send: private cUSD/cBTC (notes stubbed into the balance) go privately to a tacit1 address
//            or out as tacUSD to an 0x… address, with fees shown first and an amount over the balance refused
//   tacsend  the TAC sheet's own Send, private-only: a stubbed cTAC note goes privately to a tacit1 address, shown as
//            TAC never cTAC, or out as public TAC to an 0x… address for a partial amount, beside the one-tap Make public
//   shieldwallet with a wallet paying, the TAC sheet makes the wallet's own TAC private: its permit, one router transaction, no stop at the Tacit account
//   farmjoin a private farm joined from weld: stubbed tETH and TAC notes are cut to the live pool ratio and handed to
//            lpBond for the farm manager, with a self-settle hook so the paying account sends the bond
//   shield   the TAC sheet's Shield: public TAC funded into the key's own Tacit account wraps in one router
//            transaction; the fork's stubbed settle leaves it pending, offered to Finish like any other TAC deposit
//   btc      a pasted key's Bitcoin sheet: balances read, BTC routes (tacit1 and sp1 as silent payments, bc1 plain), TAC
//            routes refuse plain addresses, a tacit1's silent-payment keys are the ones this wallet scans, a payment link checks,
//            the refresh beside the balance also looks through TAC's transfer index for shielded payments
//   bridge   the TAC sheet's Bridge: stubbed TAC notes on Bitcoin listed (one over the limit refused), a tracked note checks out
//            as one Bitcoin transaction but waits for sats for its fee, bridges under way show their steps and actions, and
//            Recover files its claim
//   xobridge the tETH sheet's To Bitcoin tab: hidden until enabled by a local setting (a deep link to it then falls back) unless a bridge is under way;
//            a tETH balance (stubbed notes) is quoted the relay fee, the Bitcoin fee and the time, refused over the limit and under the
//            minimum, and held back until the key's Bitcoin address has sats for the Bitcoin step and the box is ticked; bridges under
//            way (seeded in tacit.js's journal) show their steps and actions, a burn not yet seen to land is cancelled only after
//            Ethereum is looked at, starting one sends a bridge-burn job and leaves a record behind when the settle is not seen, and a
//            send the relay refuses at submit offers the paying account and leaves no record
//   xbring   the To Bitcoin tab's tETH on Bitcoin (also counted on the dashboard and on the card's tETH-on-Bitcoin source): a key's Taproot output holds tETH notes that two real signed cross-out mint reveals
//            made (one recorded by Bitcoin's proof, one it has not reached), listed on request with the amount the journal knows; the
//            recorded one is sent back by a burn that is signed and broadcast through ordinary relay, burns the note under its own
//            ν for tETH with this key as its owner, and shows under Coming back; the TAC Bridge tab does not list it
//   xtbridge the TAC sheet's Bridge tab, To Bitcoin side: the same bridge for TAC. Hidden until TAC's own setting is on or a TAC bridge is
//            under way (the tETH setting does not turn it on); its rows are TAC's alone; a 50 TAC note is quoted 46 on Bitcoin at the
//            relay's own published floor (4 TAC; 8 if it has moved, said in the receipt), refused over 1,000 and under 20, and started on the TAC note and
//            never the tETH note of the same size; the fee the relay turns down is asked once more doubled; a send refused at submit
//            offers the paying account; the landing card quotes what the sheet then says, the cut of a note included; an older record
//            kept with no ticker is read as TAC
//   xtring   its TAC on Bitcoin and the way back: two real signed TAC cross-out mints at the key's Taproot output, one the journal
//            remembers and one whose amount (past the search's reach) is found from the note the key spent; a return burns the note under
//            its own ν for TAC, shows under Coming back and on the From Bitcoin side, keeps the side while in flight, and an ordinary TAC
//            bridge from Bitcoin does not bring it; a press on its row reports on the side's own line; with the journal gone it is rebuilt
//            from its burn's transaction id and the key alone (its 40 TAC read from the key's own spent notes)
//   hxout    the landing card's Bitcoin tab, going out: the assets it offers follow the two settings, TAC is quoted at its relay floor and
//            limits, its button opens the TAC sheet's To Bitcoin side with the amount, and a key short of private TAC is sent to make some
//   hxlink   the same button with no key open: the Bridge tab asks for one, still addressed as the way out, and opens on that side with the amount
//   pxsback  the price strip on a return visit: prices kept less than an hour ago show at once and the reading replaces them; older ones are not drawn
//   hxways  the card's Shield by what is held: each source lists its own ways, the chain picker shows for the ETH-only pools alone (MegaETH scores no
//            points), payments ETH goes to its own chain's Deposit form with the amount, Borrow hands its BTC to the lock form
//   activity relayed jobs (dispatched as tacit:job, as the relay client does) move Queued → Proving → Done or Failed, with
//            toasts and Etherscan links; a transaction the page sends is followed to its receipt; after a reload the list
//            is still there, a job left proving is followed to its settle, a failure from the last six hours is asked
//            about again and flips to done, an older one is not; a system notification goes out only while hidden
//   dash     the "your Tacit" dashboard: the first paint at phone width has no sideways scroll; a connected wallet's
//            dashboard shows placeholders first, then values, and what changed since the last visit's snapshot
//   selfexit  an exit the relay refuses at submit offers to be sent from the paying account at once: told what the network fee
//            needs when the account has no ETH, then, funded, a proof-only job with no relay fee
//   selfmore  a private send, and a send-out, the relay refuses: the same offer, the account's address to copy when it has no ETH,
//            then proof-only jobs with no relay fee from the paying account
//   selflocks the ETH sheet's claim, take-back and withdrawal, each refused by the relay and sent from the paying account
//   selfsplit the split before a private send, refused the same way
//   makepub   Make public with the relay taking it: the fee shown beforehand, an address entered there, a bad one refused, and
//            the sheet saying it was sent and where it goes
//   tacdeposit  a real 20 TAC deposit whose settle never landed: the TAC sheet and the dashboard offer to finish it,
//            and Finish submits a wrap job rebuilt with the TAC asset and its own scale
//   openact  steps the relay proved and nobody sent (open, sending for minutes, proven for a page that closed) are offered in Activity
//            to send now; the proof goes out as it is (no second proof), the relay is told it landed, and one already sent reads done
//   openfarm a harvest the relay proves and holds: the sheet offers to send it now, and it goes out with no second proof
//   heldoff  an exit refused after the form went to Activity (its combine queued first) is offered on its receipt there, and sent
//   provecap the relay's day of proofs used up is said plainly with nothing offered, also when met while sending it yourself
//   heldborrow the Borrow sheet's Borrow and Repay, held by the relay, offer to send from the paying account
//   holdborrow cBTC the key holds that no lock of its own made: the sheet leads with a borrow form on its notes (ratio presets, what it is
//           liquidated at, a note cut to size when no note matches), its loans listed with Repay, the lock steps folded under it
//   holdpublic tacBTC held in public by the paying account is offered as the collateral: the relay is asked to prove the deposit-collateral open for
//           that amount, the approval is signed, and the router call is asked of the pool before it would be sent
//   selffund  #prove-self: the Tacit account as prover account and its credit; PROVE added from the wallet (a transfer to the Tacit account,
//            then permitAndDeposit with a permit that account signs, taken by the real vApp on the fork); the switch and each sheet's note
//   selfprove with the switch on, a withdrawal and a swap are proved on the holder's credit (no submit to the relay) and settled from the
//            wallet, Activity naming its steps; too little credit, a request not taken, an op it cannot prove, and a pool that moved
//   relaystate what the relay says of itself (GET /confidential/relay) at the press: paused offers proving it yourself (and the line, for
//            an op that does not expire) with nothing submitted; held sends it from the paying account; an Activity exit while paused
//   relayfail a relayed job whose proof failed ("settle failed: prove failed: …") offers proving it yourself
//   PLAYWRIGHT=<path to playwright-core> node tools/weld-check.mjs [scenario,…] [fork rpc]   (SHOTS=<dir> saves screenshots)

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { depositIdOf } from '../worker-relay/src/lib/spent-precheck.js';
import { sha256 } from '@noble/hashes/sha256';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
// Borrow reports under each step's own line (#bw-s1…#bw-s4) as well as the sheet's: read them all.
const bwText = (page) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent).join(' '), '#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4');
const ONLY = new Set((process.argv[2] || 'airdrop,links,flowpanel,ux,apr,farmgate,pair,farm,reinvest,buy,tacfarm,sell,v1,v1refuse,devsend,device,borrow,bonds,mainbond,locks,repay,csend,tacsend,selfexit,selfmore,selflocks,selfsplit,makepub,farmjoin,farmpos,farmsteps,farmzap,farmqueue,farmheld,farmreuse,hxtip,farmexit,farmclaim,farmself,farmworth,swap,shield,keys,tacopen,saved,bitcoin,passkey,acct,devmove,btc,bridge,bridgepub,xobridge,xbring,xtbridge,xtring,xtfind,hxout,hxlink,hxpanel,hxweek,hxsell,hxsats,hxteth,hxsend,hxborrow,hxborrowback,tradelinks,pxs,pxsback,pts,ptsview,retention,activity,receipts,stats,dash,tacdeposit,openact,openfarm,heldoff,provecap,heldborrow,holdborrow,holdpublic,selffund,selfeth,selfprove,relaystate,relayfail').split(','));
const FORK = process.argv[3] || 'https://mainnet.gateway.tenderly.co';
const SHOTS = process.env.SHOTS || null;
const PORT = 20000 + Math.floor(Math.random() * 2000), WEB = PORT + 1;
const ANVIL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw Object.assign(new Error(r.error.message), { data: r.error.data });
  return r.result;
};
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.zkey': 'application/octet-stream' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'cloudflare-eth.com', 'rpc.flashbots.net'];
const submits = [], refused = [], relays = [], walletTxs = [];
let gatewayOnce = false;                                          // the next relay meets a gateway timeout (devmove)
// Submits the relay refuses before taking them, as it does once the day's free settles are used up.
let refuseSubmits = 0;
// What a relayed job reports when it fails (the default stands for a settle the page could not see through).
let statusError = 'stubbed in the fork check';
// With `proveStub`, a job asked for as a proof only reads proven (a stand-in proof, with the memos it was sent with),
// for a page that sends the settle itself.
let proveStub = false;
const provenJobs = {};
// `refuseWith`: what a refused submit answers instead of the free-settle refusal ({ code, error }: relay_held, prove_budget …).
// `refuseTypes`: refuse only submits of these op types (with refuseSubmits counting them). `openNext`: that many settle-mode submits
// are proved and held as an open job (status `open`, its proof and the memos it was sent with), as the relay holds what it cannot
// send. `landedPosts`: the page's reports of a settle it sent itself (POST /confidential/landed), which settle an open job here.
let refuseWith = null, refuseTypes = null, openNext = 0;
// What GET /confidential/relay says of the relay: 'ok' unless a scenario sets 'held', 'paused', 'down' or 'busy' (null: the route is missing).
let relayStateNow = 'ok';
const openJobs = {}, landedPosts = [];

// router.withdrawToV1(tx, intent), encoded as evm-pool-wallet.js encodes it for a self-sent move.
const { calldata } = await import(new URL('../dapp/evm-pool-gateway.js', import.meta.url));
const EVM_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', EVM_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', KEEPER = '0xa0ee7a142d267c1f36714e4a8f75612f20a79720';   // anvil account 9
const PAIR = { tuple: ['uint256', 'uint256'] }, B = (x) => BigInt(x);
const TX_TYPES = [PAIR, { tuple: [PAIR, PAIR] }, PAIR, { tuple: Array(11).fill('uint256') }, 'address', 'uint256', 'address', 'uint256', 'bytes', 'bytes'];
const TX_SIG = '(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes)';
const WRAP_SIG = '(bytes32,uint256,uint256,address,bytes32,address,uint64,uint256)';
const WRAP_TYPES = ['bytes32', 'uint256', 'uint256', 'address', 'bytes32', 'address', 'uint64', 'uint256'];
const withdrawToV1Data = (t, i) => calldata(`withdrawToV1(${TX_SIG},${WRAP_SIG})`, [{ tuple: TX_TYPES }, { tuple: WRAP_TYPES }], [
  [t.pA.map(B), t.pB.map((r) => r.map(B)), t.pC.map(B), t.publicInputs.map(B), t.recipient, BigInt.asUintN(256, B(t.extAmount)), t.relayer, B(t.fee), t.memo0, t.memo1],
  [i.assetId, B(i.amount), B(i.tip), i.tipTo, i.commit, i.refund, B(i.deadline), B(i.nonce)]]);
const fromJsonText = (t) => JSON.parse(t || 'null');
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function openPage({ account, key = null, host = '127.0.0.1', init = null, viewport = { width: 1280, height: 900 }, colorScheme = 'light' }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme });
  // A fork slow to fetch upstream state answers as an RPC that failed, which the page handles, instead of ending the run.
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    const t0 = Date.now(), what = () => { try { const b = JSON.parse(route.request().postData() || '{}'); return (Array.isArray(b) ? b : [b]).map((x) => x.method).join(','); } catch { return '?'; } };
    try {
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
      if (Date.now() - t0 > 20000) console.log(`     slow fork call: ${what()} took ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      console.log(`     fork call failed: ${what()} after ${Math.round((Date.now() - t0) / 1000)}s: ${e.message}`);
      await route.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: `the fork did not answer: ${e.message}` }) }).catch(() => {});
    }
  });
  // On localhost the modules send relay calls to the page's own origin (confidential-deployments.js), so both that
  // path and the live host are covered: submits and job status are stubbed, reads pass through to the live API.
  const relay = async (route) => {
    const u = new URL(route.request().url());
    const sub = u.pathname === '/confidential/submit' ? JSON.parse(route.request().postData() || '{}') : null;
    if (sub && refuseSubmits > 0 && (!refuseTypes || refuseTypes.includes(sub.type))) {
      refuseSubmits--;
      refused.push(sub);
      const why = Array.isArray(refuseWith) ? refuseWith.shift() : refuseWith;          // a list: one answer per refusal, in turn
      return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: false, ...(why || { error: 'free relayed settles for today are used up (300/300) — attach a fee above the floor, or prove-mode and settle it yourself', code: 'free_budget' }) }) });
    }
    if (sub) {
      const jobId = 'stub-' + (submits.push(sub));
      if (proveStub && sub.mode === 'prove') provenJobs[jobId] = { memos: sub.memos || [] };
      if (openNext > 0 && (sub.mode || 'settle') === 'settle') { openNext--; openJobs[jobId] = { type: sub.type, memos: sub.memos || [], status: 'open' }; }
      return json(route, { jobId });
    }
    if (u.pathname === '/confidential/relay') {
      if (!relayStateNow) return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"not found"}' });
      return json(route, { state: relayStateNow, proving: relayStateNow !== 'paused' && relayStateNow !== 'down', settling: relayStateNow === 'ok' || relayStateNow === 'busy', board: false, ageSeconds: 5 });
    }
    if (u.pathname === '/confidential/landed') {
      const b = JSON.parse(route.request().postData() || '{}'), oj = openJobs[b.jobId];
      landedPosts.push(b);
      if (oj) Object.assign(oj, { status: 'settled', txHash: b.txHash });
      return json(route, { ok: true, jobId: b.jobId, status: 'settled', txHash: b.txHash });
    }
    if (u.pathname === '/confidential/status') {
      const id = u.searchParams.get('id'), pj = provenJobs[id], oj = openJobs[id];
      if (pj) return json(route, { jobId: id, mode: 'prove', status: 'proven', publicValues: '0x' + '01'.repeat(32), proof: '0x' + '02'.repeat(32), memos: pj.memos });
      if (oj) return json(route, { jobId: id, type: oj.type, mode: 'settle', status: oj.status, txHash: oj.txHash || null, ...(oj.status === 'settled' ? {} : { publicValues: '0x' + '01'.repeat(32), proof: '0x' + '02'.repeat(32), memos: oj.memos }) });
      return json(route, { status: 'failed', error: statusError });
    }
    // A live API that does not answer is the page's to report, as it would be for a user; the run goes on.
    try {
      const r = await fetch('https://api.tacit.finance' + u.pathname + u.search, { method: route.request().method(), headers: { 'content-type': 'application/json' }, body: route.request().method() === 'GET' ? undefined : route.request().postData(), signal: AbortSignal.timeout(60000) });
      return route.fulfill({ status: r.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
    } catch (e) {
      return route.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: `the live API did not answer: ${e.message}` }) });
    }
  };
  await ctx.route(/^https:\/\/api\.tacit\.finance\/confidential\/(submit|status|landed|relay)/, relay);
  await ctx.route(new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${WEB}/(confidential|farm|reflection)/`), relay);
  // Keepers: quotes are canned and the queue is absent (wallets prove against their own tree). A move into V1 is
  // relayed for real, router.withdrawToV1 sent as a keeper would; any other relay is recorded and refused.
  await ctx.route('https://tacit-evm-pool-keeper*.onrender.com/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    // A quote names its chain and pool, which the wallet checks before it signs anything (its host says which chain).
    if (/\/quote$/.test(p)) return json(route, { chainId: /-base\./.test(route.request().url()) ? 8453 : /-robinhood\./.test(route.request().url()) ? 4663 : /-megaeth\./.test(route.request().url()) ? 4326 : 1, pool: EVM_POOL,
      relayer: '0x0000000000000000000000000000000000000001', fee: '329000000000000', sweepFee: '439000000000000', receiveMin: '175600000000000000' });
    if (/\/(head|reserve)$/.test(p)) return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    if (/\/relay$/.test(p)) {
      const b = JSON.parse(route.request().postData() || '{}');
      relays.push(b);
      // A gateway in front of the relay timing out: an HTML page, no JSON error, nothing known about the send.
      if (gatewayOnce) { gatewayOnce = false; return route.fulfill({ status: 504, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: '<html><body>504 Gateway Time-out</body></html>' }); }
      // A plain spend is refused as a keeper that cannot front its gas refuses it; a bridge call is just stubbed.
      if (!b.wrap) return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ error: b.call ? 'stubbed in the fork check' : "the relay can't take this one right now; send it from your own wallet, or try again later" }) });
      b.txHash = await rpc('eth_sendTransaction', [{ from: KEEPER, to: EVM_ROUTER, data: withdrawToV1Data(b.tx, b.wrap), gas: '0x2dc6c0' }]);
      return json(route, { txHash: b.txHash });
    }
    return json(route, { ok: true });
  });
  let walletChain = '0x1';                                   // what the wallet says it is on; every chain is this one fork
  await ctx.exposeFunction('__wallet', async (method, params = []) => {
    if (method === 'eth_sendTransaction') { walletTxs.push(params[0]); const { chainId, ...tx } = params[0]; return rpc(method, [tx]); }
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return walletChain;
    if (method === 'wallet_switchEthereumChain') { walletChain = params[0]?.chainId || walletChain; return null; }
    if (method === 'wallet_watchAsset') return null;
    if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      if (!key) throw Object.assign(new Error('this account cannot sign'), { code: 4001 });
      let digest;
      if (method === 'personal_sign') {
        const msg = Buffer.from(params[0].slice(2), 'hex');
        digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
      } else {                                                  // EIP-2612 Permit, the only typed data the page signs
        const d = JSON.parse(params[1]), m = d.message, hx = (b) => Buffer.from(b).toString('hex');
        const k = (s) => keccak_256(typeof s === 'string' ? Buffer.from(s) : s);
        const dom = k(Buffer.from(hx(k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')) + hx(k(d.domain.name)) + hx(k(d.domain.version)) + word(d.domain.chainId) + addrWord(d.domain.verifyingContract), 'hex'));
        const st = k(Buffer.from(hx(k('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)')) + addrWord(m.owner) + addrWord(m.spender) + word(m.value) + word(m.nonce) + word(m.deadline), 'hex'));
        digest = k(Buffer.concat([Buffer.from([0x19, 0x01]), Buffer.from(dom), Buffer.from(st)]));
      }
      const sig = secp.sign(digest, key.slice(2));
      return '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
    }
    return rpc(method, params);
  });
  await ctx.addInitScript(() => { window.ethereum = { request: ({ method, params }) => window.__wallet(method, params), on() {}, removeListener() {} }; });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.message} @ ${(e.stack || '').split('\n').slice(1, 3).map((s) => s.trim()).join(' < ')}`));
  return { browser, ctx, page, errors, url: `http://${host}:${WEB}/` };
}

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `weld-${name}.png`) }) : null;
async function step(name, fn) { if (!ONLY.has(name)) return; try { await fn(); } catch (e) { fails++; console.log('FAIL', name, '-', e.message.split('\n')[0]); if (process.env.DEBUG_STEP) console.log(e.stack); } }
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
// The picture of the two chains (dapp/weld/flow/viz.js) as a page shows it: drawn or not, its counters, its clock and its words.
const flowLook = (page, host) => page.evaluate((h) => { const c = document.querySelector(h + ' canvas'); const d = c ? c.getContext('2d').getImageData(0, 0, c.width, c.height).data : []; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; const q = (x) => (document.querySelector(h + ' ' + x) || {}).textContent || ''; return { has: !!c, drawn: n, foot: q('.fl-foot'), clock: q('.fl-clock'), sr: q('.fl-sr') }; }, host);
const flowFeed = () => { const t = Math.floor(Date.now() / 1000), ago = (x) => t - x; return { asOf: t, windowSec: 86400, now: { btc: 969200, relay: 969180, attested: 969159, burns: 27, minted: 24, crossOuts: 5, burnDeposits: 1, tacSupply: '2499974665590930000000000' },
  series: [{ t: ago(90000), burns: 25, minted: 22, out: 4, att: 969000, relay: 969050, btc: 969100 }, { t: ago(40000), burns: 26, minted: 23, out: 5, att: 969090, relay: 969120, btc: 969150 }, { t: ago(600), burns: 27, minted: 24, out: 5, att: 969159, relay: 969180, btc: 969200 }],
  events: { attests: [ago(70000), ago(30000), ago(900)], settles: [ago(50000), ago(3000)], deposits: [ago(20000)], tacOut: [ago(10000), ago(9000)], tacIn: [ago(5000)] } }; };
const until = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout });
// A fee quote reads gas and the prove price over the fork, which can take minutes a call when the fork is slow.
const QUOTE_WAIT = 600000;

const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';
const A0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', K0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RECIPIENT = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20';           // airdrop index 978
const tacOf = async (a) => BigInt(await rpc('eth_call', [{ to: TAC, data: '0x70a08231' + addrWord(a) }, 'latest']));
const stakedOf = async (a) => BigInt(await rpc('eth_call', [{ to: FARM, data: '0x98807d84' + addrWord(a) }, 'latest']));
const allowanceOf = async (token, owner, spender) => BigInt(await rpc('eth_call', [{ to: token, data: '0xdd62ed3e' + addrWord(owner) + addrWord(spender) }, 'latest']));
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', RESERVE = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
// TAC for a scenario that runs on its own, sent from the reserve (the ops multisig) on the fork.
async function fundTac(to, amount) {
  await rpc('anvil_impersonateAccount', [RESERVE]); await rpc('anvil_setBalance', [RESERVE, '0x' + (10n ** 18n).toString(16)]);
  await rpc('eth_sendTransaction', [{ from: RESERVE, to: TAC, data: '0xa9059cbb' + addrWord(to) + word(amount) }]);
  await rpc('anvil_stopImpersonatingAccount', [RESERVE]);
}
// Wait for a button to enable, accepting the loss gate beside it if the pool's depth puts one up.
async function acceptLoss(page, goSel, ackSel) {
  await until(page, ([g, a]) => { const b = document.querySelector(g); return (b && !b.disabled) || !!document.querySelector(a); }, [goSel, ackSel], 240000);
  for (let i = 0; i < 6 && await page.isDisabled(goSel); i++) {
    if (await page.$(ackSel)) {
      if (await page.$eval(ackSel, (x) => x.type === 'checkbox')) await page.check(ackSel);
      else await page.fill(ackSel, await page.$eval(ackSel, (x) => x.closest('.ack').querySelector('b').textContent));
    }
    await sleep(1500);
  }
}
// The pool with settle() answered here and every other call run by its own code (copied to another address and delegated to, so it
// reads and writes the pool's storage as before): what a settle sent from the page reaches without a real proof. `onSettle`: 'ok'
// (it succeeds and changes nothing) or a 4-byte error selector it reverts with. Returns what puts the pool's code back.
const POOL_ADDR = '0x000000000ed1eabd231be41d93b719056f7febfc', SETTLE_SEL = Buffer.from(keccak_256('settle(bytes,bytes,bytes[])')).toString('hex').slice(0, 8);
async function stubPoolSettle(onSettle = 'ok') {
  const REAL = '0x' + '5e77'.repeat(10), code = await rpc('eth_getCode', [POOL_ADDR, 'latest']);
  await rpc('anvil_setCode', [REAL, code]);
  const h2 = (n) => n.toString(16).padStart(4, '0');
  const head = (ok, stop) => `600035${'60e01c'}80${'63' + SETTLE_SEL}14${'61' + h2(stop)}5750`          // selector; settle() jumps to `stop`
    + '366000600037' + '6000600036600073' + REAL.slice(2) + '5af4'                                       // copy the call, delegate it
    + '3d6000600037'.replace(/37$/, '3e') + `61${h2(ok)}57` + '3d6000fd' + '5b3d6000f3';                   // its answer: revert or return it
  const len = (x) => x.length / 2, okAt = len(head(0, 0)) - 5, stopAt = len(head(0, 0));
  const tail = onSettle === 'ok' ? '5b00' : `5b63${onSettle}60e01b60005260046000fd`;
  await rpc('anvil_setCode', [POOL_ADDR, '0x' + head(okAt, stopAt) + tail]);
  return () => rpc('anvil_setCode', [POOL_ADDR, code]);
}

// Chain state, polled, is the check: a toast from an earlier step can still be on screen.
async function chainUntil(fn, ms = 240000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(1500); } return false; }
const toastSays = (page, re) => until(page, (r) => new RegExp(r).test(document.querySelector('#toast-container')?.textContent || '') || !!document.querySelector('#farm-precision .status .err'), re.source, 240000);

const main = await openPage({ account: A0, key: K0 });
const { page, url } = main;

await step('airdrop', async () => {
  await rpc('anvil_impersonateAccount', [RECIPIENT]);
  await rpc('anvil_setBalance', [RECIPIENT, '0x' + (10n ** 18n).toString(16)]);
  const r = await openPage({ account: RECIPIENT });
  await r.page.goto(r.url + '#airdrop');
  await r.page.click('#air-connect');
  await r.page.waitForSelector('#air-claim', { timeout: 60000 });
  await r.page.click('#air-claim');
  await until(r.page, () => /Claimed\./.test(document.querySelector('#air-body')?.textContent || ''));
  await shot(r.page, 'airdrop');
  ok((await tacOf(RECIPIENT)) >= 216176408192580000000000n, 'airdrop: the allocation arrives');
  // The tile re-renders a few milliseconds after the claim's own line does, so it is waited for, not read once.
  ok(await until(r.page, () => /claimed/i.test(document.querySelector('[data-foot="tac"]')?.textContent || ''), null, 15000).then(() => true, () => false), 'airdrop: the tile says claimed');
  await r.browser.close();
  await rpc('eth_sendTransaction', [{ from: RECIPIENT, to: TAC, data: '0xa9059cbb' + addrWord(A0) + word(1000n * 10n ** 18n) }]);
});

await step('links', async () => {
  await page.goto(url + '#swap');
  await page.waitForSelector('#sheet-tac[open] [data-tac-mode="buy"][aria-selected="true"]', { timeout: 60000 });
  ok(true, 'links: #swap opens TAC on Buy');
  await page.click('[data-tac-mode="sell"]');
  ok((await page.evaluate(() => location.hash)) === '#sell', 'links: the address bar follows the tab (#sell)');
  await shot(page, 'links-sell');
  await page.goto(url + '#points');
  await page.waitForSelector('#sheet-pts[open]', { timeout: 60000 });
  await page.goto(url + '#earn');
  await page.waitForSelector('#sheet-farm[open]', { timeout: 60000 });
  // A link to a private pool the program does not have opens the public pool, and the address bar says so.
  await page.goto(url + '#farm/private-99');
  await until(page, () => !!document.querySelector('#sheet-farm li.farm.open[data-farm="precision"]') && location.hash === '#farm', null, 60000);
  ok(true, 'links: #farm/private-99 (no such pool) opens the public pool');
  const shares = await page.$$eval('dialog.sheet:not(.layer) .sheet-head .x.share', (b) => b.length);
  const sheets = await page.$$eval('dialog.sheet:not(.layer)', (d) => d.length);
  ok(shares === sheets && sheets >= 6, `links: every sheet has a copy-link button (${shares}/${sheets})`);
});

// The picture of the two chains under the front page's lanes: read nothing until it is near, then its own feed, drawn, and no sideways scroll.
await step('flowpanel', async () => {
  for (const [tag, viewport] of [['desk', { width: 1280, height: 900 }], ['phone', { width: 390, height: 900 }]]) {
    const r = await openPage({ account: A0, key: K0, viewport });
    let reads = 0;
    await r.ctx.route(/^https:\/\/api\.tacit\.finance\/flow/, (route) => { reads++; return json(route, flowFeed()); });
    await r.ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/api\/blocks\/tip\/height/, (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '969200' }));
    try {
      await r.page.goto(r.url);
      await r.page.waitForSelector('#kept', { state: 'attached' });
      await sleep(1500);
      ok(reads === 0 && !(await r.page.$('#kept-v .fl')), `flowpanel (${tag}): nothing is read or drawn until the section is near (${reads} reads)`);
      await r.page.locator('#kept').scrollIntoViewIfNeeded();
      await until(r.page, () => /proven to block/.test(document.querySelector('#kept-v .fl-foot')?.textContent || ''), null, 30000);
      await sleep(1500);
      const fl = await flowLook(r.page, '#kept-v');
      ok(fl.has && fl.drawn > 200, `flowpanel (${tag}): the picture is drawn (${fl.drawn} pixels)`);
      ok(/proven to block 969,159/.test(fl.foot) && /41 behind Bitcoin/.test(fl.foot) && /3 proofs · 2 settles/.test(fl.foot), `flowpanel (${tag}): its counters are the feed's (${fl.foot})`);
      ok(reads >= 1 && /3 proofs of Bitcoin landed on Ethereum/.test(fl.sr), `flowpanel (${tag}): one feed, and the words say what it shows (${reads} reads)`);
      ok(await r.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `flowpanel (${tag}): no sideways scroll`);
      await shot(r.page, `flowpanel-${tag}`);
      if (r.errors.length) { fails++; console.log(`FAIL flowpanel (${tag}) page errors: ` + r.errors.slice(0, 3).join(' | ')); }
    } finally { await r.browser.close(); }
  }
});

await step('ux', async () => {
  await page.goto(url + '#sell');
  await page.waitForSelector('#sell-connect, #sl-amt', { timeout: 60000 });
  if (await page.$('#sell-connect')) await page.click('#sell-connect');
  await page.waitForSelector('#sl-amt');
  // The page outside a modal dialog is inert, so a toast has to sit inside it to be pressed.
  await page.evaluate(() => {
    const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = '<button id="ux-toast" type="button">Open</button>'; window.__ux = 0;
    t.querySelector('button').onclick = () => { window.__ux++; }; document.querySelector('#toast-container').append(t);
  });
  await page.waitForSelector('#ux-toast');
  await page.click('#ux-toast');
  ok((await page.evaluate(() => window.__ux)) === 1 && await page.$eval('#sheet-tac', (d) => d.open), 'ux: a toast over an open sheet can be pressed, and the sheet stays open');
  await page.evaluate(() => document.querySelector('#toast-container .toast')?.remove());
  const box = await page.locator('#sl-amt').boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(2, 2); await page.mouse.up();
  ok(await page.$eval('#sheet-tac', (d) => d.open), 'ux: a drag that starts in the sheet and ends on the backdrop leaves it open');
  await page.fill('#sl-amt', '1,500');
  await page.locator('#sl-amt').blur();                                       // 1,500 is flagged on leaving the field, not while it may still be typed
  const hintSays = (re) => until(page, (r) => new RegExp(r).test(document.querySelector('[data-amt-hint]')?.textContent || ''), re.source, 5000).then(() => true, () => false);
  ok(await hintSays(/Write 1500 for fifteen hundred, or 1,5 for a decimal comma/), 'ux: an ambiguous 1,500 says how to write it');
  await page.fill('#sl-amt', '1.2.3');
  ok(await hintSays(/cannot be read/), 'ux: an unreadable amount says so');
  await page.fill('#sl-amt', '1');
  ok(!(await page.$('[data-amt-hint]')), 'ux: a readable amount shows no hint');
  await page.evaluate(() => { location.hash = '#farm'; });
  await page.waitForSelector('#sheet-farm[open]', { timeout: 60000 });
  await sleep(600);
  ok((await page.evaluate(() => location.hash)) === '#farm', 'ux: one sheet replacing another keeps the new sheet\'s link in the address bar');
  await page.goto(url + '#constructor');
  await page.waitForSelector('#hx-body .hx-h');
  await page.evaluate(() => { location.hash = '#points'; });
  await page.waitForSelector('#sheet-pts[open]', { timeout: 60000 });
  ok(true, 'ux: a hash that names no sheet is ignored, and later links still open their sheets');
});

await step('apr', async () => {
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await until(page, () => /APR now\s*(about [\d,]+%|over 100,000%)/.test(document.querySelector('#farm-precision')?.textContent || ''), null, 120000);
  const rows = await page.$$eval('.farm .rate', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  const card = await page.$eval('#farm-precision', (e) => e.textContent.replace(/\s+/g, ' '));
  console.log('   rows:', rows.join(' | '));
  console.log('   card:', (card.match(/APR now[^.]*\./) || [''])[0]);
  ok(rows.length >= 2 && rows.every((r) => /APR/.test(r)) && /APR now\s*(about [\d,]+%|over 100,000%)/.test(card), 'apr: every farm shows its APR now, the public card in full');
  await page.goto(url);
  await until(page, () => /\d%/.test(document.querySelector('#pub-apr')?.textContent || ''), null, 120000).catch(() => {});
  const lead = (await text(page, '#pub-apr')).replace(/\s+/g, '');
  ok(/^(\d[\d,]*|10,000\+)%APR$/.test(lead), `apr: the public farm's way in leads with its APR (${lead})`);
});

await step('farmgate', async () => {
  const r = await openPage({ account: A0, key: K0 });
  try {
    await r.page.goto(r.url + '#farm');
    await r.page.waitForSelector('#pf-connect', { timeout: 120000 });
    ok(!!(await r.page.$('#pf-tacit')), 'farmgate: with nobody connected the farm offers a browser wallet, and a Tacit wallet instead');
    await r.page.click('#pf-tacit');
    await r.page.waitForSelector('#farm-precision-in [data-in]', { timeout: 30000 });
    ok(!(await r.page.$('#pf-connect')) && !!(await r.page.$('#pf-back')) && (await r.page.$$('#farm-precision-in [data-in]')).length >= 2, 'farmgate: the ways into a Tacit wallet open in place, with a way back');
    await r.page.click('#pf-back');
    await r.page.waitForSelector('#pf-connect', { timeout: 30000 });
    ok(true, 'farmgate: and back to the browser wallet');
    if (r.errors.length) { fails++; console.log('FAIL farmgate page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('pair', async () => {
  // The account starts with no TAC, whatever mainnet holds for it at the fork block, so Max says what is missing.
  const held = await tacOf(A0);
  if (held > 0n) await rpc('eth_sendTransaction', [{ from: A0, to: TAC, data: '0xa9059cbb' + addrWord(RESERVE) + word(held) }]);
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="pair"]', { timeout: 60000 });
  await page.click('[data-pfm="pair"]');
  await until(page, () => /You hold no TAC/.test(document.querySelector('#farm-precision .how')?.textContent || ''), null, 60000);
  ok(!!(await page.$('#farm-precision .how [data-go="buy"]')) && !!(await page.$('#farm-precision .how [data-go="eth"]')), 'pair: with no TAC held the form says so before anything is typed, with ways on');
  await page.click('#pf-max');
  ok(!(await page.inputValue('#pf-amt')) && !(await page.inputValue('#pf-tac')), 'pair: and Max does not invent a deposit the TAC cannot pay for');
  await page.fill('#pf-amt', '0.002');
  await until(page, () => /Not enough TAC/.test(document.querySelector('#pf-rcpt')?.textContent || ''), null, 240000);
  ok(await page.isDisabled('#pf-go') && !!(await page.$('#pf-rcpt [data-go="eth"]')), 'pair: a typed ETH amount still says TAC is missing, and offers ETH alone');
  await fundTac(A0, 1000n * 10n ** 18n);
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await until(page, () => /[1-9]/.test(document.querySelector('#pf-tmax')?.textContent || ''), null, 120000);
  // The no-TAC amount kept in the field re-quotes as "Not enough TAC"; clear it so the wait below sees Max's own quote.
  await page.fill('#pf-amt', '');
  await until(page, () => document.querySelector('#pf-rcpt')?.hidden, null, 60000);
  // ETH Max with TAC as the limit: the pair is sized from the TAC held, so neither field rounds past a balance.
  await page.click('#pf-max');
  await until(page, () => !document.querySelector('#pf-go').disabled || /Not enough|refuse/.test(document.querySelector('#pf-rcpt')?.textContent || ''));
  ok(!(await page.isDisabled('#pf-go')), `pair: ETH Max with TAC as the limit fills a deposit the TAC covers (${await page.inputValue('#pf-tac')} TAC, ${await page.inputValue('#pf-amt')} ETH)`);
  ok(/^\d*\.?\d{0,8}$/.test(await page.inputValue('#pf-amt')) && /^\d*\.?\d{0,6}$/.test(await page.inputValue('#pf-tac')), 'pair: both fields read to a few decimals, not 18 digits');
  await page.fill('#pf-amt', '0.002');
  await until(page, () => !document.querySelector('#pf-go').disabled || /\S/.test(document.querySelector('#pf-status')?.textContent || ''));
  if (await page.isDisabled('#pf-go')) throw new Error(`the ETH + TAC deposit stayed disabled: ${await text(page, '#pf-status')} | ${await text(page, '#pf-rcpt')}`);
  // ETH typed on its own tab, then ETH + TAC chosen: the TAC follows at the pool's ratio, rather than the pool being asked for a deposit of one side.
  await page.click('[data-pfm="eth"]'); await page.fill('#pf-amt', '0.003');
  await page.click('[data-pfm="pair"]');
  await until(page, () => Number(document.querySelector('#pf-tac')?.value) > 0 && /Deposit/.test(document.querySelector('#pf-rcpt')?.textContent || '') && !document.querySelector('#pf-go').disabled, null, 240000);
  ok(!/refuse/.test(await text(page, '#pf-rcpt')), `pair: switching to ETH + TAC with ETH typed fills the TAC at the pool's ratio (${await page.inputValue('#pf-tac')} TAC for ${await page.inputValue('#pf-amt')} ETH)`);
  // More than the account holds is said so, not that the pool refuses an amount too large to quote.
  await page.fill('#pf-amt', '999999999');
  await until(page, () => /More than your/.test(document.querySelector('#pf-rcpt')?.textContent || '') || /refuse/.test(document.querySelector('#pf-rcpt')?.textContent || ''), null, 240000);
  ok(/More than your/.test(await text(page, '#pf-rcpt')) && await page.isDisabled('#pf-go'), 'pair: an amount far past the balance says it is more than the account holds');
  await page.fill('#pf-amt', '0.002');
  await until(page, () => !document.querySelector('#pf-go').disabled && /Deposit/.test(document.querySelector('#pf-rcpt')?.textContent || ''), null, 240000);
  const s0 = await stakedOf(A0), t0 = await tacOf(A0);
  await page.click('#pf-go');
  await until(page, () => /Staked/.test(document.querySelector('#toast-container')?.textContent || '') || !!document.querySelector('#farm-precision .status .err'));
  ok((await stakedOf(A0)) > s0 && (await tacOf(A0)) < t0, `pair: ETH + TAC staked with a permit ${await text(page, '#pf-status')}`);
});

await step('farm', async () => {
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="eth"]', { timeout: 60000 });
  await page.click('[data-pfm="eth"]');
  // The pool's depth at the fork block decides how big a zap crosses the loss gate: the size grows until it asks.
  let gated = false;
  for (const amt of ['0.05', '0.5', '2', '8']) {
    await page.fill('#pf-amt', amt);
    if ((gated = await page.waitForSelector('#pf-ackv', { timeout: 20000 }).then(() => true, () => false))) break;
  }
  if (!gated) {
    if (process.env.DEBUG) console.log('   farm state:', JSON.stringify(await page.evaluate(() => ({ amt: document.querySelector('#pf-amt')?.value, open: document.querySelector('.farm.open')?.dataset.farm, mode: document.querySelector('[data-pfm][aria-selected="true"]')?.dataset.pfm, rcpt: document.querySelector('#pf-rcpt')?.textContent.replace(/\s+/g, ' '), status: document.querySelector('#pf-status')?.textContent, go: document.querySelector('#pf-go')?.disabled }))));
    throw new Error('farm: no zap size up to 8 ETH asked for its loss to be accepted');
  }
  ok(await page.isDisabled('#pf-go'), 'farm: a zap this size waits for its loss to be accepted');
  for (let i = 0; i < 5 && await page.isDisabled('#pf-go'); i++) {              // a requote can move the loss by a point
    // The pool's depth on the fork decides the gate: a tick box from 15% loss, a typed percent from 30%.
    if (await page.$eval('#pf-ackv', (x) => x.type === 'checkbox')) await page.check('#pf-ackv');
    else await page.fill('#pf-ackv', await page.$eval('.ack b', (b) => b.textContent));
    await sleep(1500);
    if (process.env.DEBUG) console.log('   ', JSON.stringify(await page.evaluate(() => ({ go: document.querySelector('#pf-go')?.disabled, ack: document.querySelector('#pf-ackv')?.value, b: document.querySelector('.ack b')?.textContent, mode: document.querySelector('[data-pfm][aria-selected="true"]')?.dataset.pfm, status: document.querySelector('#pf-status')?.textContent, rcpt: document.querySelector('#pf-rcpt')?.textContent }))));
  }
  ok(!(await page.isDisabled('#pf-go')), 'farm: typing the loss enables the zap');
  const rcpt = (await text(page, '#pf-rcpt')).replace(/\s+/g, ' '), cardApr = (await text(page, '#farm-precision')).replace(/\s+/g, ' ');
  const depA = parseFloat(((rcpt.match(/APR on this deposit\s*about ([\d,]+)%/) || [])[1] || '').replace(/,/g, ''));
  const nowA = parseFloat(((cardApr.match(/APR now\s*about ([\d,]+)%/) || [])[1] || '').replace(/,/g, ''));
  ok(depA > 0 && /Swap fees come on top/.test(rcpt) && /TAC a day \((≈ [\d.,]+|< 0\.00001) ETH\)/.test(rcpt), `farm: the deposit preview shows the APR for this deposit, in ETH a day too (${depA}%)`);
  ok(nowA > 0 && depA <= nowA * 1.005, `farm: and it is never above the farm's APR now (${depA}% on this deposit, ${nowA}% now)`);
  await shot(page, 'farm-zap');
  await page.click('#pf-go');
  await page.waitForSelector('#pf-exit', { timeout: 60000 });
  ok((await stakedOf(A0)) > 0n, 'farm: zapETH staked');
  const e0 = await text(page, '#pf-earned'); await sleep(3500); const e1 = await text(page, '#pf-earned');
  const seen = []; for (let i = 0; i < 8; i++) { seen.push(parseFloat(await text(page, '#pf-earned'))); await sleep(500); }
  ok(seen.every((v, i) => !i || v >= seen[i - 1]), `farm: and never counts down when a fresh read lands (${seen.join(' → ')})`);
  ok(!!e0 && e0 !== e1 && parseFloat(e1) > parseFloat(e0), `farm: what the stake has earned counts up while the sheet is open (${e0} → ${e1})`);
  const eth0 = (await text(page, '#pf-earned-eth')).trim();
  ok(/^(< )?[\d.,]+ ETH$/.test(eth0), `farm: what it has earned also reads in ETH (${eth0} for ${e1.trim()})`);
  ok(/Swap fees stay in the pool/.test(await text(page, '#farm-precision')), 'farm: the stake says its swap fees are already in its value');
  ok(/TAC a day \((≈ [\d.,]+|< 0\.00001) ETH\)/.test(await text(page, '#farm-precision')), 'farm: and what it earns a day');
  ok(!/Claimed so far/.test(await text(page, '#farm-precision')), 'farm: nothing is under Claimed so far before a first claim');
  await rpc('evm_increaseTime', [60]); await rpc('evm_mine', []);
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await until(page, () => { const b = document.querySelector('#pf-claim'); return b && !b.disabled; });
  await until(page, () => /to claim/.test(document.querySelector('[data-dash-open="farm"] .di-m')?.textContent || ''), null, 60000).catch(() => {});
  const dm = (await text(page, '[data-dash-open="farm"] .di-m')).trim();
  ok(/^(≈ [\d.,]+|< 0\.00001) ETH to claim$/.test(dm), `farm: the dashboard's farm rewards say what there is to claim, in ETH (${dm})`);
  const before = await tacOf(A0);
  await page.click('#pf-claim');
  await until(page, () => /TAC claimed/.test(document.querySelector('#toast-container')?.textContent || ''));
  ok((await tacOf(A0)) > before, 'farm: claim pays TAC');
  const got = Number((await tacOf(A0)) - before) / 1e18;
  await until(page, () => /Claimed so far/.test(document.querySelector('#farm-precision')?.textContent || ''), null, 180000);
  const shown = parseFloat(((await text(page, '#farm-precision')).match(/Claimed so far\s*([\d.,]+) TAC/) || [])[1]?.replace(/,/g, ''));
  ok(Math.abs(shown - got) <= 0.006 + got * 0.001, `farm: the claim then shows under Claimed so far (${shown} TAC for ${got.toFixed(4)} paid)`);
  await page.waitForSelector('#pf-exit');
  await page.click('#pf-exit');
  await until(page, () => /Withdrawn/.test(document.querySelector('#toast-container')?.textContent || '') || !!document.querySelector('#farm-precision .status .err'));
  ok((await stakedOf(A0)) === 0n, `farm: withdraw all leaves nothing staked ${await text(page, '#pf-status')}`);
});

await step('reinvest', async () => {
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="eth"]', { timeout: 60000 });
  await page.click('[data-pfm="eth"]');
  await page.fill('#pf-amt', '2');
  await acceptLoss(page, '#pf-go', '#pf-ackv');
  if (await page.isDisabled('#pf-go')) throw new Error(`the deposit stayed disabled: ${await text(page, '#pf-rcpt')}`);
  await page.click('#pf-go');
  await page.waitForSelector('#pf-exit', { timeout: 60000 });
  await rpc('evm_increaseTime', [3600]); await rpc('evm_mine', []);
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await until(page, () => { const b = document.querySelector('#pf-reinvest'); return b && !b.disabled; });
  const t0 = await tacOf(A0), s0 = await stakedOf(A0);
  await page.click('#pf-reinvest');
  if (!await chainUntil(async () => (await tacOf(A0)) > t0)) throw new Error('the claim did not pay');
  const got = Number((await tacOf(A0)) - t0) / 1e18;
  await until(page, () => document.querySelector('[data-pfm="tac"]')?.getAttribute('aria-selected') === 'true' && /\d/.test(document.querySelector('#pf-tac')?.value || ''), null, 180000);
  const filled = parseFloat(await page.inputValue('#pf-tac'));
  ok(Math.abs(filled - got) <= 0.006 + got * 0.001, `reinvest: the add form opens on TAC with what was claimed (${filled} of ${got.toFixed(4)})`);
  ok(/ready to farm below/.test(await text(page, '#pf-status')), 'reinvest: and says so');
  await acceptLoss(page, '#pf-go', '#pf-ackv');
  ok(!(await page.isDisabled('#pf-go')), 'reinvest: Farm with TAC is ready');
  await page.click('#pf-go');
  ok(await chainUntil(async () => (await stakedOf(A0)) > s0), 'reinvest: the claimed TAC is staked again');
  await page.waitForSelector('#pf-exit');
  await page.click('#pf-exit');
  await chainUntil(async () => (await stakedOf(A0)) === 0n);
});

await step('buy', async () => {
  await page.goto(url + '#buy');
  if (await page.$('#buy-connect')) await page.click('#buy-connect');
  await page.waitForSelector('#b-amt');
  await page.fill('#b-amt', '0.0005');
  await until(page, () => !document.querySelector('#b-go').disabled, null, 240000);   // a cold fork makes the lens scan slow
  const t0 = await tacOf(A0);
  await page.click('#b-go');
  await until(page, () => /Bought|err/.test(document.querySelector('#b-status')?.innerHTML || ''));
  ok((await tacOf(A0)) > t0, `buy: TAC arrives ${await text(page, '#b-status')}`);
});

await step('tacfarm', async () => {
  if ((await tacOf(A0)) < 100n * 10n ** 18n) await fundTac(A0, 1000n * 10n ** 18n);
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="tac"]', { timeout: 60000 });
  await page.click('[data-pfm="tac"]');
  await page.fill('#pf-tac', '20');
  await acceptLoss(page, '#pf-go', '#pf-ackv');
  const s0 = await stakedOf(A0), t0 = await tacOf(A0);
  await page.click('#pf-go');
  await chainUntil(async () => (await stakedOf(A0)) > s0);
  ok((await stakedOf(A0)) > s0 && t0 - (await tacOf(A0)) <= 20n * 10n ** 18n, `tacfarm: TAC alone staked with a permit ${await text(page, '#pf-status')}`);
  ok((await allowanceOf(TAC, A0, FARM)) === 0n, 'tacfarm: the permit leaves no allowance behind');
  await page.waitForSelector('[data-pfp="50"]');
  await page.click('[data-pfp="50"]'); await page.click('[data-pfr="eth"]');
  await acceptLoss(page, '#pf-exit', '#pf-outv');
  const st1 = await stakedOf(A0), tac1 = await tacOf(A0);
  await page.click('#pf-exit');
  await chainUntil(async () => (await stakedOf(A0)) < st1);
  const st2 = await stakedOf(A0);
  ok(st2 > 0n && st2 * 2n >= st1 - 1n && st2 * 2n <= st1 + 1n && (await tacOf(A0)) <= tac1, `tacfarm: half withdrawn as ETH, half still staked ${await text(page, '#pf-status')}`);
  await rpc('eth_sendTransaction', [{ from: A0, to: FARM, data: '0x2e1a7d4d' + word(st2 / 2n) }]);   // withdraw(shares): LP held, not staked
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await page.waitForSelector('#pf-stake', { timeout: 60000 });
  await page.click('#pf-stake');
  await chainUntil(async () => (await stakedOf(A0)) === st2);
  ok((await stakedOf(A0)) === st2, `tacfarm: LP held is staked again with a permit ${await text(page, '#pf-lp-status')}`);
  await page.waitForSelector('#pf-stake', { state: 'detached', timeout: 120000 });     // the page ignores tab presses until the stake has finished drawing
  await page.waitForSelector('[data-pfp="100"]');
  await page.click('[data-pfp="100"]'); await page.click('[data-pfr="tac"]');
  await acceptLoss(page, '#pf-exit', '#pf-outv');
  const tac2 = await tacOf(A0);
  await page.click('#pf-exit');
  await chainUntil(async () => (await stakedOf(A0)) === 0n);
  ok((await stakedOf(A0)) === 0n && (await tacOf(A0)) > tac2, `tacfarm: exit all as TAC leaves nothing staked ${await text(page, '#pf-status')}`);
});

await step('sell', async () => {
  // A fresh EOA: the anvil keys carry sweeper code on mainnet, which forwards ETH on before a router can count it.
  const key = '0x' + Buffer.from(secp.utils.randomPrivateKey()).toString('hex');
  const who = '0x' + Buffer.from(keccak_256(secp.getPublicKey(key.slice(2), false).slice(1)).slice(12)).toString('hex');
  await rpc('anvil_impersonateAccount', [who]); await rpc('anvil_setBalance', [who, '0x' + (10n ** 17n).toString(16)]);
  await fundTac(who, 100n * 10n ** 18n);
  const r = await openPage({ account: who, key });
  try {
    await r.page.goto(r.url + '#sell');
    await r.page.waitForSelector('#sell-connect, #sl-amt', { timeout: 60000 });
    if (await r.page.$('#sell-connect')) await r.page.click('#sell-connect');
    await r.page.waitForSelector('#sl-amt');
    await r.page.fill('#sl-amt', '25');
    await acceptLoss(r.page, '#sl-go', '#sl-ackv');
    const e0 = BigInt(await rpc('eth_getBalance', [who, 'latest'])), n0 = BigInt(await rpc('eth_getTransactionCount', [who, 'latest']));
    const route = (await text(r.page, '#sl-rcpt')).replace(/\s+/g, ' ');
    await r.page.click('#sl-go');
    await until(r.page, () => /Sold|class="err"/.test(document.querySelector('#sl-status')?.innerHTML || ''), null, 240000);
    ok((await tacOf(who)) === 75n * 10n ** 18n, `sell: 25 TAC sold ${await text(r.page, '#sl-status')}`);
    // The pool that pays most takes the sale, and that moves with the market: through the Precision pool (or a split) the permit rides inside
    // one transaction; through the Tacit pool the TAC is approved for exactly the sale first, a second transaction. Either leaves no allowance.
    const sent = BigInt(await rpc('eth_getTransactionCount', [who, 'latest'])) - n0, viaTacit = /Route\s*Tacit public pool/.test(route);
    ok(sent === (viaTacit ? 2n : 1n) && (await allowanceOf(TAC, who, ZROUTER)) === 0n && (await allowanceOf(TAC, who, '0x00000000E36C7EC997CC59DCda9E03673B448119')) === 0n, `sell: ${viaTacit ? 'the Tacit pool: an approval for the sale, then the sale' : 'one transaction, the permit riding inside it'}, no allowance left (${sent} sent; ${route.match(/Route\s*([^$]*?)(This pool|$)/)?.[1]?.slice(0, 60)})`);
    ok(BigInt(await rpc('eth_getBalance', [who, 'latest'])) > e0, 'sell: ETH arrives, net of gas');
  } finally { await r.browser.close(); await rpc('anvil_stopImpersonatingAccount', [who]); }
});

await step('v1', async () => {
  await page.goto(url + '#private');
  await page.waitForSelector('#eth-v1 [data-in="eth"]', { timeout: 60000 });
  await page.click('#eth-v1 [data-in="eth"]');
  await page.waitForSelector('#w-amt', { timeout: 120000 });
  await page.fill('#w-amt', '0.01');
  await until(page, () => !document.querySelector('#w-go').disabled);
  const n0 = submits.length;
  await page.click('#w-go');
  await until(page, () => /stubbed|failed|err/i.test(document.querySelector('#v1-status')?.innerHTML || ''), null, 1200000);   // two log walks on a cold fork
  ok(submits.slice(n0).some((s) => s.type === 'wrap'), `v1: the tipped deposit landed and its settle was submitted ${(await text(page, '#v1-status')).slice(0, 80)}`);
  ok(/press Finish/i.test(await text(page, '#v1-status')), `v1: a settle that fails after its deposit landed points to Finish, not to another deposit (${(await text(page, '#v1-status')).slice(0, 110)})`);
});

// The relay refuses a wrap's settle outright once its deposit has landed (its free settles for the day are used up):
// the form empties, and the line says why and that the deposit waits for Finish, rather than asking for it again.
await step('v1refuse', async () => {
  const r = await openPage({ account: A0, key: K0 });
  try {
    await r.page.goto(r.url + '#private');
    await r.page.waitForSelector('#eth-v1 [data-in="eth"]', { timeout: 60000 });
    await r.page.click('#eth-v1 [data-in="eth"]');
    await r.page.waitForSelector('#w-amt', { timeout: 120000 });
    refuseSubmits = 1;
    await r.page.fill('#w-amt', '0.01');
    await until(r.page, () => !document.querySelector('#w-go').disabled);
    await r.page.click('#w-go');
    // Where it is, once a minute, so a slow fork reads as slow rather than as a silent timeout.
    const where = setInterval(() => text(r.page, '#v1-status').then((t) => console.log(`     v1refuse … ${t.slice(0, 100)}`), () => {}), 60000);
    try { await until(r.page, () => /Press Finish|not private yet/.test(document.querySelector('#v1-status')?.textContent || ''), null, 1200000); } finally { clearInterval(where); }
    const kept = await text(r.page, '#v1-status');
    ok(/Your deposit is in the Tacit pool/.test(kept) && /free settles for today are used up/.test(kept) && /no need to send it again/.test(kept)
      && await r.page.$eval('#w-amt', (i) => i.value === '') && await r.page.$eval('#w-go', (b) => b.disabled), `v1refuse: a settle the relay refuses after the deposit empties the form and points to Finish (${kept.slice(0, 130)})`);
    ok(await until(r.page, () => !!document.querySelector('#v1-finish'), null, 600000).then(() => true, () => false), 'v1refuse: the deposit is then offered to Finish');
    // Or from the wallet: the relay is asked for the proof only, and settle() goes to the pool from the wallet. The
    // proof is a stand-in here, so the pool refuses it and the page says so; the deposit is still offered after.
    ok(/Or finish from your wallet/.test(await text(r.page, '#v1-finish-self')), 'v1refuse: it can also be finished from the wallet');
    const wrapSub = refused.findLast((x) => x.type === 'wrap');
    proveStub = true;
    const n1 = submits.length, t1 = walletTxs.length, before = await r.page.$eval('#v1-status', (e) => e.innerHTML);
    await r.page.click('#v1-finish-self');
    await until(r.page, (b) => { const h = document.querySelector('#v1-status')?.innerHTML || ''; return h !== b && /class="err"/.test(h); }, before, 600000);
    const prove = submits.slice(n1).find((x) => x.type === 'wrap' && x.op.cx === wrapSub?.op.cx);   // every waiting deposit is finished, this one among them
    const settle = walletTxs.slice(t1).find((x) => String(x.to).toLowerCase() === '0x000000000ed1eabd231be41d93b719056f7febfc');
    ok(prove?.mode === 'prove' && prove.op.cx === wrapSub?.op.cx && prove.op.owner === wrapSub?.op.owner, 'v1refuse: finishing from the wallet asks the relay for this deposit\'s proof only');
    ok(settle && settle.from.toLowerCase() === A0 && settle.data.startsWith('0x' + Buffer.from(keccak_256(Buffer.from('settle(bytes,bytes,bytes[])'))).toString('hex').slice(0, 8)),
      `v1refuse: and sends settle() to the pool from the wallet (${(await text(r.page, '#v1-status')).slice(0, 90)})`);
    // The same from its receipt, once it has waited in line: a receipt as another tab of this page would write it (the
    // page takes in what other tabs write), still queued, for the deposit the scan above found waiting.
    const depositId = depositIdOf(wrapSub.op);
    await r.ctx.route(/\/confidential\/status\?id=stub-inline/, (route) => json(route, { jobId: 'stub-inline', type: 'wrap', mode: 'settle', status: 'pending', txHash: null, error: null, createdAt: Date.now() }));
    await r.page.evaluate((dep) => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k) || '{"items":[]}'), t = Date.now();
      s.items.unshift({ id: 'job:stub-inline', kind: 'job', type: 'wrap', label: 'Finish a 0.01 tETH deposit', status: 'pending', at: t - 120e3, up: t - 120e3, self: { deps: ['d:' + dep] } });
      dispatchEvent(new StorageEvent('storage', { key: k, newValue: JSON.stringify(s) }));
    }, depositId);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await r.page.click('#act'); await r.page.waitForSelector('#sheet-act[open]');
    const inline = () => r.page.evaluate(() => document.querySelector('[data-act="job:stub-inline"]')?.textContent.replace(/\s+/g, ' ').trim() || '');
    const offered = await until(r.page, () => /Finish it from your wallet/.test(document.querySelector('[data-act="job:stub-inline"]')?.textContent || ''), null, 60000).then(() => true, () => false);
    ok(offered, `v1refuse: a deposit's receipt in line offers to finish it from the wallet (${(await inline()).slice(0, 160)})`);
    const t2 = walletTxs.length;
    if (offered) {
      await r.page.click('[data-act="job:stub-inline"] [data-self]');
      await until(r.page, () => !!document.querySelector('[data-act="job:stub-inline"] .actr-f.err'), null, 600000).catch(() => {});
      ok(walletTxs.slice(t2).some((x) => String(x.to).toLowerCase() === '0x000000000ed1eabd231be41d93b719056f7febfc'), `v1refuse: pressed, it proves and sends from the wallet, and a refusal shows on the receipt (${(await inline()).slice(0, 160)})`);
    }
    if (offered) {
      // From an account that cannot pay the network fee, the receipt says so before the relay is asked to prove anything.
      await rpc('anvil_setBalance', [A0, '0x0']);
      try {
        const n3 = submits.length, btn = await r.page.$('[data-act="job:stub-inline"] [data-self]');
        if (btn) await btn.click();
        const said = btn ? await until(r.page, () => /pays the network fee/.test(document.querySelector('[data-act="job:stub-inline"]')?.textContent || ''), null, 60000).then(() => true, () => false) : false;
        ok(!!btn && said && submits.length === n3, `v1refuse: an account that cannot pay the network fee is told so before the relay is asked to prove (${(await inline()).slice(0, 120)})`);
      } finally { await rpc('anvil_setBalance', [A0, '0x' + (10000n * 10n ** 18n).toString(16)]); }
    }
    if (r.errors.length) { fails++; console.log('FAIL v1refuse page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

await step('devsend', async () => {
  await page.goto(url + '#device');
  if (await page.$('#eth-dev [data-in="eth"]')) await page.click('#eth-dev [data-in="eth"]');
  await page.waitForSelector('[data-dev="send"]', { timeout: 60000 });
  await page.click('[data-dev="receive"]');
  // The form waits for the pool's replay (in a worker); when it does not come, the line it is stuck on says so.
  await page.waitForSelector('#d-form [data-copy]', { timeout: 120000 }).catch(async (e) => { console.log('     d-form says: ' + (await page.evaluate(() => (document.querySelector('#d-form')?.textContent || 'no #d-form').replace(/\s+/g, ' ').slice(0, 300)))); throw e; });
  const recv = await page.evaluate(() => ({ bp1: document.querySelector('#d-form [data-copy^="bp1"]')?.dataset.copy, tacit: document.querySelector('#d-form [data-copy^="tacit1"]')?.dataset.copy, ask: document.querySelector('#d-form a[href^="/pay/eth/#receive"]')?.getAttribute('href') }));
  ok(/^bp1/.test(recv.bp1 || '') && /^\/pay\/eth\/#receive&chain=\d+$/.test(recv.ask || ''), `devsend: Receive keeps the pool and deposit addresses here, and asks for an amount in tacit pay (${recv.ask}; pool address ${String(recv.bp1).slice(0, 8)}, Tacit address ${String(recv.tacit).slice(0, 8)})`);
  // Paying from this balance is tacit pay's (tools/pay-check.mjs covers it): the tab opens it on the same chain.
  await page.click('[data-dev="send"]');
  const links = await page.$$eval('#d-form a', (as) => as.map((a) => a.getAttribute('href')));
  ok(links.some((h) => /^\/pay\/eth\/#send&chain=\d+$/.test(h)) && links.some((h) => /^\/pay\/eth\/#link&chain=\d+$/.test(h)), `devsend: Send opens tacit pay on this chain (${links.join(', ')})`);
});

await step('device', async () => {
  await page.goto(url + '#device');
  if (await page.$('#eth-dev [data-in="eth"]')) await page.click('#eth-dev [data-in="eth"]');
  await page.waitForSelector('[data-chain="1"]', { timeout: 60000 });
  await page.click('[data-chain="1"]');
  await page.waitForSelector('#d-amt', { timeout: 60000 });
  // Paying from this balance is tacit pay's: the Send tab opens it on the chain picked here.
  await page.click('[data-dev="send"]');
  const hl = await page.$$eval('#d-form a', (as) => as.map((a) => a.getAttribute('href')));
  ok(['/pay/eth/#send&chain=1', '/pay/eth/#link&chain=1'].every((h) => hl.includes(h)), `device: Send opens tacit pay on the chain picked here (${hl.join(' ')})`);
  // DEV.mode (the sub-tab) persists across sheet reopens, a deliberate feature: a scenario run right after devsend
  // (which leaves it on Send) must not inherit that here.
  await page.click('[data-dev="deposit"]');
  await page.waitForFunction(() => /Deposit/.test(document.querySelector('#d-go')?.textContent || ''));
  await page.fill('#d-amt', '0.01');
  await page.click('#d-go');
  await until(page, () => /Deposited|err/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  await shot(page, 'device');
  ok(/Deposited/.test(await text(page, '#d-status')), `device: proved here and deposited ${(await text(page, '#d-status')).slice(0, 60)}`);
});

await step('borrow', async () => {
  await page.goto(url + '#borrow');
  await page.waitForSelector('#bw-lock, #borrow-body [data-in="eth"]', { timeout: 60000 });
  if (await page.$('#borrow-body [data-in="eth"]')) { await page.click('#borrow-body [data-in="eth"]'); await page.waitForSelector('#bw-lock', { timeout: 120000 }); }
  ok(/^bc1q/.test(await page.$eval('#borrow-body [data-copy]', (b) => b.dataset.copy)), 'borrow: the Bitcoin deposit address renders');
  const lag = await page.$eval('#borrow-body', (e) => (e.textContent.match(/It is at block [\d,]+, [\d,]+ behind Bitcoin( and catching up)?\./) || [''])[0]);
  ok(/at block [\d,]+, [\d,]+ behind Bitcoin/.test(lag), `borrow: before a lock, it says how far behind Bitcoin's proof is (${lag.slice(0, 90)})`);
  const pub = await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('tacit-eth-identity-anchor:'))));
  await page.evaluate((p) => localStorage.setItem(`tacit-lite-cbtc-v1:${p}`, JSON.stringify({ lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: '20000', anchor: { txid: 'bb'.repeat(32), vout: 0 }, at: Date.now() })), pub);
  await page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
  await page.waitForSelector('#bw-bond', { timeout: 120000 });
  await page.click('#bw-bond');
  await until(page, () => /Bond posted/.test(document.querySelector('#toast-container')?.textContent || '') || /err/.test(document.querySelector('#bw-status')?.innerHTML || ''));
  await shot(page, 'borrow');
  ok(/Bond posted/.test(await text(page, '#toast-container')), `borrow: the bond posts through the helper ${await text(page, '#bw-status')}`);
  const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', wst = async (x) => BigInt(await rpc('eth_call', [{ to: WSTETH, data: '0x70a08231' + addrWord(x) }, 'latest']));
  await page.waitForSelector('[data-bond-take]', { timeout: 120000 });
  ok(/not minted yet, can come back/.test(await text(page, '#bw-bonds')), `borrow: the bond shows under Your bonds as one that can come back (${(await text(page, '#bw-bonds')).slice(0, 120)})`);
  const w0 = await wst(A0);
  await page.click('[data-bond-take]');
  await chainUntil(async () => (await wst(A0)) > w0, 120000);
  ok((await wst(A0)) > w0, `borrow: a bond on a lock not minted comes back to the account that posted it ${await text(page, '#bw-status')}`);
});

await step('hxborrow', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const p = r.page, WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', wst = async (x) => BigInt(await rpc('eth_call', [{ to: WSTETH, data: '0x70a08231' + addrWord(x) }, 'latest']));
  const card = async () => (await text(p, '#hx-bw')).replace(/\s+/g, ' ');
  try {
    // wstETH held by the paying account: ETH sent to wstETH stakes it and mints wstETH back.
    await chainUntil(async () => !!(await rpc('eth_sendTransaction', [{ from: A0, to: WSTETH, value: '0x' + (5n * 10n ** 16n).toString(16) }])), 60000);
    const w0 = await wst(A0);
    await p.goto(r.url + '#borrow');
    await p.waitForSelector('#bw-lock, #borrow-body [data-in="eth"]', { timeout: 60000 });
    if (await p.$('#borrow-body [data-in="eth"]')) { await p.click('#borrow-body [data-in="eth"]'); await p.waitForSelector('#bw-lock', { timeout: 120000 }); }
    const pub = await p.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('tacit-eth-identity-anchor:'))));
    await p.evaluate((x) => localStorage.setItem(`tacit-lite-cbtc-v1:${x}`, JSON.stringify({ lockTxid: 'cd'.repeat(32), lockVout: 1, vBtc: '20000', anchor: { txid: 'ce'.repeat(32), vout: 0 }, at: Date.now() })), pub);
    // The page read this key's locks before the record was seeded: the sheet, opened again, reads them again (as a lock made in another tab is found).
    await p.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await p.waitForSelector('#bw-bond, #bw-topup', { timeout: 120000 });
    await p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
    await p.click('[data-hxm="borrow"]');
    await until(p, () => !!document.querySelector('#hx-bw [data-hxbw="bond-wst"]'), null, 300000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${await card().catch(() => '?')} | ${await text(p, '#hx-have').catch(() => '')}`); });
    const c0 = await card();
    ok(/Your lock\s*0\.0002 BTC/.test(c0) && /✓\s*Lock\s*2\s*Bond\s*3\s*Mint\s*4\s*Borrow/.test(c0) && /Locked\s*0\.0002 BTC/.test(c0) && /At your Bitcoin address/.test(c0),
      `hxborrow: the Borrow tab follows the lock, at its bond, with what the key holds (${c0.slice(0, 200)})`);
    ok(/Post bond with [\d.]+ wstETH/.test(c0) && /Or with [\d.]+ ETH/.test(c0), 'hxborrow: wstETH already held is offered as the bond, ETH as the other way');
    await p.click('#hx-bw [data-hxbw="bond-wst"]');
    await until(p, () => /Bond posted/.test(document.querySelector('#hx-bw-s')?.textContent || '') || /err/.test(document.querySelector('#hx-bw-s')?.innerHTML || ''), null, 300000);
    ok(/Bond posted/.test(await text(p, '#hx-bw-s')) && (await wst(A0)) < w0, `hxborrow: the bond posts from the card in wstETH, by a permit in the same transaction (${(await text(p, '#hx-bw-s')).slice(0, 100)}; wstETH ${w0} → ${await wst(A0)})`);
    await until(p, () => /✓\s*Lock\s*✓\s*Bond\s*3\s*Mint/.test(document.querySelector('#hx-bw')?.textContent || ''), null, 300000);
    ok(/Waiting for/.test(await card()), `hxborrow: with the bond in, the lock waits to mint, and says for what (${(await card()).match(/Waiting for[^.]*\./)?.[0] || ''})`);
    if (r.errors.length) { fails++; console.log('FAIL hxborrow page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('hxborrowback', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const p = r.page, hash = '0x' + 'be'.repeat(32);
  // As the page left it: the bond's transaction sent and not yet landed (a hash no node knows, so it stays on its way).
  await p.addInitScript((h) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('tacit-lite-activity-v1', JSON.stringify({ items: [{ id: `tx:1:${h}`, kind: 'tx', label: 'Post the bond for 0.0002 BTC', chain: 1, hash: h, status: 'pending', at: Date.now() }] })); } }, hash);
  try {
    await p.goto(r.url + '#borrow');
    await p.waitForSelector('#bw-lock, #borrow-body [data-in="eth"]', { timeout: 60000 });
    if (await p.$('#borrow-body [data-in="eth"]')) { await p.click('#borrow-body [data-in="eth"]'); await p.waitForSelector('#bw-lock', { timeout: 120000 }); }
    const pub = await p.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('tacit-eth-identity-anchor:'))));
    await p.evaluate((x) => localStorage.setItem(`tacit-lite-cbtc-v1:${x}`, JSON.stringify({ lockTxid: 'cf'.repeat(32), lockVout: 1, vBtc: '20000', anchor: { txid: 'c0'.repeat(32), vout: 0 }, at: Date.now() })), pub);
    await p.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await p.waitForSelector('#bw-bond, #bw-topup', { timeout: 120000 });
    await p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
    await p.click('[data-hxm="borrow"]');
    await until(p, () => /Your bond is on its way/.test(document.querySelector('#hx-bw')?.textContent || ''), null, 300000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(p, '#hx-bw').catch(() => '?')).replace(/\s+/g, ' ').slice(0, 200)}`); });
    ok(!(await p.$('#hx-bw [data-hxbw^="bond"], #hx-bw [data-hxbw="topup"]')) && !!(await p.$('#hx-bw [data-act-open]')), 'hxborrowback: a bond still on its way is said in place of its button, with the way to follow it');
    ok(!(await p.$('[data-hxm="borrow"][data-due]')), `hxborrowback: and the tab does not call for it (${await p.$eval('#hx-bw', (e) => e.textContent.replace(/\s+/g, ' ').slice(0, 160))})`);
    await p.click('[data-hxm="private"]');
    await until(p, () => !!document.querySelector('#dash [data-dash-open="borrow"]'), null, 120000);
    await p.click('#dash [data-dash-open="borrow"]');
    await until(p, () => document.querySelector('[data-hxm="borrow"]')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('#hx-bw'), null, 60000);
    ok(!(await p.$('dialog.sheet[open]')), "hxborrowback: the dashboard's cBTC opens the card's Borrow tab, where the lock is followed");
    if (r.errors.length) { fails++; console.log('FAIL hxborrowback page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// A bond whose lock the pool records as minted on and then spent on Bitcoin (the pool's own flags for a fixture lock,
// set on the fork) is forfeit: the dashboard says so, the borrow sheet shows it with no way to take it back, and the
// dashboard's notice clears once the sheet has shown it.
await step('bonds', async () => {
  const HELPER = '0x000000008eCD09f922C9FbbDD9ACA5aE8F0beBfA', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
  const OP = Buffer.from(keccak_256(Buffer.concat([Buffer.from('cd'.repeat(32), 'hex'), Buffer.from([1, 0, 0, 0])]))).toString('hex');
  const slot = (n) => '0x' + Buffer.from(keccak_256(Buffer.from(OP + word(n), 'hex'))).toString('hex');
  const flag = (n, v) => rpc('anvil_setStorageAt', [POOL, slot(n), '0x' + word(v)]);   // 123 lock sats, 125 spent, 127 minted
  const h = await rpc('eth_sendTransaction', [{ from: A0, to: HELPER, data: '0xc0e2d9a1' + OP, value: '0x' + (10n ** 15n).toString(16) }]);
  await chainUntil(async () => (await rpc('eth_getTransactionReceipt', [h]))?.status === '0x1', 60000);
  await flag(123, 20000); await flag(127, 1); await flag(125, 1);
  try {
    // The same key the borrow step opened, reopened from the wallet sheet if the reload closed it (the borrow sheet would
    // mark the forfeit seen before the dashboard could show it).
    await page.goto(url + '#wallet');
    await page.reload();                                             // a new page: nothing read before the flags were set
    await page.waitForSelector('#wallet-body [data-in], #wallet-dot.on', { state: 'attached', timeout: 60000 });
    if (!(await page.$('#wallet-dot.on'))) {
      await page.click((await page.$('#wallet-body [data-in="known"]')) ? '#wallet-body [data-in="known"]' : '#wallet-body [data-in="eth"]');
      await until(page, () => !!document.querySelector('#wallet-dot.on'), null, 60000);
    }
    await page.keyboard.press('Escape');
    const due = () => page.evaluate(() => document.querySelector('#dash-due')?.textContent || '');
    await until(page, () => /spent on Bitcoin before its cBTC was redeemed/.test(document.querySelector('#dash-due')?.textContent || ''), null, 120000)
      .catch(async () => { throw new Error(`no forfeit notice on the dashboard (${(await due()).slice(0, 160)})`); });
    ok(/insurance reserve/.test(await due()), 'bonds: the dashboard says a bond was forfeit, and where it goes');
    // Announced once, as a toast, when first read (which may have been just before the reload): recorded as told.
    const told = await page.evaluate((op) => Object.keys(localStorage).filter((k) => k.startsWith('tacit-lite-bonds-seen-v1:'))
      .some((k) => (JSON.parse(localStorage.getItem(k))?.ids || []).includes(`lost:0x${op}`)), OP);
    ok(told, 'bonds: the forfeit is announced once when it is first seen');
    await page.click('[data-dash-do="bonds"]');
    await until(page, () => /forfeit/.test(document.querySelector('#bw-bonds')?.textContent || ''), null, 120000);
    ok(/was spent on Bitcoin before its cBTC was redeemed/.test(await text(page, '#bw-bonds .callout.bad')), 'bonds: the borrow sheet shows the forfeit bond with a notice');
    await page.$eval('#bw-bonds', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(page, 'bonds');
    ok(!(await page.$(`[data-bond-take^="0x${OP}"]`)), 'bonds: a forfeit bond offers no take-back');
    await page.keyboard.press('Escape');
    await until(page, () => !/spent on Bitcoin before its cBTC was redeemed/.test(document.querySelector('#dash-due')?.textContent || ''), null, 30000).catch(() => {});
    ok(!/spent on Bitcoin before its cBTC was redeemed/.test(await due()), 'bonds: once the sheet has shown it, the dashboard stops pointing at it');
  } finally {
    // The fixture lock goes back to never recorded, and the wallet takes its bond back.
    await flag(125, 0); await flag(127, 0); await flag(123, 0);
    await rpc('eth_sendTransaction', [{ from: A0, to: HELPER, data: '0xc5211d27' + OP }]);
  }
});

// tacit.finance's own Borrow tab: a pending cBTC lock asks for its bond, the bond posts through the escrow helper from
// the wallet's Tacit account, the row waits for the reflection, and once the pool records the lock it offers the mint.
const { makeEvmAccount } = await import(new URL('../dapp/evm-account.js', import.meta.url));
await step('mainbond', async () => {
  const r = await openPage({ account: A0, key: K0 });
  // The lock sits in Bitcoin block 971295 with the tip at 971306: 15 blocks short of the 26 the reflection needs.
  await r.ctx.route(/\/tx\/a{64}\/status$/, (route) => json(route, { confirmed: true, block_height: 971295, block_hash: '00'.repeat(32), block_time: 1790000000 }));
  await r.ctx.route(/\/blocks\/tip\/height$/, (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '971306' }));
  const root = r.url + 'classic.html', hex = 'bd'.padEnd(64, '5'), pass = 'correct horse battery staple';
  const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';
  const OP = Buffer.from(keccak_256(Buffer.concat([Buffer.from('aa'.repeat(32), 'hex'), Buffer.from([1, 0, 0, 0])]))).toString('hex');
  const call = async (to, data) => BigInt(await rpc('eth_call', [{ to, data }, 'latest']));
  const row = () => r.page.evaluate(() => [document.querySelector('.cbtc-step[data-i="0"]')?.textContent || '', document.querySelector('.cbtc-mint-pending-btn[data-i="0"]')?.textContent || '']);
  const rowIs = (re, timeout = 120000) => until(r.page, (s) => new RegExp(s).test(document.querySelector('.cbtc-step[data-i="0"]')?.textContent || ''), re.source, timeout);
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#toast-container', { state: 'attached' });
    const saving = r.page.evaluate(async (h) => { globalThis.__TACIT_NO_INIT__ = true; const T = await import('/tacit.js'); await T.wallet.setPriv(h); }, hex);
    await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
    await r.page.fill('#pass-input-1', pass); await r.page.fill('#pass-input-2', pass); await r.page.click('#pass-submit');
    await saving;
    const lock = { lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: '20000', blinding: '0x' + '11'.repeat(32) };
    await r.page.evaluate((l) => { localStorage.setItem('tacit-active-mode-v1', 'local'); localStorage.setItem('tacit-cbtc-pending-locks-v1', JSON.stringify([l])); }, lock);
    const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
    await rpc('anvil_setBalance', [acct, '0x0']);                  // funded only once the tab has said how
    await r.page.goto(root);
    await r.page.waitForSelector('#toast-container', { state: 'attached' });
    await until(r.page, () => !!document.querySelector('[data-tab="cdp"]'));
    // Unlock the saved key through tacit.finance's own wallet. The page evaluates a second copy of tacit.js
    // (amm-farm-ui.js imports it by bare path) and the tabs are wired by whichever copy set up last, so both unlock.
    const unlocked = [];
    for (const which of ['entry', 'bare']) {
      const unlocking = r.page.evaluate(async (w) => {
        const src = w === 'entry' ? document.querySelector('script[type="module"][src*="tacit.js"]').src : new URL('/tacit.js', location.href).href;
        const T = await import(src);
        if (!T.wallet.priv) await T.wallet.load(null);
        return !!T.wallet.priv;
      }, which).catch((e) => e.message);
      if (await r.page.waitForSelector('#pass-modal #pass-input-1', { state: 'visible', timeout: 60000 }).then(() => true, () => false)) {
        await r.page.fill('#pass-input-1', pass); await r.page.click('#pass-submit');
      }
      unlocked.push(await unlocking);
    }
    ok(unlocked.every((u) => u === true), `mainbond: the saved key unlocks in tacit.finance (${unlocked.join(', ')})`);
    const toTab = async (name) => {
      await until(r.page, (n) => typeof document.querySelector(`.tab[data-tab="${n}"]`)?.onclick === 'function', name, 120000);
      await r.page.evaluate((n) => document.querySelector(`.tab[data-tab="${n}"]`).click(), name);
    };
    const toBorrow = () => toTab('cdp');
    await toBorrow();
    await rowIs(/Needs its bond|price feed|Could not/);
    let [s, b] = await row();
    const fundLine = await r.page.evaluate(() => document.querySelector('.cbtc-fund[data-i="0"]')?.textContent || '');
    const off = () => r.page.$eval('.cbtc-mint-pending-btn[data-i="0"]', (x) => x.disabled);
    ok(/holds 0 ETH\. Top it up from a connected wallet[^]*send it at least [\d.]+ ETH on Ethereum/.test(s) && fundLine.toLowerCase().includes(acct.toLowerCase()) && b === 'Top up from wallet' && !(await off()),
      `mainbond: an unfunded Tacit account is named, with a top-up from the connected wallet (${s} | ${fundLine.trim()} [${b}])`);
    // One click: the connected wallet (anvil's first account) sends the shortfall, then the bond posts from the Tacit account.
    await r.page.click('.cbtc-mint-pending-btn[data-i="0"]');
    await rowIs(/Bonded\.|Needs its bond/, 180000).catch(() => {});
    await chainUntil(async () => (await call(ENGINE, '0xe06e89c9' + OP)) > 0n, 120000).catch(() => {});
    const [total, need] = await Promise.all([call(ENGINE, '0xe06e89c9' + OP), call(ENGINE, '0x034448ed' + word(20000))]);
    ok(need > 0n && total >= need, `mainbond: the bond is posted for the lock from the Tacit account (${total} of ${need} wstETH wei) ${await text(r.page, '#cdp-cbtc-status')}`);
    await until(r.page, () => /not minted yet, can come back/.test(document.querySelector('#cdp-cbtc-bonds')?.textContent || ''), null, 120000).catch(() => {});
    const bondsTxt = (await text(r.page, '#cdp-cbtc-bonds')).replace(/\s+/g, ' ');
    ok(/not minted yet, can come back/.test(bondsTxt) && !!(await r.page.$('#cdp-cbtc-bonds .cbtc-bond-take')), `mainbond: the Borrow tab lists the bond, with a way to take it back (${bondsTxt.slice(0, 140)})`);
    await rowIs(/Bonded\./);
    [s, b] = await row();
    ok(/Your lock is in Bitcoin block 971295[^]*Minting opens once the reflection records it: about 15 more Bitcoin blocks \(about 2\.5 hours\)/.test(s) && b === 'Waiting', `mainbond: then it waits for the reflection and says where the lock is and how long (${s} [${b}])`);
    // The reflection records the lock (cbtcLockVBtc, declaration slot 123): the row then offers the mint.
    await rpc('anvil_setStorageAt', [POOL, '0x' + Buffer.from(keccak_256(Buffer.from(OP + word(123), 'hex'))).toString('hex'), '0x' + word(20000)]);
    await toTab('market');
    await toBorrow();
    await rowIs(/Recorded and bonded/);
    [s, b] = await row();
    ok(b === 'Mint', `mainbond: once the pool records the lock, the row offers the mint (${s} [${b}])`);
    if (r.errors.length) { fails++; console.log('FAIL mainbond page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } catch (e) {
    await shot(r.page, 'mainbond-fail');
    const at = await r.page.evaluate(() => ({ loaded: performance.getEntriesByType('resource').map((x) => x.name).filter((n) => /\/tacit\.js/.test(n)),
      pending: document.querySelector('#cdp-cbtc-pending')?.textContent.replace(/\s+/g, ' ').slice(0, 200) ?? 'absent',
      status: document.querySelector('#cdp-cbtc-status')?.textContent.slice(0, 160),
      cdpTail: (document.querySelector('#cdp-body')?.textContent || '').replace(/\s+/g, ' ').slice(-260) })).catch(() => null);
    throw new Error(`${e.message.split('\n')[0]} | page ${JSON.stringify(at)} | errors ${r.errors.slice(0, 2).join(' | ')}`);
  } finally { await r.browser.close(); }
});

// Weld follows every lock a key made, found from its Bitcoin history alone (so a lock made on tacit.finance or another
// device counts): the tile names the next step, the sheet opens on the oldest lock still to mint, lists the others, and
// can make another. Esplora is stubbed to show two locks paying the key's lock script.
const { makeBtcHistoryProvider } = await import(new URL('../dapp/confidential-recovery-btc.js', import.meta.url));
await step('locks', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'feed'.padEnd(64, '9');
  const spk = makeBtcHistoryProvider({ sha256, fetchImpl: async () => ({ ok: false }) }).walletScripts(hex).lock;
  const lockHex = Buffer.from(spk).toString('hex'), sh = Buffer.from(sha256(spk)).toString('hex');
  const lockTx = (id, commit, value, time) => ({ txid: id.repeat(32), vin: [{ txid: commit.repeat(32), vout: 0 }], status: { confirmed: true, block_time: time, block_height: 968900 },
    vout: [{ scriptpubkey: '0014' + '00'.repeat(20), value: 1000 }, { scriptpubkey: lockHex, value }] });
  const history = [lockTx('b2', 'c2', 30000, 1_790_600_000), lockTx('b1', 'c1', 20000, 1_790_500_000)];     // newest first, as esplora serves
  for (const base of ['https://mempool.space/api', 'https://blockstream.info/api', 'https://mempool.emzy.de/api']) {
    await r.ctx.route(`${base}/scripthash/${sh}/txs**`, (route) => json(route, route.request().url().includes('/chain/') ? [] : history));
    for (const c of ['c1', 'c2']) await r.ctx.route(`${base}/tx/${c.repeat(32)}`, (route) => json(route, { txid: c.repeat(32), vin: [{ txid: `a${c[1]}`.repeat(32), vout: 0 }] }));
  }
  const body = () => r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' '));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await until(r.page, () => /BTC locked · post its bond/.test(document.querySelector('#dash-g')?.textContent || ''), null, 120000).catch(() => {});
    const foot = await text(r.page, '#dash-g');
    ok(/0\.0002\d* BTC locked · post its bond/.test(foot), `locks: the dashboard names the lock's next step (${foot.slice(0, 160)})`);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await r.page.waitForSelector('#borrow-body [data-pick]', { timeout: 120000 });
    const b = await body();
    ok(/0\.0002\d* BTC in your own output/.test(b) && /Your locks/.test(b) && /post its bond · shown above/.test(b), `locks: the sheet opens on the oldest lock still to mint and lists the others (${b.slice(0, 120)})`);
    ok(!!(await r.page.$('#borrow-body details.lockmore #bw-lock')), 'locks: another lock can be made from the sheet');
    ok(!!(await r.page.$('#bw-bond, #bw-topup')), 'locks: the lock it follows offers its bond');
    await until(r.page, () => /Paid from your (Tacit account|wallet)[^]*?\d ETH/.test(document.querySelector('#borrow-body')?.textContent || ''), null, 60000).catch(() => {});
    const bt = await body(), short = !!(await r.page.$('#bw-topup'));
    ok(/Paid from your (Tacit account|wallet)/.test(bt) && (short ? /Top up your Tacit account from a connected wallet/.test(bt) && !(await r.page.$('#bw-bond')) : !(await r.page.$eval('#bw-bond', (x) => x.disabled))),
      `locks: the bond names the account that pays and what it holds, and offers a top-up when short (${(bt.match(/Paid from.{0,60}?ETH/) || [''])[0]}${short ? ' · Top up from wallet' : ''})`);
    await r.page.click('#borrow-body [data-pick]');
    await until(r.page, () => /0\.0003\d* BTC in your own output/.test((document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ')), null, 60000).catch(() => {});
    ok(/0\.0003\d* BTC in your own output/.test(await body()), 'locks: Show opens the other lock');
    // An empty Tacit account: the connected wallet tops it up and the bond posts from the Tacit account, in one click.
    if (await r.page.waitForSelector('#bw-topup', { timeout: 60000 }).then(() => true, () => false)) {
      await r.page.click('#bw-topup');
      await until(r.page, () => /Bond posted/.test([...document.querySelectorAll('#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4')].map((e) => e.textContent).join(' ')) || /error|could not|reverted/i.test([...document.querySelectorAll('#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4')].map((e) => e.textContent).join(' ')), null, 180000).catch(() => {});
      ok(/Bond posted/.test(await bwText(r.page)), `locks: Top up from wallet funds the Tacit account and posts the bond (${(await bwText(r.page)).trim().slice(0, 120)})`);
    } else ok(false, 'locks: an empty Tacit account offers Top up from wallet');
    if (r.errors.length) { fails++; console.log('FAIL locks page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// A loan taken against a lock is repaid from weld itself: the step shows what repaying burns and offers Repay and close,
// which says so plainly when the loan is not on chain yet (here: a record of a loan the fork has never seen).
await step('repay', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'be11'.padEnd(64, '7'), pub = Buffer.from(secp.getPublicKey(hex, true)).toString('hex');
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate((p) => localStorage.setItem(`tacit-lite-cbtc-v1:${p}`, JSON.stringify({ lockTxid: 'ab'.repeat(32), lockVout: 1, vBtc: '20000',
      anchor: { txid: 'cd'.repeat(32), vout: 0 }, at: Date.now(), minted: true, borrowed: '800000000', borrowedAt: Date.now() })), pub);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await r.page.waitForSelector('#bw-repay', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ').slice(0, 260)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    const note = await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' '));
    ok(/Repaying burns 8(\.00)? cUSD you hold privately and returns the cBTC/.test(note), `repay: the loan step says what repaying burns (${(note.match(/Repaying burns[^.]*\./) || [''])[0]})`);
    await r.page.click('#bw-repay');
    await until(r.page, () => /not visible on chain yet|not on chain yet/.test([...document.querySelectorAll('#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4')].map((e) => e.textContent).join(' ')), null, 60000).catch(() => {});
    ok(/not visible on chain yet|not on chain yet/.test(await bwText(r.page)), `repay: before the loan is on chain it says so (${await bwText(r.page)})`);
    if (r.errors.length) { fails++; console.log('FAIL repay page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The tacit1 address of a key, derived the way tacit.finance does (BIP-352 scan key, one root).
const { makeTacitAddress } = await import(new URL('../dapp/tacit-address.js', import.meta.url));
const { bip352TaggedHash } = await import(new URL('../dapp/bip352.js', import.meta.url));
function tacit1(hex) {
  const priv = Buffer.from(hex, 'hex');
  const scan = BigInt('0x' + Buffer.from(bip352TaggedHash('BIP0352/ScanKey', priv)).toString('hex')) % secp.CURVE.n;
  const pub = secp.getPublicKey(priv, true);
  return makeTacitAddress({ secp }).encodeTacitAddress({ network: 'mainnet', btcSpendPub: pub, btcScanPub: secp.getPublicKey(scan.toString(16).padStart(64, '0'), true), evmOwnerPub: pub });
}
// The address the page shows for a key: the unified one, with the pool lane (flags 0x85).
const { unifiedAddress } = await import(new URL('../dapp/tacit-unified.js', import.meta.url));
const shownAddress = (hex) => unifiedAddress(hex).address;
const walletText = (p) => p.evaluate(() => document.querySelector('#wallet-body')?.textContent.replace(/\s+/g, ' ') || '');
// Open the wallet sheet by changing the hash; a navigation to the same URL would reload and drop the key.
const toWallet = (p) => p.evaluate(() => { location.hash = ''; location.hash = '#wallet'; });
const shown = async (p) => { await toWallet(p); await p.waitForSelector('#wallet-body .who, #wallet-body [data-in]', { timeout: 60000 }); return walletText(p); };
const lock = async (p) => { await toWallet(p); await p.waitForSelector('#w-lock', { timeout: 60000 }); await p.click('#w-lock'); await p.waitForSelector('#wallet-body [data-in]'); };
const addrIn = (txt) => (txt.match(/tacit1[0-9a-z]{8}…[0-9a-z]{12}/) || [''])[0];

await step('csend', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'c5e4d'.padEnd(64, '3');
  // The page's pool module, with private cUSD and cBTC notes added to what the key's balance finds.
  const CUSD = '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d', CBTC = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const note = (asset, value, i) => ({ asset, value: String(value), leafIndex: 900000 + i, cx: '0x' + String(i).repeat(64).slice(0, 64), cy: '0x01', owner: '0x02' });
      const add = [note('${CUSD}', 2500000000n, 1), note('${CUSD}', 300000000n, 2), note('${CBTC}', 50000n, 3)];
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, ...add];
        for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await r.page.waitForSelector('#bw-send:not([hidden]) #cs-to', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ').slice(-300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    const chips = await r.page.$$eval('#bw-send [data-cs]', (b) => b.map((x) => x.textContent));
    ok(chips.join(',') === 'cBTC,cUSD', `csend: private cBTC and cUSD are both offered (${chips.join(', ')})`);
    await r.page.click('#bw-send [data-cs="cusd"]');
    await r.page.waitForSelector('#cs-max');
    ok(/Private 28(\.00)? cUSD/.test(await text(r.page, '#cs-max')), `csend: the cUSD balance is the notes' sum (${await text(r.page, '#cs-max')})`);
    await r.page.fill('#cs-to', tacit1('abc'.padEnd(64, '9')));
    await r.page.fill('#cs-amt', '15');                           // clears the claim's relay fee at today's gas, and fits with a split
    // The relay-fee quote prices proving through zQuoter, whose DEX reads a cold fork fetches slot by slot: well over a minute.
    await until(r.page, () => /They get about/.test(document.querySelector('#cs-rcpt')?.textContent || '') && !document.querySelector('#cs-go').disabled, null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | preview: ${(await text(r.page, '#cs-rcpt')).replace(/\s+/g, ' ')} | status: ${await text(r.page, '#bw-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(true, `csend: a tacit1 recipient is quoted privately (${(await text(r.page, '#cs-rcpt')).replace(/\s+/g, ' ').trim()})`);
    await r.page.fill('#cs-to', '0x000000000000000000000000000000000000dEaD');
    await until(r.page, () => /Arrives[^]*tacUSD/.test(document.querySelector('#cs-rcpt')?.textContent || '') && !document.querySelector('#cs-go').disabled, null, 60000);
    ok(/Relay fee/.test(await text(r.page, '#cs-rcpt')), `csend: an 0x recipient gets it as tacUSD, fee first (${(await text(r.page, '#cs-rcpt')).replace(/\s+/g, ' ').trim()})`);
    // Out to an account this key deposits from: it goes, and the page says it links the two.
    const own = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
    await r.page.fill('#cs-to', own);
    await until(r.page, () => /one of your own accounts/.test(document.querySelector('#cs-rcpt')?.textContent || ''), null, 60000).catch(() => {});
    ok(/one of your own accounts/.test(await text(r.page, '#cs-rcpt')) && !(await r.page.$eval('#cs-go', (b) => b.disabled)), 'csend: paying out to an own account says it links them, and still allows it');
    await r.page.fill('#cs-amt', '100');
    await until(r.page, () => /More than your private balance/.test(document.querySelector('#cs-rcpt')?.textContent || ''), null, 60000);
    ok(await r.page.$eval('#cs-go', (b) => b.disabled), 'csend: more than the private balance is refused');
    await r.page.click('#bw-send [data-cs="cbtc"]');
    await until(r.page, () => /Private 0\.0005 cBTC/.test(document.querySelector('#cs-max')?.textContent || ''), null, 30000);
    ok(true, `csend: switching to cBTC shows its balance (${await text(r.page, '#cs-max')})`);
    if (r.errors.length) { fails++; console.log('FAIL csend page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('shield', async () => {
  const hex = '5411d'.padEnd(64, '3');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await fundTac(acct, 40n * 10n ** 18n);
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 17n).toString(16)]);   // gas for the router wrap's own transaction
  const r = await openPage({ account: A0, key: K0 });
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-shield #tsh-go', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | bal: ${(await r.page.evaluate(() => (document.querySelector('#tac-bal')?.textContent || '').replace(/\s+/g, ' ').slice(0, 300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    await until(r.page, () => /account 40(\.00)?$/.test((document.querySelector('#tsh-max')?.textContent || '').trim()), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | max: ${await text(r.page, '#tsh-max')} | acct: ${acct} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(true, `shield: the account's own public TAC is offered, no cTAC leakage (${await text(r.page, '#tsh-max')})`);
    await r.page.fill('#tsh-amt', '25');
    await until(r.page, () => !document.querySelector('#tsh-go').disabled, null, 30000);
    await r.page.click('#tsh-go');
    await until(r.page, () => /press Finish|err/i.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#tac-bal-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    const st = await text(r.page, '#tac-bal-status');
    // Direct (still in this sheet when it fails) or handed off to Activity first (this run, on a stubbed fork, always
    // does — the relay accepts the job before its stubbed status ever answers) word it differently; both say the
    // deposit is safe and point to Finish, never ask for it again.
    ok(/deposit is (in the Tacit pool|safe in the pool)/.test(st) && /press Finish/.test(st), `shield: a one-tx deposit from the account, settle left to Finish like every other wrap here (${st.slice(0, 140)})`);
    ok(await r.page.$eval('#tsh-amt', (i) => i.value === ''), 'shield: the amount field empties once the deposit lands');
    await until(r.page, () => !!document.querySelector('#tac-finish'), null, 60000).then(() => true, () => false)
      .then((v) => ok(v, 'shield: the deposit is then offered to Finish, same as any other pending TAC deposit'));
    if (r.errors.length) { fails++; console.log('FAIL shield page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// With a wallet paying, the TAC sheet makes the wallet's own TAC private: the wallet signs the permit and sends one router transaction, and the
// deposit is left for the relay to settle (or Finish), as the Tacit account's is. Nothing is sent to the Tacit account first. TAC in the other
// account is a press away, which switches the paying account; and where the wallet holds none, the Tacit account's TAC is offered as it always was.
// The wallets are fresh ones: a wallet on the airdrop list opens the TAC sheet on its claim alone, which hides the balance and this form.
await step('shieldwallet', async () => {
  const ROUTER = '0x000000005da3e3b73726af3c774deeb9472d4992', acctOf = (hex) => makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  const fresh = async () => {
    const kw = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    const W = '0x' + Buffer.from(keccak_256(secp.getPublicKey(kw.slice(2), false).slice(1))).toString('hex').slice(-40);
    await rpc('anvil_impersonateAccount', [W]); await rpc('anvil_setBalance', [W, '0x' + (10n ** 18n).toString(16)]);
    return { kw, W };
  };
  // Opens the TAC sheet with this key open and the wallet paying, on a tab that shows the balance.
  const open = async (r, hex) => {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await toWallet(r.page);
    await r.page.waitForSelector('[data-pay="wallet"]', { timeout: 60000 });
    await r.page.click('[data-pay="wallet"]');                                              // connects the stub wallet, which pays
    await until(r.page, () => document.querySelector('[data-pay="wallet"]')?.classList.contains('main'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#sheet-tac[open] [data-tac-mode="buy"]', { timeout: 120000 });
    await r.page.click('[data-tac-mode="buy"]');                                            // a wallet connected opens the sheet on the airdrop alone, which hides the balance
  };
  const maxIs = (p, re) => until(p, (x) => new RegExp(x).test((document.querySelector('#tsh-max')?.textContent || '').trim()), re, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | max: ${await text(p, '#tsh-max')} | shield: ${(await text(p, '#tac-shield')).replace(/\s+/g, ' ').slice(0, 200)}`); });
  const hex = '5411f'.padEnd(64, '3'), { kw, W } = await fresh();
  await fundTac(W, 40n * 10n ** 18n);
  await fundTac(acctOf(hex), 10n * 10n ** 18n);                                             // the key's own account holds some too
  const r = await openPage({ account: W, key: kw });
  try {
    await open(r, hex);
    await r.page.waitForSelector('#tac-shield #tsh-go', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | shield: ${(await text(r.page, '#tac-shield')).replace(/\s+/g, ' ')} | hash: ${await r.page.evaluate(() => location.hash)} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    await maxIs(r.page, 'your wallet 40(\\.00)?$');
    ok(true, `shieldwallet: the paying wallet's own public TAC is offered (${await text(r.page, '#tsh-max')})`);
    await until(r.page, () => /10 TAC is also in your Tacit account/.test(document.querySelector('#tac-shield')?.textContent || ''), null, 60000);
    ok(!!(await r.page.$('#tsh-switch')), 'shieldwallet: and the Tacit account\'s TAC is a press away');
    await r.page.fill('#tsh-amt', '25');
    await until(r.page, () => !document.querySelector('#tsh-go').disabled, null, 30000);
    const t0 = walletTxs.length, tacBefore = await tacOf(W);
    await r.page.click('#tsh-go');
    await until(r.page, () => /press Finish|err/i.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#tac-bal-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    const tx = walletTxs.slice(t0).find((x) => String(x.to).toLowerCase() === ROUTER);
    const sel = Buffer.from(keccak_256('wrapWithPermit(address,uint256,bytes32,uint256,uint8,bytes32,bytes32)')).toString('hex').slice(0, 8);
    ok(tx && String(tx.from).toLowerCase() === W && String(tx.data).startsWith('0x' + sel), `shieldwallet: one router transaction from the wallet, with the permit in it (${tx ? tx.data.slice(0, 10) : 'none sent'})`);
    ok((await tacOf(W)) === tacBefore - 25n * 10n ** 18n, 'shieldwallet: and the wallet paid the 25 TAC itself');
    const st = await text(r.page, '#tac-bal-status');
    ok(/deposit is (in the Tacit pool|safe in the pool)/.test(st) && /press Finish/.test(st), `shieldwallet: the settle is left to Finish like every other wrap here (${st.slice(0, 120)})`);
    ok(await r.page.$eval('#tsh-amt', (i) => i.value === ''), 'shieldwallet: the amount field empties once the deposit lands');
    await r.page.click('#tsh-switch');
    await maxIs(r.page, 'your Tacit account 10(\\.00)?$');
    ok(true, 'shieldwallet: switching the paying account offers the Tacit account\'s TAC');
    if (r.errors.length) { fails++; console.log('FAIL shieldwallet page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
  // A wallet that holds no TAC, with the key's own account holding some: the form is the Tacit account's, as it was before the wallet could pay.
  const hex2 = '5411e'.padEnd(64, '3'), { kw: kw2, W: W2 } = await fresh();
  await fundTac(acctOf(hex2), 10n * 10n ** 18n);
  const r2 = await openPage({ account: W2, key: kw2 });
  try {
    await open(r2, hex2);
    await r2.page.waitForSelector('#tac-shield #tsh-go', { timeout: 240000 });
    await maxIs(r2.page, 'your Tacit account 10(\\.00)?$');
    ok(!/also in/.test(await text(r2.page, '#tac-shield')) && !(await r2.page.$('#tsh-switch')), `shieldwallet: with no TAC in the wallet, the Tacit account's is offered as before (${await text(r2.page, '#tsh-max')})`);
    if (r2.errors.length) { fails++; console.log('FAIL shieldwallet (2) page errors: ' + r2.errors.slice(0, 3).join(' | ')); }
  } finally { await r2.browser.close(); }
});

// Joining a private farm from weld: stubbed private tETH and TAC notes, a relay split that leaves the exact note it was
// asked for, and lpBond itself recorded rather than proved (the fork has no prover). The form sizes both sides to the live
// pool ratio, Max leaves each side's split fee, the notes are cut to exactly those sizes, and the bond goes to the farm
// manager with a self-settle hook so the paying account sends it.
await step('farmjoin', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'f4a3e'.padEnd(64, '6');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 18n).toString(16)]);
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      let seq = 0;
      const note = (asset, value) => { seq++; return { asset, value: String(value), leafIndex: 910000 + seq, cx: '0x' + seq.toString(16).padStart(64, 'a'), cy: '0x01', owner: '0x02', root: '0x03', path: [] }; };
      let add = [note('${CETH}', 2000000n), note('${CTAC}', 50000000000n)];
      window.__splits = [];
      let leafSeq = 0;
      ux.poolLeafCount = async () => 900000 + (++leafSeq);
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, ...add];
        for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
        return b;
      };
      ux.transfer = async ({ notes, amount, fee }) => {
        const sum = notes.reduce((a, n) => a + BigInt(n.value), 0n), gone = new Set(notes.map((n) => n.cx));
        add = add.filter((n) => !gone.has(n.cx)).concat([note(notes[0].asset, amount), note(notes[0].asset, sum - BigInt(amount) - BigInt(fee))]);
        window.__splits.push({ asset: notes[0].asset, amount: String(amount), fee: String(fee) });
        return { status: 'settled' };
      };
      ux.lpBond = async (a) => {
        window.__join = { controller: a.controller, a: a.aNote.value, b: a.bNote.value, aAsset: a.aNote.asset, bAsset: a.bNote.asset, feeBps: a.feeBps, selfSettle: typeof a.selfSettle, calldata: ux.settleCalldata({ publicValues: '0x01', proof: '0x02', memos: [] }).slice(0, 10) };
        return { txHash: null, dShares: 1n };
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
    await r.page.waitForSelector('[data-farm="pid0"] > button', { timeout: 120000 });
    await r.page.click('[data-farm="pid0"] > button');
    await r.page.waitForSelector('#sj-max-0', { timeout: 240000 }).catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(r.page, '#farm-pid0')).replace(/\s+/g, ' ').slice(0, 300)}`); });
    await r.page.click('#sj-max-0');
    // Cold, the fork fetches the relay-fee quote's DEX reads slot by slot (see csend): minutes where mainnet takes a second.
    await until(r.page, () => /Adds/.test(document.querySelector('#sj-rcpt-0')?.textContent || '') && !document.querySelector('#sj-go-0').disabled, null, 420000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(r.page, '#sj-rcpt-0')).replace(/\s+/g, ' ')}`); });
    await shot(r.page, 'farmjoin');
    const rc = (await text(r.page, '#sj-rcpt-0')).replace(/\s+/g, ' ');
    ok(/Share of the farm/.test(rc) && /Relay fee to split your notes/.test(rc) && /Gas, from your Tacit account/.test(rc), `farmjoin: Max quotes both sides, the split fees and the gas (${rc})`);
    if (/Earns about/.test(rc)) ok(/APR on this deposit\s*(about [\d,]+%|over 100,000%)/.test(rc) && /Swap fees come on top/.test(rc), 'farmjoin: and the APR for this deposit');
    // An amount finer than a note's eight decimals is said, not left as a button that stays disabled with no reason.
    await r.page.fill('#sj-a-0', '0.123456789');
    await until(r.page, () => /Up to 8 decimals/.test(document.querySelector('#sj-rcpt-0')?.textContent || ''), null, 120000);
    ok(await r.page.$eval('#sj-go-0', (b) => b.disabled), 'farmjoin: an amount finer than 8 decimals is said, and nothing can be added');
    await r.page.click('#sj-max-0');
    await until(r.page, () => /Adds/.test(document.querySelector('#sj-rcpt-0')?.textContent || '') && !document.querySelector('#sj-go-0').disabled, null, 240000);
    await r.page.click('#sj-go-0');
    await until(r.page, () => !!window.__join || /err/.test(document.querySelector('#sf-status-0')?.innerHTML || ''), null, 120000);
    const j = await r.page.evaluate(() => window.__join), splits = await r.page.evaluate(() => window.__splits);
    if (!j) throw new Error(`no bond: ${await text(r.page, '#sf-status-0')}`);
    // The live pool, read the way pool-ux reads it: pools(bytes32) → reserves A and B.
    const poolId = '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00';
    const sel = Buffer.from(keccak_256('pools(bytes32)')).toString('hex').slice(0, 8);
    const w = (await rpc('eth_call', [{ to: '0x000000000Ed1eabD231Be41d93b719056F7febFC', data: '0x' + sel + poolId.slice(2) }, 'latest'])).slice(2);
    const rA = BigInt('0x' + w.slice(3 * 64, 4 * 64)), rB = BigInt('0x' + w.slice(4 * 64, 5 * 64)), a = BigInt(j.a), b = BigInt(j.b);
    ok(j.controller.toLowerCase() === '0x000031c47cb61fab1ce2790a69625fabb71ede24' && j.selfSettle === 'function' && j.calldata === '0x' + Buffer.from(keccak_256('settle(bytes,bytes,bytes[])')).toString('hex').slice(0, 8),
      `farmjoin: the bond goes to the farm manager, settled by the paying account (${j.controller}, ${j.selfSettle}, ${j.calldata})`);
    ok(j.aAsset === CETH && j.bAsset === CTAC && b * rA >= a * rB && (b - 1n) * rA < a * rB, `farmjoin: the TAC side is the tETH side at the live ratio, rounded up (${a} : ${b}, pool ${rA} : ${rB})`);
    ok(a === 2000000n && splits.length === 1 && splits[0].asset === CTAC && BigInt(splits[0].amount) === b && BigInt(splits[0].amount) + BigInt(splits[0].fee) <= 50000000000n,
      `farmjoin: Max spends the tETH note whole, so only the TAC side is cut, its fee within the balance (${JSON.stringify(splits)})`);
    await until(r.page, () => /In the farm/.test(document.querySelector('#sf-status-0')?.textContent || ''), null, 60000).catch(() => {});
    ok(/In the farm/.test(await text(r.page, '#sf-status-0')), `farmjoin: the sheet says it is in (${await text(r.page, '#sf-status-0')})`);
    if (r.errors.length) { fails++; console.log('FAIL farmjoin page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
await step('tacsend', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e4'.padEnd(64, '3');
  // The page's pool module, with a private cTAC note (the pool asset id TAC and cTAC share) added to the balance.
  const TACID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const note = { asset: '${TACID}', value: '3000000000', leafIndex: 900010, cx: '0x' + '7'.repeat(64), cy: '0x01', owner: '0x02' };
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-send:not([hidden]) #ts-to', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#tac-bal')?.textContent || '').replace(/\s+/g, ' ').slice(-300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    ok(/Private 30(\.00)? TAC/.test(await text(r.page, '#ts-max')), `tacsend: the private balance is offered, no cTAC/tacTAC leakage (${await text(r.page, '#ts-max')})`);
    ok(!(await r.page.$('[data-ts]')), 'tacsend: one source only, no toggle (public TAC already sends from the wallet sheet)');
    await r.page.fill('#ts-to', tacit1('abd'.padEnd(64, '9')));
    await r.page.fill('#ts-amt', '15');
    await until(r.page, () => /They get about/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | preview: ${(await text(r.page, '#ts-rcpt')).replace(/\s+/g, ' ')} | rc.hidden=${await r.page.$eval('#ts-rcpt', (e) => e.hidden)} to=${await r.page.$eval('#ts-to', (e) => e.value.slice(0, 20))} amt=${await r.page.$eval('#ts-amt', (e) => e.value)} go.disabled=${await r.page.$eval('#ts-go', (e) => e.disabled)} html=${(await r.page.$eval('#ts-rcpt', (e) => e.innerHTML)).slice(0, 200)} | status: ${await text(r.page, '#tac-bal-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(/TAC/.test(await text(r.page, '#ts-rcpt')) && !/cTAC/.test(await text(r.page, '#ts-rcpt')), `tacsend: a tacit1 recipient is quoted privately, shown as TAC (${(await text(r.page, '#ts-rcpt')).replace(/\s+/g, ' ').trim()})`);
    await r.page.fill('#ts-to', '0x000000000000000000000000000000000000dEaD');
    await until(r.page, () => /Arrives/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT);
    ok(/Relay fee/.test(await text(r.page, '#ts-rcpt')) && /Arrives[^]*TAC/.test(await text(r.page, '#ts-rcpt')), `tacsend: an 0x recipient gets a partial amount as public TAC, fee first (${(await text(r.page, '#ts-rcpt')).replace(/\s+/g, ' ').trim()})`);
    await r.page.fill('#ts-amt', '1000');
    await until(r.page, () => /More than your private balance/.test(document.querySelector('#ts-rcpt')?.textContent || ''), null, QUOTE_WAIT);
    ok(await r.page.$eval('#ts-go', (b) => b.disabled), 'tacsend: more than the private balance is refused');
    // The one-tap "Make public" (drains every worthwhile note) still sits alongside the new partial-amount form.
    ok(/Make public/.test(await text(r.page, '#tac-bal')), 'tacsend: the all-at-once "Make public" action is unchanged');
    if (r.errors.length) { fails++; console.log('FAIL tacsend page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('selfexit', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e5'.padEnd(64, '4');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  const TACID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        // A real note for this key (a wrap's own output, recovered), so the exit builds; it is not in the pool, so the
        // proof the relay is asked for is a stand-in below.
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (30n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await rpc('anvil_setBalance', [want, '0x0']);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-pub', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#tac-bal')?.textContent || '').replace(/\s+/g, ' ').slice(0, 300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    // The relay refuses the exit at submit: nothing is queued, so the offer is on the status line itself.
    refuseSubmits = 1;
    await sleep(3000);                                               // the sheet's reads repaint it once more
    await r.page.click('#tac-pub');
    const offered = await until(r.page, () => !!document.querySelector('#tac-bal-status [data-selfdo]'), null, 300000).then(() => true, () => false);
    ok(offered && /free settles for today/.test(await text(r.page, '#tac-bal-status')), `selfexit: a relay refusal at submit offers to send it from the Tacit account (${(await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ').slice(0, 140)})`);
    if (offered) {
      // An account with no ETH is told what it needs and where, not left with a failure.
      await r.page.click('#tac-bal-status [data-selfdo]');
      await until(r.page, () => /Send a little ETH/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 120000);
      const need = await text(r.page, '#tac-bal-status');
      ok(/network fee, about [\d.]+ ETH/.test(need) && need.includes(want.slice(0, 8)) || /Tacit account/.test(need), `selfexit: an account without ETH is told the fee and to add some (${need.replace(/\s+/g, ' ').slice(0, 160)})`);
      // Funded, it asks the relay for the proof only (no fee in the op) and sends settle() itself.
      await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
      proveStub = true;
      const n1 = submits.length;
      await r.page.click('#tac-bal-status [data-selfdo]');
      await until(r.page, () => !/Send a little ETH/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 60000).catch(() => {});
      await sleep(4000);
      const prove = submits.slice(n1).find((x) => x.type === 'unwrap' || x.type === 'sendunwrap');
      ok(prove?.mode === 'prove' && BigInt(prove.op.fee) === 0n, `selfexit: funded, the relay is asked for the proof only, with no relay fee (${prove ? `${prove.type} ${prove.mode} fee ${prove.op.fee}` : 'no submit'})`);
    }
    if (r.errors.length) { fails++; console.log('FAIL selfexit page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

await step('selfmore', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e6'.padEnd(64, '5');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  const TACID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (30n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await rpc('anvil_setBalance', [want, '0x0']);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#ts-to', { timeout: 240000 });
    await sleep(3000);
    // A private send of the whole note, refused at submit: the offer, the way to fund the account (with its address to copy),
    // then, funded, a proof-only lock job from the paying account.
    await r.page.fill('#ts-to', tacit1('abd'.padEnd(64, '8')));
    await r.page.fill('#ts-amt', '30');
    await until(r.page, () => /They get about/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT);
    refuseSubmits = 1;
    await r.page.click('#ts-go');
    const offered = await until(r.page, () => !!document.querySelector('#tac-bal-status [data-selfdo]'), null, QUOTE_WAIT).then(() => true, () => false);
    ok(offered, `selfmore: a private send the relay refuses offers to be sent from the Tacit account (${(await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ').slice(0, 120)})`);
    if (offered) {
      await r.page.click('#tac-bal-status [data-selfdo]');
      await until(r.page, () => /Add a little ETH|Send a little ETH/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 120000);
      const copyAddr = await r.page.$eval('#tac-bal-status [data-selfcopy]', (b) => b.dataset.selfcopy).catch(() => null);
      ok(copyAddr && copyAddr.toLowerCase() === want.toLowerCase(), `selfmore: an account without ETH shows its address with a copy button (${copyAddr ? copyAddr.slice(0, 10) : 'none'})`);
      await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
      proveStub = true;
      const n1 = submits.length;
      await r.page.click('#tac-bal-status [data-selfdo]');
      await until(r.page, () => !/Send a little ETH/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 60000).catch(() => {});
      await sleep(4000);
      const lock = submits.slice(n1).find((x) => x.type === 'stealthlock');
      ok(lock?.mode === 'prove', `selfmore: funded, the lock is proved by the relay and settled by the account (${lock ? `${lock.type} ${lock.mode}` : 'no submit'})`);
    }
    // A partial send to an 0x address (a send-out), refused the same way: it goes out with no relay fee.
    proveStub = false; refuseSubmits = 1;
    await until(r.page, () => !!document.querySelector('#ts-to') && !document.querySelector('#ts-go')?.getAttribute('aria-busy'), null, 120000);
    await sleep(3000);
    await r.page.fill('#ts-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#ts-amt', '15');
    await until(r.page, () => /Arrives/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT);
    await r.page.click('#ts-go');
    const offered2 = await until(r.page, () => !!document.querySelector('#tac-bal-status [data-selfdo]'), null, QUOTE_WAIT).then(() => true, () => false);
    ok(offered2, 'selfmore: a send-out the relay refuses offers the same');
    if (offered2) {
      proveStub = true;
      const n2 = submits.length;
      await r.page.click('#tac-bal-status [data-selfdo]');
      await sleep(8000);
      const out = submits.slice(n2).find((x) => x.type === 'sendunwrap' || x.type === 'unwrap');
      ok(out?.mode === 'prove' && BigInt(out.op.fee) === 0n, `selfmore: and goes out proof-only with no relay fee (${out ? `${out.type} ${out.mode} fee ${out.op.fee}` : 'no submit'})`);
    }
    if (r.errors.length) { fails++; console.log('FAIL selfmore page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

// The ETH sheet's relayed actions that have no scenario of their own, each refused by the relay and then sent from the
// paying account: claiming a payment, taking back an expired send, and a withdrawal. The pool module is stubbed with a
// private tETH note and two locks, and with claim/refund calls that the relay refuses until they are handed a self-settle.
await step('selflocks', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e7'.padEnd(64, '6');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (5n * 10n ** 17n).toString(), ticker: 'cETH', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      const asset = ux.assetByTicker.cETH.assetId;
      const lock = (leaf, deadline, extra) => ({ leaf, asset, amount: '50000000', deadline: String(deadline), spent: false, ...extra });
      ux.scanStealthLocks = async () => ({ mine: [lock('0x' + 'a1'.repeat(32), 4102444800)], lockSetRoot: '0x' + '01'.repeat(32) });
      ux.scanSentLocks = async () => ({ sent: [lock('0x' + 'b2'.repeat(32), 1, { refundPriv: '0x' + '07'.repeat(32) })], lockSetRoot: '0x' + '02'.repeat(32) });
      const calls = (window.__selfCalls = []);
      const refuse = () => new Error('relay 429: free relayed settles for today are used up (300/300) — attach a fee above the floor');
      for (const kind of ['claim', 'refund']) {
        ux[kind === 'claim' ? 'stealthClaim' : 'stealthRefund'] = async (a) => {
          calls.push({ kind, self: typeof a.selfSettle, fee: String(a.fee) });
          if (!a.selfSettle) throw refuse();
          return { txHash: '0x' + 'ee'.repeat(32) };
        };
      }
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await rpc('anvil_setBalance', [want, '0x0']);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#eth'; });
    await r.page.waitForSelector('#v1-claim', { timeout: 600000 });
    const offerIn = (sel) => until(r.page, (q) => !!document.querySelector(q + ' [data-selfdo]'), sel, QUOTE_WAIT).then(() => true, () => false);
    const selfCalls = () => r.page.evaluate(() => window.__selfCalls);
    // Claiming a payment.
    await sleep(2000);
    await r.page.click('#v1-claim');
    ok(await offerIn('#v1-status'), 'selflocks: a claim the relay refuses offers to be sent from the Tacit account');
    await r.page.click('#v1-status [data-selfdo]');
    await until(r.page, () => /Send a little ETH/.test(document.querySelector('#v1-status')?.textContent || ''), null, 120000);
    await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
    await r.page.click('#v1-status [data-selfdo]');
    await until(r.page, () => (window.__selfCalls || []).some((c) => c.kind === 'claim' && c.self === 'function'), null, 120000).catch(() => {});
    const claim = (await selfCalls()).find((c) => c.kind === 'claim' && c.self === 'function');
    ok(claim && claim.fee === '0', `selflocks: funded, the claim is settled by the account with no relay fee (${JSON.stringify(claim)})`);
    // Taking back an expired send.
    await until(r.page, () => !!document.querySelector('#v1-back') && !document.querySelector('#v1-back').disabled, null, 120000);
    await r.page.click('#v1-back');
    ok(await offerIn('#v1-status'), 'selflocks: taking back a send the relay refuses offers the same');
    await r.page.click('#v1-status [data-selfdo]');
    await until(r.page, () => (window.__selfCalls || []).some((c) => c.kind === 'refund' && c.self === 'function'), null, 120000).catch(() => {});
    const refund = (await selfCalls()).find((c) => c.kind === 'refund' && c.self === 'function');
    ok(refund && refund.fee === '0', `selflocks: and is settled by the account with no relay fee (${JSON.stringify(refund)})`);
    // A withdrawal. The sheet ignores a tab change while an action is still going, so the refund finishes first.
    await until(r.page, () => /Done\./.test(document.querySelector('#v1-status')?.textContent || ''), null, 180000);
    await sleep(2000);
    await r.page.click('[data-v1="out"]');
    await r.page.fill('#o-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#o-amt', '0.1');
    await until(r.page, () => !document.querySelector('#o-rcpt')?.hidden && !document.querySelector('#o-go')?.disabled, null, QUOTE_WAIT);
    refuseSubmits = 1;
    await r.page.click('#o-go');
    ok(await offerIn('#v1-status'), 'selflocks: a withdrawal the relay refuses offers the same');
    proveStub = true;
    const n1 = submits.length;
    await r.page.click('#v1-status [data-selfdo]');
    await sleep(8000);
    const out = submits.slice(n1).find((x) => x.type === 'sendunwrap' || x.type === 'unwrap');
    ok(out?.mode === 'prove' && BigInt(out.op.fee) === 0n, `selflocks: and goes out proof-only with no relay fee (${out ? `${out.type} ${out.mode} fee ${out.op.fee}` : 'no submit'})`);
    if (r.errors.length) { fails++; console.log('FAIL selflocks page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

// A private send that needs a note of its exact size makes one first with a relayed split. If the relay refuses that step,
// the split can be sent from the paying account, and the send is pressed again once the note exists.
await step('selfsplit', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e8'.padEnd(64, '7');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (30n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#ts-to', { timeout: 240000 });
    await sleep(3000);
    await r.page.fill('#ts-to', tacit1('abd'.padEnd(64, '6')));
    await r.page.fill('#ts-amt', '15');
    await until(r.page, () => /They get about/.test(document.querySelector('#ts-rcpt')?.textContent || '') && !document.querySelector('#ts-go').disabled, null, QUOTE_WAIT);
    refuseSubmits = 1;
    await r.page.click('#ts-go');
    const offered = await until(r.page, () => !!document.querySelector('#tac-bal-status [data-selfdo]'), null, QUOTE_WAIT).then(() => true, () => false);
    ok(offered && /Splitting a note/.test(await text(r.page, '#tac-bal-status')) || offered, `selfsplit: a split the relay refuses offers to be sent from the Tacit account (${(await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ').slice(0, 120)})`);
    if (offered) {
      proveStub = true;
      const n1 = submits.length;
      await r.page.click('#tac-bal-status [data-selfdo]');
      await sleep(8000);
      const tr = submits.slice(n1).find((x) => x.type === 'transfer');
      ok(tr?.mode === 'prove', `selfsplit: the split is proved by the relay and settled by the account (${tr ? `${tr.type} ${tr.mode}` : 'no submit'})`);
    }
    if (r.errors.length) { fails++; console.log('FAIL selfsplit page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; proveStub = false; await r.browser.close(); }
});

// Make public with the relay taking the job: the sheet says plainly that it was sent and where it goes, names the relay fee
// beforehand, and sends to an address entered there; a bad address is refused before anything is sent.
await step('makepub', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ac5e9'.padEnd(64, '8');
  const DEAD = '0x000000000000000000000000000000000000dEaD';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (30n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        if (!note) throw new Error('stub note not recovered');
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-pub', { timeout: 240000 });
    ok(await until(r.page, () => /relay fee of about \d+ TAC comes out of it/.test(document.querySelector('#tac-bal')?.textContent || ''), null, QUOTE_WAIT).then(() => true, () => false),
      `makepub: the sheet names the relay fee before it is pressed (${(await text(r.page, '#tac-bal')).replace(/\s+/g, ' ').match(/A relay fee[^.]*\./)?.[0] || 'none'})`);
    // A bad address is refused here, with nothing sent.
    const n0 = submits.length;
    await r.page.fill('#tac-pub-to', 'not an address');
    await r.page.click('#tac-pub');
    await until(r.page, () => /address|0x/i.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 120000);
    ok(submits.length === n0, `makepub: a bad address is refused before anything is sent (${(await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ').slice(0, 100)})`);
    // The address entered gets it, and the sheet says the job is with the relay, and where it goes.
    await r.page.fill('#tac-pub-to', DEAD);
    await r.page.click('#tac-pub');
    await until(r.page, () => /Sent to the relay/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, QUOTE_WAIT);
    const said = (await text(r.page, '#tac-bal-status')).replace(/\s+/g, ' ');
    const job = submits.slice(n0).find((x) => x.type === 'unwrap');
    ok(job && String(job.op.recipient).toLowerCase() === DEAD.toLowerCase(), `makepub: the exit pays the address entered (${job ? job.op.recipient : 'no submit'})`);
    ok(/✓ Sent to the relay/.test(said) && /0x0000/.test(said) && /proved in about a minute/.test(said), `makepub: the sheet says it was sent and where it goes (${said.slice(0, 150)})`);
    ok(!!(await r.page.$('#tac-bal-status button.btn[data-act-open]')), 'makepub: and offers a clear button to follow it');
    if (r.errors.length) { fails++; console.log('FAIL makepub page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('keys', async () => {
  const r = await openPage({ account: A0, key: K0 });
  await r.page.goto(r.url + '#wallet');
  // Before anyone has signed in: the chip says what it opens, and the Ethereum option says what the signature is and how many the first time asks for.
  const first = await r.page.evaluate(() => ({ chip: document.querySelector('#wallet-label').textContent, eth: document.querySelector('#wallet-body [data-in="eth"]').textContent.replace(/\s+/g, ' '), lede: document.querySelector('#wallet-body .lede-s').textContent }));
  ok(first.chip === 'Sign in' && /A free message signature, two the first time/.test(first.eth) && /sends nothing and costs no gas/.test(first.lede), `keys: the first visit says it is a sign-in, and that the signature is free (${first.chip} | ${first.eth})`);
  await r.page.click('#wallet-body [data-in="eth"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  const txt = await shown(r.page);
  const addr = addrIn(txt);
  ok(/opened with Ethereum/.test(txt) && addr, `keys: an Ethereum signature opens ${addr}`);
  await lock(r.page);
  ok(/Continue as tacit1/.test(await walletText(r.page)), 'keys: once locked, the sheet offers to continue with the same wallet');
  await r.page.click('#wallet-body [data-in="known"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  ok((await shown(r.page)).includes(addr), 'keys: continuing reopens the same tacit1 address');
  await lock(r.page);
  const hex = 'c0ffee'.padEnd(64, '1');
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  const t1 = shownAddress(hex);
  ok((await shown(r.page)).includes(`${t1.slice(0, 14)}…${t1.slice(-12)}`), `keys: a pasted key opens its own unified tacit1 address ${t1.slice(0, 14)}…`);
  if (r.errors.length) { fails++; console.log('FAIL keys page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('tacopen', async () => {
  const r = await openPage({ account: A0, key: K0 });
  await r.page.goto(r.url);
  await r.page.waitForSelector('#toast-container', { state: 'attached' });
  const hex = 'abcdef'.padEnd(64, '3'), pass = 'correct horse battery staple';
  const saving = r.page.evaluate(async (h) => { globalThis.__TACIT_NO_INIT__ = true; const T = await import('/tacit.js'); await T.wallet.setPriv(h); return !!localStorage.getItem('tacit-wallet-v1:mainnet'); }, hex);
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.fill('#pass-input-2', pass); await r.page.click('#pass-submit');
  ok(await saving, 'tacopen: a key is saved the way tacit.finance saves it');
  await r.page.evaluate(() => { localStorage.setItem('tacit-active-mode-v1', 'local'); localStorage.removeItem('tacit-lite-id-v1'); });
  await r.page.goto(r.url + '#tac'); await r.page.reload();
  await r.page.waitForSelector('#tac-bal [data-in="known"]', { timeout: 60000 });
  await r.page.click('#tac-bal [data-in="known"]');
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.click('#pass-submit');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  // Opened from inside the open sheet: its balance reads again for the key at once, not at the next minute's refresh.
  const t0 = Date.now();
  const done = await until(r.page, () => { const t = document.querySelector('#tac-bal')?.textContent || ''; return /TAC/.test(t) && !/still reading/.test(t); }, null, 45000).then(() => true, () => false);
  ok(done, `tacopen: the TAC balance finishes reading after the key opens in the sheet (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!done) console.log('     tac-bal:', (await r.page.evaluate(() => [...document.querySelectorAll('#tac-bal .parts span')].map((e) => e.textContent.replace(/\s+/g, ' ').trim() + (e.querySelector('.sk') ? ' [skeleton]' : '')).join(' | '))));
  if (r.errors.length) { fails++; console.log('FAIL tacopen page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('saved', async () => {
  const r = await openPage({ account: A0, key: K0 });
  await r.page.goto(r.url);
  await r.page.waitForSelector('#toast-container', { state: 'attached' });
  const hex = 'abcdef'.padEnd(64, '2'), pass = 'correct horse battery staple';
  // Save a key the way tacit.finance does, through its own module and prompt.
  const saving = r.page.evaluate(async (h) => { globalThis.__TACIT_NO_INIT__ = true; const T = await import('/tacit.js'); await T.wallet.setPriv(h); return !!localStorage.getItem('tacit-wallet-v1:mainnet'); }, hex);
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.fill('#pass-input-2', pass); await r.page.click('#pass-submit');
  ok(await saving, 'saved: a passphrase-locked key is saved in this browser');
  await r.page.evaluate(() => { localStorage.setItem('tacit-active-mode-v1', 'local'); localStorage.removeItem('tacit-lite-id-v1'); });
  // A link straight to the TAC sheet, with no key open in the tab, offers the same wallet there.
  await r.page.goto(r.url + '#tac'); await r.page.reload();
  ok(!!(await r.page.waitForSelector('#tac-bal [data-in="known"]', { timeout: 60000 }).catch(() => null)), 'saved: the TAC sheet offers to open the saved key');
  await r.page.goto(r.url + '#wallet'); await r.page.reload();
  await r.page.waitForSelector('#wallet-body [data-in="known"]', { timeout: 60000 });
  ok(/saved in this browser/.test(await walletText(r.page)), 'saved: the sheet offers the saved key');
  await r.page.click('#wallet-body [data-in="known"]');
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.click('#pass-submit');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  const t1 = shownAddress(hex);
  ok((await shown(r.page)).includes(`${t1.slice(0, 14)}…${t1.slice(-12)}`), 'saved: the passphrase opens the same key tacit.finance saved');
  ok(await r.page.evaluate(() => localStorage.getItem('tacit-active-mode-v1') === 'local'), 'saved: tacit.finance\'s own wallet choice is left as it was');
  if (r.errors.length) { fails++; console.log('FAIL saved page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('bitcoin', async () => {
  // A UniSat stand-in with a real key: deterministic ECDSA, so enrolment's two signatures agree.
  const bk = '11'.repeat(32);
  const r = await openPage({ account: A0, key: K0, init: { arg: { bk }, fn: ({ bk }) => {
    const sent = [];
    window.__sent = sent;
    window.unisat = {
      requestAccounts: async () => ['bc1qtestaddress0000000000000000000000000000'], getAccounts: async () => ['bc1qtestaddress0000000000000000000000000000'],
      getPublicKey: async () => '02' + bk.slice(0, 64 - 2).padEnd(64, '0'), getNetwork: async () => 'livenet', on() {}, removeListener() {},
      signMessage: async (msg, type) => { const d = new TextEncoder().encode(bk + '|' + type + '|' + msg); const h = await crypto.subtle.digest('SHA-256', d); return btoa(String.fromCharCode(...new Uint8Array(h), ...new Uint8Array(h), 1)); },
      sendBitcoin: async (to, sats) => { sent.push([to, sats]); return 'ab'.repeat(32); },
    };
  } } });
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="btc"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  const txt = await shown(r.page);
  ok(/opened with Bitcoin bc1qte/.test(txt), `bitcoin: a Bitcoin wallet's signature opens a key (${addrIn(txt)})`);
  await lock(r.page);
  await r.page.click('#wallet-body [data-in="known"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  ok((await shown(r.page)).includes(addrIn(txt) || '?'), 'bitcoin: signing in again opens the same key');
  await r.page.evaluate(() => { location.hash = '#borrow'; });
  await r.page.waitForSelector('#bw-amt', { timeout: 120000 });
  await r.page.fill('#bw-amt', '0.0002');
  await r.page.click('#bw-fund');
  await until(r.page, () => (window.__sent || []).length > 0 || /err/.test(document.querySelector('#bw-status')?.innerHTML || ''), null, 60000);
  const sent = await r.page.evaluate(() => window.__sent);
  const deposit = await r.page.$eval('#borrow-body [data-copy]', (b) => b.dataset.copy);
  ok(sent.length === 1 && sent[0][0] === deposit && sent[0][1] >= 21000, `bitcoin: one popup funds the deposit address with ${sent[0]?.[1]} sats, the lock and its fees`);
  if (r.errors.length) { fails++; console.log('FAIL bitcoin page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('passkey', async () => {
  const r = await openPage({ account: A0, key: K0, host: 'localhost' });
  const cdp = await r.ctx.newCDPSession(r.page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="new"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 60000);
  const txt = await shown(r.page), addr = addrIn(txt);
  ok(/opened with passkey/.test(txt) && addr, `passkey: a new passkey wallet opens ${addr}`);
  ok(await r.page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('tacit-prf-v1') || '{}')).length === 1), 'passkey: tacit.finance\'s passkey list gains the wallet');
  await lock(r.page);
  await r.page.click('#wallet-body [data-in="passkey"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 60000);
  ok((await shown(r.page)).includes(addr), 'passkey: signing in with it opens the same key');
  if (r.errors.length) { fails++; console.log('FAIL passkey page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

const balOf = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const go = (p, h) => p.evaluate((x) => { location.hash = ''; location.hash = x; }, h);
let ACCT = null;
await step('acct', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'feed'.padEnd(64, '3');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  // tacit.finance's pool module, loaded on its own, derives the same account from the same key.
  const viaUx = await r.page.evaluate(async (h) => {
    const d = await import('/vendor/tacit-deps.min.js'), dep = await import('/confidential-deployments.js');
    dep.setActiveNetwork('mainnet');
    const { makeConfidentialPoolUx } = await import('/confidential-pool-ux.js');
    return makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' }).account(d.hexToBytes(h)).address;
  }, hex);
  await toWallet(r.page);
  await r.page.waitForSelector('#ac-form [data-copy]', { timeout: 60000 });
  const shownAddr = await r.page.$eval('#ac-form [data-copy]', (b) => b.dataset.copy);
  ok(shownAddr === want && viaUx === want, `acct: the Tacit account is the key's own, as tacit.finance derives it (${want.slice(0, 10)}…, pool-ux ${viaUx.slice(0, 10)}…)`);
  ok(await r.page.$eval('[data-pay="tacit"]', (b) => b.classList.contains('main')), 'acct: with no wallet connected, the Tacit account pays');
  // The public farm, opened while the account holds no ETH: it says so before anything is typed, with the way to add some, and Max says why it fills nothing.
  await go(r.page, '#farm');
  await r.page.waitForSelector('#pf-fund [data-fund]', { timeout: 60000 }).catch(() => {});
  ok(!!(await r.page.$('#pf-fund [data-fund]')) && /no ETH/.test(await text(r.page, '#pf-fund')), 'acct: the farm of an account with no ETH says so, with a way to add some');
  await r.page.click('#pf-max');
  ok(/Max keeps/.test(await text(r.page, '#pf-status')) && !(await r.page.inputValue('#pf-amt')), `acct: Max with no ETH to spare says why it fills nothing (${await text(r.page, '#pf-status')})`);
  await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);             // funded from outside, as an exchange would

  await go(r.page, '#buy');
  await r.page.waitForSelector('#b-amt', { timeout: 60000 });
  ok(/Tacit account/.test(await text(r.page, '#b-max')), 'acct: the pay line names the Tacit account');
  await r.page.fill('#b-amt', '0.001');
  await until(r.page, () => !document.querySelector('#b-go').disabled, null, 240000);
  await r.page.click('#b-go');
  await until(r.page, () => /Bought|err/.test(document.querySelector('#b-status')?.innerHTML || ''), null, 120000);
  ok((await tacOf(want)) > 0n, `acct: Buy signs from the Tacit account, no wallet asked ${await text(r.page, '#b-status')}`);

  await go(r.page, '#farm');
  await r.page.waitForSelector('[data-pfm="pair"]', { timeout: 60000 });
  await r.page.click('[data-pfm="pair"]');
  await r.page.fill('#pf-amt', '0.0002');
  await until(r.page, () => !document.querySelector('#pf-go').disabled || /\S/.test(document.querySelector('#pf-status')?.textContent || ''), null, 60000);
  if (await r.page.isDisabled('#pf-go')) throw new Error(`the ETH + TAC deposit stayed disabled: ${await text(r.page, '#pf-rcpt')}`);
  await r.page.click('#pf-go');
  await until(r.page, () => /Staked/.test(document.querySelector('#toast-container')?.textContent || '') || !!document.querySelector('#farm-precision .status .err'), null, 120000);
  ok((await stakedOf(want)) > 0n, `acct: ETH + TAC staked with a permit the Tacit account signed ${await text(r.page, '#pf-status')}`);

  const OUT = '0x1111111111111111111111111111111111111111', o0 = await balOf(OUT);
  await toWallet(r.page);
  await r.page.waitForSelector('[data-wal="out"]');
  await r.page.click('[data-wal="out"]');
  await r.page.fill('#ac-to', OUT); await r.page.fill('#ac-mv', '0.01');
  await r.page.click('#ac-go');
  await until(r.page, () => /Sent\.|err/.test(document.querySelector('#ac-status')?.innerHTML || ''), null, 120000);
  ok((await balOf(OUT)) - o0 === 10n ** 16n, `acct: Send out pays from the Tacit account ${await text(r.page, '#ac-status')}`);
  await r.page.click('[data-wala="tac"]');
  await r.page.waitForSelector('#ac-to');
  await r.page.fill('#ac-to', OUT);
  const tAcct = await tacOf(want), tOut0 = await tacOf(OUT);
  await r.page.click('#ac-max');
  await until(r.page, () => !!document.querySelector('#ac-mv')?.value);
  await r.page.click('#ac-go');
  await chainUntil(async () => (await tacOf(OUT)) - tOut0 === tAcct, 120000);
  ok(tAcct > 0n && (await tacOf(OUT)) - tOut0 === tAcct && (await tacOf(want)) === 0n, `acct: Send out moves all of the Tacit account's TAC too (${Number(tAcct / 10n ** 14n) / 1e4} TAC)`);
  await r.page.click('[data-wala="eth"]');

  await r.page.click('[data-pay="wallet"]');                                              // connects the stub wallet
  await until(r.page, () => document.querySelector('[data-pay="wallet"]')?.classList.contains('main'));
  await r.page.click('[data-pay="tacit"]');
  await until(r.page, () => document.querySelector('[data-pay="tacit"]')?.classList.contains('main'));
  ok(true, 'acct: with a wallet connected either account can be chosen to pay');
  await r.page.click('[data-wal="add"]');
  await r.page.waitForSelector('#ac-go');
  const a0 = await balOf(want);
  await r.page.fill('#ac-mv', '0.02');
  await r.page.click('#ac-go');
  await until(r.page, () => /Added\.|err/.test(document.querySelector('#ac-status')?.innerHTML || ''), null, 120000);
  ok((await balOf(want)) - a0 === 2n * 10n ** 16n, `acct: Add from wallet tops the Tacit account up ${await text(r.page, '#ac-status')}`);
  if (r.errors.length) { fails++; console.log('FAIL acct page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  ACCT = { r, want };
});

await step('devmove', async () => {
  if (!ACCT) throw new Error('needs the acct scenario first');
  const { r } = ACCT, st = () => text(r.page, '#d-status');
  await go(r.page, '#device');
  await r.page.waitForSelector('[data-chain="1"]', { timeout: 60000 });
  await r.page.click('[data-chain="1"]');
  await r.page.waitForSelector('#d-amt', { timeout: 60000 });
  await r.page.fill('#d-amt', '0.01');
  await r.page.click('#d-go');
  await until(r.page, () => /Deposited|err/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(/Deposited/.test(await st()), `devmove: the Tacit account deposits, proved here ${(await st()).slice(0, 60)}`);

  await r.page.click('[data-dev="receive"]');
  await r.page.waitForSelector('#d-form [data-copy]', { timeout: 60000 });
  const box = (await r.page.$$eval('#d-form [data-copy]', (bs) => bs.map((b) => b.dataset.copy)))[1];
  await rpc('eth_sendTransaction', [{ from: A0, to: box, value: '0x' + (10n ** 15n).toString(16) }]);   // under the keeper's minimum
  await r.page.click('[data-dev="send"]'); await r.page.click('[data-dev="receive"]');
  await r.page.waitForSelector('#d-sweep', { timeout: 60000 });
  await r.page.click('#d-sweep');
  await until(r.page, () => /Swept in|err/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(/Swept in/.test(await st()) && (await balOf(box)) === 0n, `devmove: a small arrival is swept in from this device ${(await st()).slice(0, 60)}`);

  await r.page.click('[data-dev="out"]');
  await r.page.click('[data-dest="v1"]');
  await r.page.fill('#d-amt', '0.002');
  const n0 = submits.length, k0 = relays.length;
  await r.page.click('#d-go');
  await until(r.page, () => /Moved|stubbed|failed|err/i.test(document.querySelector('#d-status')?.innerHTML || ''), null, 1200000);
  const rel = relays.slice(k0).find((b) => b.wrap);
  const landed = !!rel?.txHash && (await rpc('eth_getTransactionReceipt', [rel.txHash]))?.status === '0x1';
  ok(rel && BigInt(rel.wrap.amount) === 2n * 10n ** 15n && landed && submits.slice(n0).some((s) => s.type === 'wrap'),
    `devmove: pool ETH moves into V1 in one relayed withdrawToV1, then its note settle is submitted ${(await st()).slice(0, 60)}`);

  await r.page.click('[data-dest="8453"]');
  await r.page.fill('#d-amt', '0.001');
  const k1 = relays.length;
  await r.page.click('#d-go');
  await until(r.page, () => /On its way|stubbed|err/i.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(relays.slice(k1).some((b) => b.call), `devmove: a move to Base asks the relayer for its bridge call ${(await st()).slice(0, 60)}`);

  // A withdrawal the keeper cannot take says so plainly and offers the paying account instead, which then sends it
  // itself, proved here, with no relay fee.
  const BEEF = '0x000000000000000000000000000000000000beef';
  await r.page.click('[data-dest="addr"]');
  await r.page.fill('#d-to', BEEF);
  await r.page.fill('#d-amt', '0.0005');
  // A gateway's timeout says nothing of whether the relay sent it: the page reads the chain and offers no second payment.
  gatewayOnce = true;
  await r.page.click('#d-go');
  await until(r.page, () => /class="err"/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  const unknown = await st();
  ok(/did not answer/.test(unknown) && !(await r.page.$('#d-status [data-retry="d-self"]')) && (await r.page.$eval('#d-amt', (i) => i.value)) === '',
    `devmove: a gateway timeout is read as no answer: the amount clears and no second payment is offered (${unknown.slice(0, 90)})`);
  await r.page.fill('#d-amt', '0.0005');
  await until(r.page, () => !document.querySelector('#d-go').disabled, null, 60000);
  const k2 = relays.length, b0 = await balOf(BEEF);
  await r.page.click('#d-go');
  await until(r.page, () => /data-retry="d-self"|class="err"/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  const said = await st();
  ok(relays.slice(k2).some((b) => !b.wrap && !b.call) && /can’t take this one/.test(said) && !/gas/i.test(said) && !!(await r.page.$('#d-status [data-retry="d-self"]')),
    `devmove: a withdrawal the keeper cannot take says so plainly and offers the Tacit account instead (${said.slice(0, 110)})`);
  await r.page.click('#d-status [data-retry="d-self"]');
  await r.page.waitForSelector('#d-relay', { timeout: 30000 });
  await until(r.page, () => !document.querySelector('#d-go').disabled, null, 30000);
  await r.page.click('#d-go');
  await until(r.page, () => /Withdrawn|class="err"/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(/Withdrawn/.test(await st()) && (await balOf(BEEF)) - b0 === 5n * 10n ** 14n, `devmove: then the Tacit account sends it, proved here, with no relay fee (${(await st()).slice(0, 60)})`);
  if (r.errors.length) { fails++; console.log('FAIL devmove page errors: ' + r.errors.slice(0, 3).join(' | ')); }
});
await step('btc', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'b17c'.padEnd(64, '5');
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  await go(r.page, '#btc');
  await until(r.page, () => /^\d/.test(document.querySelector('#btc-body .bal .v')?.textContent || '') || /err/.test(document.querySelector('#btc-body')?.innerHTML || ''), null, 180000);
  ok(/^0(\.0+)?$/.test((await text(r.page, '#btc-body .bal .v')).trim()), `btc: an empty key reads 0 BTC through tacit.js (${(await text(r.page, '#btc-body .bal .v')).trim()})`);
  const route = async (to, want) => {
    await r.page.fill('#bt-to', to); await r.page.fill('#bt-amt', '0.0001');
    await until(r.page, () => !document.querySelector('#bt-rcpt').hidden, null, 60000);
    await sleep(400);
    return (await text(r.page, '#bt-rcpt')).replace(/\s+/g, ' ');
  };
  const t1 = tacit1(hex);
  ok(/Silent payment/.test(await route(t1, 'sp')), 'btc: BTC to a tacit1 address goes as a silent payment');
  ok(/Silent payment/.test(await route(shownAddress(hex), 'sp')), 'btc: BTC to a unified tacit1 address goes as a silent payment');
  ok(/Plain payment/.test(await route('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'addr')), 'btc: BTC to a bc1 address is a plain payment');
  ok(/Ethereum address/.test(await route(A0, 'err')), 'btc: an Ethereum address is refused with a reason');
  ok(/More than you hold/.test(await text(r.page, '#bt-rcpt')) || await r.page.isDisabled('#bt-go'), 'btc: an unfunded key cannot send');
  // BTC to a tacit1 is a silent payment to its Bitcoin lane: the wallet's version-0 silent-payment keys, which tacit.js
  // still scans (SP_KEY_VERSIONS) beside the version-1 address it shows.
  await r.page.click('[data-btcm="receive"]');
  await until(r.page, () => [...document.querySelectorAll('#btc-form [data-copy]')].some((b) => /^sp1/.test(b.dataset.copy)), null, 60000);
  const shown = await r.page.$$eval('#btc-form [data-copy]', (bs) => bs.map((b) => b.dataset.copy).find((v) => /^sp1/.test(v)));
  const [fromT1, v0, scanned] = await r.page.evaluate(async ([a, h]) => {
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);   // the instance the page loaded
    const d = await import('/vendor/tacit-deps.min.js'), { makeTacitAddress } = await import('/tacit-address.js');
    const { lanes } = makeTacitAddress({ secp: d.secp }).decodeTacitAddress(a);
    const enc = (k) => T.encodeSilentPaymentAddress({ scanPub: k.scanPub, spendPub: k.spendPub, network: 'mainnet' });
    return [enc(lanes.btc), enc(T.deriveWalletSilentPaymentKeys(d.hexToBytes(h), 0)), T.SP_KEY_VERSIONS];
  }, [t1, hex]);
  ok(fromT1 === v0 && scanned.includes(0) && /^sp1/.test(shown || ''), `btc: BTC to a tacit1 lands on silent-payment keys this wallet scans (${fromT1.slice(0, 12)}…, versions ${scanned})`);
  await r.page.fill('#bt-chk', '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b');
  await r.page.click('#bt-chk-go');
  await until(r.page, () => /not addressed|not found|not indexed/.test(document.querySelector('#btc-status')?.textContent || ''), null, 120000);
  ok(true, `btc: a payment link is checked against this key (${(await text(r.page, '#btc-status')).trim().slice(0, 50)})`);
  // The refresh beside the balance also looks for shielded payments, which no balance read can see: TAC's transfer index is
  // read and the line says what came of it; transfers that could not be read are counted and offered again. (The page's own
  // background look for shielded payments reads the index too, so only that it was read since the press is asserted.)
  const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  let indexReads = 0, indexTxids = [];
  await r.page.route(new RegExp(`^https://api\\.tacit\\.finance/assets/${TAC}/recent-xfer-txids`), (route) => { indexReads++; return json(route, { asset_id: TAC, txids: indexTxids, next_cursor: null, done: true }); });
  const refresh = async (want) => {
    await until(r.page, () => document.querySelector('#btc-re')?.textContent.trim() === 'refresh', null, 120000);
    const before = indexReads;
    await r.page.click('#btc-re');
    await until(r.page, (re) => new RegExp(re).test(document.querySelector('#btc-status')?.textContent || ''), want, 180000);
    return { line: (await text(r.page, '#btc-status')).replace(/\s+/g, ' ').trim(), reads: indexReads - before };
  };
  const none = await refresh('None for you among the latest shielded transfers');
  ok(none.reads >= 1 && /further back is found from its payment link or transaction id/.test(none.line) && !/could not be read/.test(none.line), `btc: refresh looks through TAC's transfer index and says none were for this key (${none.reads} read; ${none.line.slice(0, 90)})`);
  indexTxids = ['aa', 'bb', 'cc'].map((x) => x.repeat(32));                                   // transactions Bitcoin does not have
  const unread = await refresh('could not be read');
  ok(unread.reads >= 1 && /3 could not be read; refresh to try them again/.test(unread.line), `btc: transfers that could not be read are counted and offered again (${unread.line.slice(0, 120)})`);
  if (r.errors.length) { fails++; console.log('FAIL btc page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});
// The TAC sheet's Bridge: TAC notes on Bitcoin (a stubbed holdings scan) are listed, one over the limit refused with its
// reason; a note the stubbed reflection tracks checks out as one Bitcoin transaction, held back while the key holds no
// sats for its fee; bridges already under way (seeded in the journal tacit.js keeps) show their steps and actions, a
// mint the relay refused offers the paying account, and Recover on one that did not complete files its claim.
await step('bridge', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'b41d'.padEnd(64, '9'), pubB = secp.getPublicKey(hex, true), pub = Buffer.from(pubB).toString('hex');
  const { ripemd160 } = await import('@noble/hashes/ripemd160');
  const spk = '0014' + Buffer.from(ripemd160(sha256(pubB))).toString('hex');
  const { makeConfidentialPool } = await import(new URL('../dapp/confidential-pool.js', import.meta.url));
  const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const rev = (h) => h.match(/../g).reverse().join('');
  const N1 = 'c1'.repeat(32), N2 = 'c2'.repeat(32), N3 = 'c3'.repeat(32), N4 = 'c4'.repeat(32), SK3 = '3b'.repeat(32), TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  const spk3 = '0014' + Buffer.from(ripemd160(sha256(secp.getPublicKey(SK3, true)))).toString('hex');
  const claims = [];
  const api = (re, fn) => r.page.route(re, (route) => fn(route, new URL(route.request().url())));
  // The note tree holds the leaf the burn names for a note of this amount (blinding as the stubbed scan gives it); N4 is live but absent from it.
  const leafOf = (amt) => { const c = pool.commitXY(amt, '0x' + (12345n + amt).toString(16).padStart(64, '0')); return pool.btcNoteLeaf('0x' + TAC, c.cx, c.cy, '0x' + '00'.repeat(32)); };
  let dumps = 0;
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/dump/, (route) => { dumps++; return json(route, { attestedHeight: 970000,
    snapshot: { height: 970000, liveTriples: [[pool.outpointKey('0x' + rev(N1), 0), '0x00', '0x00', '0x00', 0], [pool.outpointKey('0x' + rev(N3), 0), '0x00', '0x00', '0x00', 0], [pool.outpointKey('0x' + rev(N4), 0), '0x00', '0x00', '0x00', 0]], burnNodes: [], noteLeaves: [leafOf(25000000000n)], pendingDepositRecords: [] } }); });
  // Bitcoin's proof on Ethereum stands at block 970,000: the bridge waiting for it is 50 blocks short.
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/status/, (route) => json(route, { network: 'mainnet', attestedHeight: 970000, tipHeight: 970000, lagBlocks: 0 }));
  // Any other transaction Bitcoin has never seen (the stuck bridge's two): registered first, so the fixtures below win.
  await api(/^https:\/\/api\.tacit\.finance\/chain\/tx\/[0-9a-f]{64}/, (route) => route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"not-found"}' }));
  await api(/^https:\/\/api\.tacit\.finance\/chain\/tx\/(c1|c2|c3|c4){32}/, (route, u) => json(route, { txid: u.pathname.split('/').pop(),
    status: { confirmed: true, block_height: 960000 }, vout: [{ scriptpubkey: u.pathname.includes('c3c3') ? spk3 : spk, value: 546 }] }));
  await api(/^https:\/\/api\.tacit\.finance\/bridge\/recover/, (route) => {
    if (route.request().method() === 'POST') { claims.push(JSON.parse(route.request().postData() || '{}')); return json(route, { ok: true, status: 'queued' }); }
    return json(route, { status: 'queued' });
  });
  await r.page.goto(r.url + '#wallet');
  // The holdings scan is tacit.js's own, stubbed on the instance the page loads.
  await r.page.evaluate(async ([n1, n2, n3, n4, sk3, aid]) => {
    globalThis.__TACIT_NO_INIT__ = true; localStorage.setItem('tacit-network-v1', 'mainnet');
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);
    const note = (txid, amount) => ({ utxo: { txid, vout: 0, value: 546, status: { confirmed: true } }, amount, blinding: 12345n + amount });
    const stealth = { ...note(n3, 3000000000n), stealthTweakedSk: sk3 };
    const utxos = [note(n1, 25000000000n), note(n2, 150000000000n), stealth, note(n4, 4000000000n)];
    T._testSetScanHoldingsOverride(() => new Map([[aid, { assetIdHex: aid, ticker: 'TAC', decimals: 8, balance: 182000000000n, utxos, ghosts: [], inflated: [], pending: [] }]]));
  }, [N1, N2, N3, N4, SK3, TAC]);
  // Three bridges under way: one waiting for the proof, one ready whose mint the relay refused, one that did not complete.
  const recOf = (id, stage, extra = {}) => ({ id: `${id}:0`, network: 'mainnet', walletPub: pub, path: 'reflected', stage, createdAt: Date.now(),
    source: { txid: id, vout: 0, sats: 546, assetId: '0x' + TAC, amount: { __big: '10000000000' }, blinding: { __big: '777' } },
    burn: { txid: id.replace(/^../, 'bb'), hex: '00', commitTxid: 'cc'.repeat(32), commitHex: '00', fundingUtxo: { txid: 'dd'.repeat(32), vout: 1 } },
    envelope: { destLeaf: '0x' + 'ee'.repeat(32) }, ...extra });
  const journal = [recOf('d1'.repeat(32), 'rburn-mined', { burnHeight: 970050, createdAt: Date.now() - 3e6, arm: { ok: true, status: 'armed', dest: '0x' + 'dd'.repeat(32), at: Date.now() - 2.9e6 } }),
    recOf('d2'.repeat(32), 'rfolded', { createdAt: Date.now() - 2e6, lastError: { message: 'free relayed settles for today are used up', at: Date.now(), until: Date.now() + 3 * 3600e3 }, errorCount: 0 }),
    recOf('d3'.repeat(32), 'not-recorded', { createdAt: Date.now() - 1e6 }),
    recOf('d4'.repeat(32), 'rburn-signed', { createdAt: Date.now() - 5e5, lastError: { message: 'bad-txns-inputs-missingorspent', at: Date.now() }, errorCount: 3 }),
    // One that arrived an hour ago: listed under Arrived, with its Ethereum transaction, until Done.
    recOf('d5'.repeat(32), 'minted', { createdAt: Date.now() - 9e6, mintedAt: Date.now() - 36e5, mintedTxHash: '0x' + 'ab'.repeat(32) })];
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-burndep-bridge-v1:mainnet:${pub}`, JSON.stringify(journal)]);
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  // The dashboard names the bridges waiting for their holder, and opens the Bridge tab.
  await until(r.page, () => /bridges of TAC to Ethereum are waiting for you/.test(document.querySelector('#dash-due')?.textContent || ''), null, 60000);
  ok(/2 bridges of TAC to Ethereum are waiting for you/.test(await text(r.page, '#dash-due')), `bridge: the dashboard says two bridges wait for a press from their holder (${(await text(r.page, '#dash-due')).replace(/\s+/g, ' ').slice(0, 120)})`);
  // The one the relay refused for the day's allowance is said apart, with what it does and what the holder can do, not as a press that would be refused again.
  const dueText = (await text(r.page, '#dash-due')).replace(/\s+/g, ' ');
  ok(/Your bridge of [\d,.]+ TAC is ready to mint\. Today’s free settles are used up, so this page asks again every hour while it is open with your wallet, or send it from your wallet now\./.test(dueText), `bridge: a mint held by the day's allowance is said with when it goes on and what the holder can do (${dueText.slice(0, 300)})`);
  // It is announced once (a toast and, with notices on, a system notice), and remembered so the next look does not say it again.
  await until(r.page, ([k]) => /:held:/.test(localStorage.getItem(k) || ''), ['tacit-lite-bridge-told-v1'], 60000);
  const toldKeys = await r.page.evaluate(([k, p]) => (JSON.parse(localStorage.getItem(k) || '{}')[p] || []), ['tacit-lite-bridge-told-v1', pub]);
  ok(toldKeys.length === 1 && toldKeys[0] === `${'d2'.repeat(32)}:0:held:${new Date().toISOString().slice(0, 10)}`, `bridge: the held mint is announced once and remembered (${JSON.stringify(toldKeys)})`);
  // The landing card's Bitcoin tab is a handoff: it says in one line what the one-step bridge costs and how long it takes, and its
  // button opens the Bridge tab.
  await r.page.click('[data-hxm="private"]'); await r.page.selectOption('#hx-from', 'btc');
  await until(r.page, () => document.querySelector('#hx-go')?.textContent === 'Bridge TAC from Bitcoin', null, 120000);
  const hxBtc = (await text(r.page, '#hx-body')).replace(/\s+/g, ' ');
  await shot(r.page, 'hx-bitcoin');
  ok(/Your TAC/.test(hxBtc) && /1,000 TAC a bridge/.test(hxBtc) && /No relay fee/.test(hxBtc) && /Bitcoin fee in sats/.test(hxBtc) && /few hours, sometimes up to a day/.test(hxBtc), `bridge: the landing card's TAC-from-Bitcoin way says what the one-step bridge costs, the most one bridge takes and how long it takes, as the Bridge tab does (${hxBtc.slice(0, 200)})`);
  // A signed-in key also sees what the Bridge tab lists, read when the tab opens: the stubbed notes (250, 1,500, 30 and 40 TAC), the
  // three that can be picked (the Bridge tab checks each one's proof when it is picked), the one over the limit, and the bridges under way (four, two of them waiting for a press from the holder).
  await until(r.page, () => /1,820 TAC on Bitcoin, in 4 notes/.test(document.querySelector('#hx-have')?.textContent || ''), null, 240000);
  const have = (await text(r.page, '#hx-have')).replace(/\s+/g, ' ');
  ok(/3 notes to pick from \(320 TAC\)\. Each bridges whole, and is checked first/.test(have) && /1 note over 1,000 TAC: split it in the Bridge tab first/.test(have) && !/not ready yet/.test(have) && /4 bridges on their way: 2 need you/.test(have),
    `bridge: the card's Bitcoin tab says what the key holds on Bitcoin and what is under way (${have.slice(0, 260)})`);
  await shot(r.page, 'hx-bitcoin-have');
  await r.page.click('#hx-go');
  await until(r.page, () => location.hash === '#bridge' && !document.querySelector('#bridge-body').hidden && document.querySelector('[data-tac-mode="bridge"]').getAttribute('aria-selected') === 'true', null, 120000);
  ok(true, 'bridge: the landing card\'s Bridge TAC from Bitcoin opens the TAC sheet on its Bridge tab, and the link reads #bridge');
  await shot(r.page, 'hx-bitcoin-bridge-tab');
  // The Bitcoin sheet's TAC line links here.
  await go(r.page, '#bitcoin');
  await until(r.page, () => !!document.querySelector('#btc-body a[data-link="bridge"]'), null, 120000);
  await r.page.click('#btc-body a[data-link="bridge"]');
  await until(r.page, () => location.hash === '#bridge' && !document.querySelector('#bridge-body').hidden && document.querySelector('[data-tac-mode="bridge"]').getAttribute('aria-selected') === 'true');
  ok(true, 'bridge: the Bitcoin sheet’s TAC line opens the TAC sheet’s Bridge tab, and the link reads #bridge');
  await until(r.page, () => document.querySelectorAll('#bridge-body .brn').length === 4, null, 120000);
  const notes = (await text(r.page, '#bridge-body .brns')).replace(/\s+/g, ' ').trim();
  ok(/^250(\.0+)? TAC.*40(\.0+)? TAC.*30(\.0+)? TAC.*1,500(\.0+)? TAC\s*Over 1,000 TAC/.test(notes) && !(await r.page.$(`#bridge-body input[value="${N2}:0"]`)) && (await r.page.inputValue('#bridge-body .brsp input')) === '1000' && !!(await r.page.$('#bridge-body [data-brsplit]')),
    `bridge: the notes are listed, the one over 1,000 TAC with its reason and a split control, not a dead choice (${notes})`);
  await r.page.check(`#bridge-body input[value="${N1}:0"]`);
  await until(r.page, () => /One Bitcoin transaction|err/.test(document.querySelector('#br-rcpt')?.innerHTML || ''), null, 120000);
  ok(/Bridge/.test(await text(r.page, '[data-tac-mode="bridge"]')) && !!(await r.page.$('[data-tac-mode="bridge"] .dot.live')) && /waiting for you/.test(await text(r.page, '[data-tac-mode="bridge"] .sr')),
    'bridge: the Bridge tab carries a dot, and says to a screen reader that bridges wait for their holder');
  const rc = (await text(r.page, '#br-rcpt')).replace(/\s+/g, ' ');
  ok(/One Bitcoin transaction/.test(rc) && /250(\.0+)? private TAC on Ethereum/.test(rc) && /Relay fee\s*None/.test(rc), `bridge: a tracked note checks out as one Bitcoin transaction with no relay fee (${rc.slice(0, 160)})`);
  await until(r.page, () => /short of the/.test(document.querySelector('#br-rcpt')?.textContent || ''), null, 120000).catch(() => {});
  // The check reads the whole reflection state: redrawing the sheet (another tab and back) must not read it again.
  const before = dumps;
  await r.page.click('[data-tac-mode="airdrop"], [data-tac-mode="air"]'); await sleep(300); await r.page.click('[data-tac-mode="bridge"]');
  await until(r.page, () => /short of the/.test(document.querySelector('#br-rcpt')?.textContent || ''), null, 60000);
  ok(dumps === before, `bridge: redrawing the sheet does not run the check, or read the reflection state, again (${before} → ${dumps})`);
  // The receipt offers public TAC on arrival, off unless asked for (a one-step bridge has no burn to send for the holder), and it stays as set across a redraw.
  const opt = await r.page.$$eval('#br-rcpt .pick', (xs) => xs.map((x) => [x.querySelector('input')?.id, x.querySelector('input')?.checked, x.textContent.replace(/\s+/g, ' ').trim().slice(0, 90)]));
  ok(opt.length === 1 && opt[0][0] === 'br-public' && opt[0][1] === false && /Make it public TAC when it arrives, in your Tacit account/.test(opt[0][2]), `bridge: a one-step receipt offers public TAC on arrival, unticked, and nothing to send for the holder (${JSON.stringify(opt)})`);
  await r.page.check('#br-public');
  await r.page.click('[data-tac-mode="airdrop"], [data-tac-mode="air"]'); await sleep(300); await r.page.click('[data-tac-mode="bridge"]');
  await until(r.page, () => !!document.querySelector('#br-public'), null, 60000);
  ok(await r.page.isChecked('#br-public'), 'bridge: the public-TAC choice is still ticked after the sheet is drawn again');
  await r.page.uncheck('#br-public');
  await r.page.check('#br-ack').catch(() => {});
  ok(/has 0(\.0+)? BTC free for fees, short of the [\d,]+ sats this needs/.test(await text(r.page, '#br-rcpt')) && await r.page.isDisabled('#br-go'), `bridge: a key with no sats for the fee cannot start it, and is told what it needs (${(await text(r.page, '#br-rcpt')).replace(/\s+/g, ' ').slice(-140)})`);
  const rows = await r.page.$$eval('#bridge-body .brr', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 5, `bridge: the four bridges under way and the one arrived are listed (${rows.length})`);
  ok(/Recorded/.test(rows[0] || '') && /proof is at Bitcoin block 970,000; the burn is in block 970,050, 50 blocks on/.test(rows[0] || '') && /Started \d+ min ago/.test(rows[0] || '')
    && !!(await r.page.$('#bridge-body .brr:nth-child(1) .stp li.now')) && /Check now/.test(rows[0] || '') && /Bitcoin bbd1d1/.test(rows[0] || '') && !/Your turn/.test(rows[0] || ''),
    `bridge: one waiting for the proof shows its step, how many blocks the proof has to go, when it started, its burn and Check now (${(rows[0] || '').slice(0, 220)})`);
  ok(/The relay finishes the mint, so you can close this page\./.test(rows[0] || '') && !/close this page/.test(rows[2] || ''), 'bridge: a one-step bridge whose mint is with the relay says the page can be closed, and one that is not says nothing of it');
  ok([2, 3].every((i) => /Your turn/.test(rows[i] || '')) && !/Your turn/.test(rows[1] || ''), 'bridge: each bridge waiting for a press from its holder says it is their turn, and one held by the day’s allowance does not');
  ok(/Arrived/.test(rows[4] || '') && /Arrived 1 h ago/.test(rows[4] || '') && /Ethereum 0xabab/.test(rows[4] || '') && /Done/.test(rows[4] || '') && (await r.page.$$('#bridge-body .brr:last-child .stp li.done')).length === 4,
    `bridge: an arrived bridge is listed with all its steps done, its Ethereum transaction and Done (${(rows[4] || '').slice(0, 200)})`);
  await r.page.click('#bridge-body [data-bract="poll"]');
  await until(r.page, () => /Not yet/.test(document.querySelector('#br-rstatus')?.textContent || ''), null, 60000);
  ok(/Not yet\. .*50 blocks on/.test(await text(r.page, '#br-rstatus')), `bridge: Check now asks at once, and says the proof is not there yet (${await text(r.page, '#br-rstatus')})`);
  await r.page.click('#bridge-body [data-bract="seen"]');
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 4, null, 30000);
  ok(true, 'bridge: Done takes an arrived bridge off the list');
  ok(/Mint now/.test(rows[1] || '') && /Send it from/.test(rows[1] || '') && /free settles are used up/.test(rows[1] || '') && /asks again every hour while it is open with your wallet/.test(rows[1] || ''),
    `bridge: a mint the relay refused for the day offers Mint now and sending it from the paying account, and says when this page mints it (${(rows[1] || '').slice(0, 260)})`);
  ok(/didn’t complete/.test(rows[2] || '') && /Recover/.test(rows[2] || '') && /Check again/.test(rows[2] || ''), 'bridge: one that did not complete offers Recover, and to look at the burn again');
  ok(/Cancel this bridge/.test(rows[3] || '') && /has not taken this transaction/.test(rows[3] || ''), 'bridge: a signed transaction Bitcoin keeps rejecting offers to be cancelled');
  await r.page.click('#bridge-body [data-bract="cancel"]');
  await until(r.page, () => /Yes, cancel it/.test(document.querySelector('#bridge-body [data-bract="cancel"]')?.textContent || ''), null, 30000);
  await r.page.click('#bridge-body [data-bract="cancel"]');
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 3, null, 60000);
  ok(true, 'bridge: cancelling it asks once more, checks Bitcoin has neither transaction, then drops the row');
  await r.page.click('#bridge-body [data-bract="recover"]');
  await until(r.page, () => /Recovering/.test(document.querySelector('#br-rstatus')?.textContent || '') || /err/.test(document.querySelector('#br-rstatus')?.innerHTML || ''), null, 60000);
  ok(claims.length === 1 && claims[0].burnTxid?.replace(/^0x/, '') === 'bb' + 'd3'.repeat(31) && /on its way back/.test(await text(r.page, '#bridge-body')),
    `bridge: Recover files one signed claim for that burn, and the row says the TAC is on its way back (${await text(r.page, '#br-rstatus')})`);
  // While a bridge is under way and notices are off, the tab offers them: a notice from this browser while the tab is in the background.
  // Not once the browser has blocked them.
  const redraw = async () => { await r.page.click('[data-tac-mode="airdrop"], [data-tac-mode="air"]'); await sleep(300); await r.page.click('[data-tac-mode="bridge"]'); };
  await r.page.evaluate(() => { Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true }); });
  await redraw();
  await until(r.page, () => !!document.querySelector('#br-notify'), null, 60000);
  ok(/Tell me when a bridge arrives or needs me: a notice from this browser while this tab is in the background/.test((await r.page.$eval('#br-notify', (b) => b.parentElement.textContent)).replace(/\s+/g, ' ')),
    'bridge: the tab offers notices while a bridge is under way and they are off');
  await r.page.evaluate(() => { Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true }); });
  await redraw(); await sleep(500);
  ok(!(await r.page.$('#br-notify')), 'bridge: the offer is not made again once the browser has blocked notices');
  // A mint the relay failed to prove is tried again by the page itself: its row says so, and it is not the holder's turn.
  await r.page.evaluate(([k, rec]) => localStorage.setItem(k, JSON.stringify([rec])), [`tacit-burndep-bridge-v1:mainnet:${pub}`,
    recOf('d6'.repeat(32), 'rfolded', { createdAt: Date.now() - 2e6, lastError: { message: 'settle failed: prove failed: exec:bridgemint produced no proof (code=101)', at: Date.now(), relay: true }, errorCount: 0 })]);
  await redraw();
  await until(r.page, () => /Its proof is not ready yet/.test(document.querySelector('#bridge-body')?.textContent || ''), null, 60000);
  const relayRow = (await text(r.page, '#bridge-body .brr')).replace(/\s+/g, ' ');
  ok(/asks again every few minutes while it is open with your wallet/.test(relayRow) && !/Your turn/.test(relayRow) && /Mint now/.test(relayRow),
    `bridge: a mint whose proof is not ready says this page asks again, is not the holder's turn, and still offers Mint now (${relayRow.slice(0, 220)})`);
  if (process.env.SHOT) await r.page.screenshot({ path: process.env.SHOT + '-wide.png' });
  // Phone width: nothing scrolls sideways.
  // TAC received privately (a stealth note the proof tracks) cannot be burned as it is: the page offers to send it to this key's own address.
  await r.page.check(`#bridge-body input[value="${N3}:0"]`);
  await until(r.page, () => !!document.querySelector('#br-prep'), null, 120000);
  ok(/received privately/.test(await text(r.page, '#br-rcpt')) && await r.page.isDisabled('#br-go'), 'bridge: TAC received privately is offered a send to the key’s own address, and cannot start a bridge as it is');
  // A tracked note the tree holds in an older form is offered the same send, before anything is signed.
  await r.page.check(`#bridge-body input[value="${N4}:0"]`);
  await until(r.page, () => /older note form/.test(document.querySelector('#br-rcpt')?.textContent || '') && !!document.querySelector('#br-prep'), null, 120000);
  ok(await r.page.isDisabled('#br-go'), 'bridge: a tracked note in an older form is offered a send to the key’s own address, and cannot start a bridge as it is');
  // The list says so before a pick, and a key with no sats free is told before it presses the send.
  const listed = (await text(r.page, '#bridge-body .brns')).replace(/\s+/g, ' ');
  ok(/40(\.0+)? TAC\s*Older note form/.test(listed) && /30(\.0+)? TAC\s*Received privately: pick it/.test(listed) && !/250(\.0+)? TAC\s*(Older|Received)/.test(listed),
    `bridge: the list names the notes that go to their own address once first, before one is picked (${listed.slice(0, 220)})`);
  ok(await r.page.isDisabled('#br-prep') && /no BTC free for it/.test(await text(r.page, '#br-rcpt')), 'bridge: with no sats free, the send to its own address is held back and says why before it is pressed');
  // A note sent to its own address is listed under Getting ready: the proof past its block makes it ready, and Bridge it picks it.
  await r.page.evaluate(([k, p, n1, n2]) => localStorage.setItem(k, JSON.stringify({ [p]: [
    { txid: n1, amount: '25000000000', at: Date.now() - 3e6, height: 969990 }, { txid: n2, amount: '150000000000', at: Date.now() - 6e5, height: 970020 }] })),
  ['tacit-lite-bridge-prep-v1', pub, N1, N2]);
  await r.page.click('[data-tac-mode="airdrop"], [data-tac-mode="air"]'); await sleep(300); await r.page.click('[data-tac-mode="bridge"]');
  await until(r.page, () => /Getting ready/.test(document.querySelector('#bridge-body')?.textContent || ''), null, 60000);
  const prepRows = await r.page.$$eval('#bridge-body .brr', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()).filter((t) => /^(250|1,500)/.test(t)));
  ok(prepRows.length === 2 && /Your turn/.test(prepRows[0]) && /Bridge it/.test(prepRows[0]) && /proof is at Bitcoin block 970,000, 20 blocks to go/.test(prepRows[1]) && !/Your turn|Bridge it/.test(prepRows[1]),
    `bridge: Getting ready lists a ready note with Bridge it and one still waiting for the proof, with the blocks to go (${prepRows.join(' | ').slice(0, 300)})`);
  await r.page.click('#bridge-body [data-brprep]');
  await until(r.page, () => !!document.querySelector(`#bridge-body input[value="${'c1'.repeat(32)}:0"]:checked`), null, 60000);
  ok(true, 'bridge: Bridge it picks the ready note and checks it');
  // A note that asked to be bridged once ready is bridged by the page itself; with no sats free for the fee it is held, says why on its row,
  // and is then the holder's turn like any other ready note.
  await r.page.evaluate(([k, p, n1]) => localStorage.setItem(k, JSON.stringify({ [p]: [{ txid: n1, amount: '25000000000', at: Date.now() - 3e6, height: 969990, plan: { auto: { maxFee: 3000 } } }] })),
    ['tacit-lite-bridge-prep-v1', pub, N1]);
  await r.page.evaluate(() => { document.querySelector('#bridge-body [data-brprep]')?.scrollIntoView(); });
  await r.page.click('[data-tac-mode="airdrop"], [data-tac-mode="air"]'); await sleep(300); await r.page.click('[data-tac-mode="bridge"]');
  await until(r.page, () => /was not bridged for you/.test(document.querySelector('#bridge-body')?.textContent || ''), null, 240000);
  const heldRow = (await r.page.$$eval('#bridge-body .brr', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()).filter((t) => /^250/.test(t)))).join(' | ');
  ok(/too few sats free for the fee/.test(heldRow) && /Your turn/.test(heldRow) && /Bridge it/.test(heldRow), `bridge: a note that asked to be bridged when ready, with no sats free, is held, says why, and is the holder's turn (${heldRow.slice(0, 260)})`);
  await r.page.setViewportSize({ width: 360, height: 760 });
  await sleep(300);
  const wide = await r.page.evaluate(() => { const d = document.querySelector('#sheet-tac .sheet-in'); return [d.scrollWidth, d.clientWidth, document.documentElement.scrollWidth, innerWidth]; });
  if (process.env.SHOT) await r.page.screenshot({ path: process.env.SHOT + '-phone.png', fullPage: true });
  ok(wide[0] <= wide[1] + 1 && wide[2] <= wide[3] + 1, `bridge: no sideways scroll at phone width (${wide})`);
  if (r.errors.length) { fails++; console.log('FAIL bridge page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

// An arrived bridge's TAC made public: one whose holder asked for it is made public by the page on its own (to the address chosen), and
// one that did not asks for the press, on its row, and sends to the paying account. The pool module is stubbed to hold two private TAC
// notes, whose leaves the two bridge records name as the notes they minted.
await step('bridgepub', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'b9b1'.padEnd(64, '7'), pub = Buffer.from(secp.getPublicKey(hex, true)).toString('hex');
  const DEAD = '0x000000000000000000000000000000000000dEaD', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const ws = [0, 1].map((index) => ux.buildWrap({ walletPriv: hx, amountWei: (30n * 10n ** 18n).toString(), ticker: 'cTAC', index }));
        // One event holds both leaves, as a settle that inserts two would: a recovery needs the tree from leaf 0.
        const found = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: ws.map((w) => w.leaf), memos: ws.map((w) => w.memo) }], hx);
        if (found.length !== 2) throw new Error('stub notes not recovered');
        for (const note of found) {
          b.notes = [...b.notes, note];
          const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
          g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        }
        globalThis.__pubLeaves = ws.map((w) => String(w.leaf).toLowerCase());
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await until(r.page, () => (globalThis.__pubLeaves || []).length === 2, null, QUOTE_WAIT);
    const [leafA, leafB] = await r.page.evaluate(() => globalThis.__pubLeaves);
    // Two arrived bridges: the first asked for public TAC at DEAD, the second asked for nothing.
    const rec = (id, leaf) => ({ id: `${id}:0`, network: 'mainnet', walletPub: pub, path: 'reflected', stage: 'minted', createdAt: Date.now() - 9e6, mintedAt: Date.now() - 36e5, mintedTxHash: '0x' + 'ab'.repeat(32),
      source: { txid: id, vout: 0, sats: 546, assetId: '0x' + TAC, amount: { __big: '3000000000' }, blinding: { __big: '777' } }, envelope: { destLeaf: leaf } });
    const A = 'a1'.repeat(32), B = 'a2'.repeat(32);
    await r.page.evaluate(([k, v, pk, pv]) => { localStorage.setItem(k, v); localStorage.setItem(pk, pv); },
      [`tacit-burndep-bridge-v1:mainnet:${pub}`, JSON.stringify([rec(A, leafA), rec(B, leafB)]), 'tacit-lite-bridge-plan-v1', JSON.stringify({ [pub]: { [`${A}:0`]: { at: Date.now() - 36e5, publicTo: DEAD } } })]);
    const n0 = submits.length;
    // The page's own tick (every couple of minutes while the key is open) makes the first public, to the address it chose, once its note
    // is found by the leaf the burn pinned.
    for (let i = 0; i < 90 && !submits.slice(n0).some((x) => x.type === 'unwrap'); i++) await sleep(4000);
    const first = submits.slice(n0).find((x) => x.type === 'unwrap');
    ok(first && String(first.op.recipient).toLowerCase() === DEAD.toLowerCase(), `bridgepub: an arrived bridge whose holder asked for public TAC is made public to the address chosen (${first ? first.op.recipient : 'no submit'})`);
    // The other asks for the press, on its row.
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#bridge'; });
    const sel = `#bridge-body [data-bract="public"][data-brid="${B}:0"]`;
    await until(r.page, (s) => !!document.querySelector(s), sel, 240000);
    ok((await r.page.$$(sel)).length === 1, `bridgepub: the arrived bridge that asked for nothing offers Make public now, once (${(await r.page.$$eval('#bridge-body .brr', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim().slice(0, 100)))).join(' | ')})`);
    const n1 = submits.length;
    await r.page.click(sel);
    for (let i = 0; i < 90 && submits.length === n1; i++) await sleep(4000);
    const second = submits.slice(n1).find((x) => x.type === 'unwrap');
    ok(second && /^0x[0-9a-fA-F]{40}$/.test(String(second.op.recipient)) && String(second.op.recipient).toLowerCase() !== DEAD.toLowerCase(), `bridgepub: its press sends the exit to the paying account (${second ? second.op.recipient : 'no submit'})`);
    ok(submits.slice(n0).filter((x) => x.type === 'unwrap').length === 2, 'bridgepub: each note is exited once, not again on the next tick');
    if (r.errors.length) { fails++; console.log('FAIL bridgepub page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The tETH sheet's To Bitcoin tab (see the header). The pool module is stubbed to hold tETH notes; Bitcoin and the proof answer
// from canned responses; the relay is the harness's own, which takes a submit and then reports its job failed.
await step('xobridge', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'b7e7'.padEnd(64, '5'), pubB = secp.getPublicKey(hex, true), pub = Buffer.from(pubB).toString('hex');
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  const api = (re, fn) => r.page.route(re, (route) => fn(route, new URL(route.request().url())));
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const note = (value, i) => ({ asset: '${CETH}', value: BigInt(value), blinding: BigInt(1000 + i), leafIndex: 900000 + i, leaf: '0x' + String(i).repeat(64).slice(0, 64), nullifier: '0x' + String(i + 1).repeat(64).slice(0, 64),
        cx: '0x' + String(i).repeat(64).slice(0, 64), cy: '0x01', owner: '0x' + '02'.repeat(32), secret: '0x' + '03'.repeat(32), root: '0x' + '04'.repeat(32), path: Array.from({ length: 32 }, () => '0x' + '00'.repeat(32)) });
      const add = [note(4000000, 1), note(2000000, 2), note(60000000, 3), note(5000000, 4), note(5000000, 5)];
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, ...add];
        for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
        return b;
      };
      return ux;
    }` }));
  // Bitcoin and the proof, canned: the proof is up to date and the view of Ethereum is recent; the key's address has what `utxos` says.
  let utxos = [];
  const head = Number(BigInt(await rpc('eth_blockNumber')));
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/status/, (route) => json(route, { network: 'mainnet', attestedHeight: 970373, tipHeight: 970373, lagBlocks: 0 }));
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/eth-state\/covers/, (route, u) => json(route, { network: 'mainnet', block: Number(u.searchParams.get('block')), bestBlock: head - 300, confirmedBlock: head - 3000, covered: false }));
  await api(/^https:\/\/api\.tacit\.finance\/crossout\/minted/, (route, u) => json(route, { decided: u.searchParams.get('txid') === '9a'.repeat(32), minted: false, status: 'rejected' }));
  await api(/^https:\/\/(mempool\.space|blockstream\.info|api\.tacit\.finance\/chain)\/(api\/)?address\/[^/]+\/utxo/, (route) => json(route, utxos));
  await r.page.goto(r.url + '#wallet');
  await r.page.evaluate(async () => {
    globalThis.__TACIT_NO_INIT__ = true; localStorage.setItem('tacit-network-v1', 'mainnet');
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);
    T._testSetScanHoldingsOverride(() => new Map());
  });
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));

  // On unless switched off: with nothing set the tab is there; set to false, with no bridge under way, there is no tab, and a link to it opens the sheet as it is.
  await go(r.page, '#private');
  await until(r.page, () => !!document.querySelector('#eth-v1 [data-v1="btc"]'), null, 120000);
  ok(true, 'xobridge: with nothing set the sheet has its To Bitcoin tab');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));
  await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  await sleep(400);
  await go(r.page, '#private/bitcoin');
  await until(r.page, () => !!document.querySelector('#eth-v1 [data-v1="wrap"][aria-selected="true"]'), null, 120000);
  ok(!(await r.page.$('#eth-v1 [data-v1="btc"]')), 'xobridge: switched off, with no bridge under way, the sheet has no To Bitcoin tab, and a link to it opens Make private');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await go(r.page, '#private');
  await until(r.page, () => !!document.querySelector('#eth-v1 [data-v1="btc"]'), null, 120000);
  ok(true, 'xobridge: switched on, the tab is there');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));

  // A bridge already under way shows the tab even when it is switched off, however the bridge got there.
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));
  const big = (v) => ({ __big: String(v) }), ago = (ms) => Date.now() - ms;
  const src = (id, extra = {}) => ({ nullifier: id, value: big(400000), amount: big(390000), fee: big(10000), assetId: CETH, ticker: 'tETH', ...extra });
  const settle = (n, extra = {}) => ({ txHash: n.repeat(32), claimId: '0x' + n.repeat(32), cx: '0x' + 'c2'.repeat(32), cy: '0x' + 'c3'.repeat(32), destCommitment: '0x' + 'dd'.repeat(32), ethBlock: head - 400, claimIdVerified: true, ...extra });
  const rec = (n, stage, extra = {}) => ({ id: '0x' + n.repeat(32), network: 'mainnet', walletPub: pub, stage, createdAt: ago(9e6 - Number('0x' + n) * 1e3), destXonly: 'ab'.repeat(32), source: src('0x' + n.repeat(32)), ...extra });
  const mint = { commitHex: '00', commitTxid: '8a'.repeat(32), revealHex: '00', revealTxid: '9a'.repeat(32), feeRate: 3 };
  const journal = [
    rec('a1', 'settling', { createdAt: ago(5 * 3600e3), startBlock: head - 50, dests: [{ amount: big(390000), cx: '0x' + 'c2'.repeat(32), cy: '0x' + 'c3'.repeat(32), destCommitment: '0x' + 'dd'.repeat(32) }], source: src('0x' + 'a1'.repeat(32), { attempts: ['10000'] }) }),
    rec('a2', 'settled', { settle: settle('a2') }),
    rec('a3', 'covered', { settle: settle('a3'), lastError: { message: 'crossout-ux: Bitcoin fees are high right now (400 sat/vB), so the Bitcoin step is waiting for them to fall under 100', at: Date.now() }, errorCount: 1 }),
    rec('a4', 'mint-signed', { settle: settle('a4'), mint, lastError: { message: 'bad-txns-inputs-missingorspent', at: Date.now() }, errorCount: 3 }),
    rec('a5', 'mint-confirmed', { settle: settle('a5'), mint: { ...mint, revealTxid: '9b'.repeat(32) } }),
    rec('a6', 'mint-rejected', { settle: settle('a6'), mint, rejectedStatus: 'rejected' }),
    rec('a7', 'minted', { settle: settle('a7'), mint }),
    rec('a8', 'settled', { settle: settle('a8'), source: src('0x' + 'a8'.repeat(32), { assetId: TAC, ticker: 'TAC' }) }),
  ];
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify(journal)]);
  await go(r.page, '#private/bitcoin');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 6, null, 120000);
  ok(!!(await r.page.$('#eth-v1 [data-v1="btc"][aria-selected="true"]')) && (await r.page.evaluate(() => location.hash)) === '#private/bitcoin', 'xobridge: a bridge under way shows the tab, selected by the link, whose address reads #private/bitcoin');
  const rows = await r.page.$$eval('#eth-v1 .brr', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 6 && !rows.some((x) => /TAC/.test(x)) && /Sent to Ethereum/.test(rows[0]) && /Waiting for Bitcoin’s proof/.test(rows[1]) && /fees are high/.test(rows[2]) && /Waiting for the tETH to be credited/.test(rows[4]) && /was not credited/.test(rows[5]),
    `xobridge: the six unfinished tETH bridges are listed in order, a finished one and a TAC one are not (${rows.length}: ${rows.map((x) => x.slice(0, 90)).join(' || ')})`);
  ok(/0\.0039 tETH/.test(rows[0]) && !!(await r.page.$('#eth-v1 .brr:nth-child(1) .stp li.now')), 'xobridge: a row names what arrives (the note less the relay fee) and marks its step');
  ok(/Cancel/.test(rows[0]) && /Look again/.test(rows[0]), `xobridge: a burn not yet seen to land, an hour or more on, offers to look again or cancel (${rows[0]})`);
  ok(/Send it anyway/.test(rows[2]), `xobridge: a Bitcoin step held back for high fees offers to be sent anyway (${rows[2]})`);
  ok(/Sign it again/.test(rows[3]) && /Try again/.test(rows[3]), `xobridge: a signed pair Bitcoin keeps rejecting offers to be signed again (${rows[3]})`);
  ok(!!(await r.page.$('#eth-v1 [data-v1="btc"] .dot.live')), 'xobridge: the To Bitcoin tab carries a dot while a bridge is under way');
  // The lander's dashboard says so too, for each asset: what needs the holder in one line, where the rest is in another, and a way to them.
  await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  await until(r.page, () => /3 bridges of tETH to Bitcoin are waiting for you\./.test(document.querySelector('#dash')?.textContent || ''), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | dash: ${(await text(r.page, '#dash')).replace(/\s+/g, ' ').slice(0, 500)}`); });
  const dash0 = (await text(r.page, '#dash')).replace(/\s+/g, ' ');
  ok(/0\.0039 TAC is on its way from Ethereum to Bitcoin, waiting for Bitcoin’s proof on Ethereum to see the burn\./.test(dash0), `xobridge: the dashboard says where a TAC bridge to Bitcoin is, and names the tETH ones that wait for the holder (${dash0.slice(0, 260)})`);
  await r.page.click('#dash [data-dash-do="private/bitcoin"]');
  await until(r.page, () => location.hash === '#private/bitcoin' && document.querySelectorAll('#eth-v1 .brr').length === 6, null, 120000);
  ok(true, 'xobridge: and its button opens the To Bitcoin tab');
  // Cancelling looks on Ethereum first (nothing there on the fork), then lets the intent go.
  await r.page.click('#eth-v1 [data-xoact="cancel"]');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 5, null, 120000);
  ok(/Cancelled: no burn for it was found on Ethereum/.test(await text(r.page, '#xo-rstatus')) && !JSON.parse(await r.page.evaluate((k) => localStorage.getItem(k), `tacit-crossout-bridge-v1:mainnet:${pub}`)).some((x) => x.stage === 'settling'),
    'xobridge: cancelling it drops the row and the record once Ethereum shows no burn for it');

  // Without the setting the tab only follows the bridges under way; with it, a new one can be started.
  ok(!(await r.page.$('#xo-amt')), 'xobridge: without the setting, bridges under way are followed and no new one is offered');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await go(r.page, '#private');
  await go(r.page, '#private/bitcoin');
  // The form. A tETH balance of five notes (0.04, 0.02, 0.6, 0.05, 0.05) is read; the key's Bitcoin address has nothing yet.
  await r.page.waitForSelector('#xo-amt');
  await r.page.fill('#xo-amt', '0.04');
  await until(r.page, () => /Bitcoin fee, when it is sent/.test(document.querySelector('#xo-rcpt')?.textContent || ''), null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | receipt: ${(await text(r.page, '#xo-rcpt')).replace(/\s+/g, ' ')} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
  const rc0 = (await text(r.page, '#xo-rcpt')).replace(/\s+/g, ' ');
  ok(/You get0\.0\d+ tETH on your Bitcoin address/.test(rc0) && /Relay fee0\.00\d+ tETH/.test(rc0) && /Arrivesusually a few hours, sometimes up to a day/.test(rc0), `xobridge: the receipt names what arrives, the relay fee and the time (${rc0.slice(0, 220)})`);
  ok(/needs a coin of \d[\d,]* sats|needs one coin of \d[\d,]* sats/.test(rc0) && await r.page.isDisabled('#xo-go') && await r.page.isHidden('#xo-ackrow'), 'xobridge: with no sats on the key’s Bitcoin address it cannot start, and says how many it needs');
  // Funded: the box appears, and ticking it enables the button. Each bridge still to sign its mint takes a coin of its own,
  // so there is one coin for each of those and one for this.
  utxos = Array.from({ length: 8 }, (_, i) => ({ txid: (i + 10).toString(16).padStart(2, '0').repeat(32), vout: 0, value: 20000, status: { confirmed: true, block_height: 970000 } }));
  await r.page.click('#xo-recheck');
  await until(r.page, () => !document.querySelector('#xo-ackrow')?.hidden, null, 240000).catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | receipt: ${(await text(r.page, '#xo-rcpt')).replace(/\s+/g, ' ')}`); });
  ok(await r.page.isDisabled('#xo-go'), 'xobridge: with sats free, the button still waits for the box to be ticked');
  await r.page.check('#xo-ack');
  ok(!(await r.page.isDisabled('#xo-go')), 'xobridge: ticked, it can start');
  // The limits.
  await r.page.fill('#xo-amt', '0.6');
  await until(r.page, () => /at most 0\.5 tETH/.test(document.querySelector('#xo-rcpt')?.textContent || ''), null, 120000);
  ok(await r.page.isDisabled('#xo-go') && await r.page.isHidden('#xo-ackrow'), 'xobridge: more than the limit is refused with the limit named, and the box goes away');
  await r.page.fill('#xo-amt', '0.005');
  await until(r.page, () => /at least 0\.01 tETH/.test(document.querySelector('#xo-rcpt')?.textContent || ''), null, 120000);
  ok(await r.page.isDisabled('#xo-go'), 'xobridge: under the minimum is refused with the minimum named');

  // Start one: the page checks again, takes the note of exactly that size, and the relay is sent a bridge-burn job; the harness's
  // relay then reports the job failed, as a settle the page could not see through, and the intent record is what is left.
  const before = submits.length;
  await r.page.fill('#xo-amt', '0.04');
  await until(r.page, () => !document.querySelector('#xo-ackrow')?.hidden, null, 240000);
  await r.page.check('#xo-ack');
  await r.page.click('#xo-go');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 6, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const sent = submits.slice(before);
  ok(sent.length === 1 && /bridgeburn/i.test(JSON.stringify(sent[0]).slice(0, 400)), `xobridge: starting one sends the relay a bridge-burn job (${sent.length}: ${JSON.stringify(sent[0] || {}).slice(0, 160)})`);
  const after = await r.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), `tacit-crossout-bridge-v1:mainnet:${pub}`);
  const mine = after.find((x) => x.id === '0x' + '2'.repeat(64));
  ok(!!mine && mine.stage === 'settling' && mine.startBlock >= head && mine.dests.length === 1 && mine.source.attempts.length === 1, 'xobridge: a settle the page could not see through leaves an intent record for that note, with where to look for it');
  const said = (await text(r.page, '#v1-status')).replace(/\s+/g, ' ').trim();
  ok(said.length > 0 && !/Burned on Ethereum/.test(said), `xobridge: the failure is reported on the sheet, not passed off as a burn (${said.slice(0, 160)})`);

  // A send the relay refuses at submit: nothing was queued, so the intent is let go and the paying account is offered.
  refuseSubmits = 1;
  await r.page.fill('#xo-amt', '0.05');            // another whole note: the first is held by the action that is still following its job, and the fork's gas can price the relay fee above a smaller one
  await until(r.page, () => !document.querySelector('#xo-ackrow')?.hidden, null, 240000);
  await r.page.check('#xo-ack');
  await r.page.click('#xo-go');
  await until(r.page, () => !!document.querySelector('#v1-status [data-selfdo]'), null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const left = JSON.parse(await r.page.evaluate((k) => localStorage.getItem(k), `tacit-crossout-bridge-v1:mainnet:${pub}`));
  ok(!left.some((x) => x.id === '0x' + '5'.repeat(64)) && left.some((x) => x.id === '0x' + '2'.repeat(64)) && refused.length > 0, 'xobridge: a send the relay refuses at submit offers the paying account and leaves no record of that note behind (the first note’s intent stays)');
  // A relay that turns the fee down when it picks the job up: the page asks once more at a doubled fee brought back onto the
  // two-digit ladder, and when that is turned down too (or doubling would eat the note) offers the paying account.
  await r.page.fill('#xo-amt', '');
  await until(r.page, () => document.querySelector('#xo-rcpt')?.hidden, null, 30000);          // the last receipt is gone before the next is waited for
  await r.page.fill('#xo-amt', '0.05');
  await until(r.page, () => /Relay fee0\.\d+ tETH/.test(document.querySelector('#xo-rcpt')?.textContent || '') && !document.querySelector('#xo-ackrow')?.hidden, null, 240000);
  const fee1 = BigInt(Math.round(Number((await text(r.page, '#xo-rcpt')).match(/Relay fee(0\.\d+) tETH/)[1]) * 1e8));
  statusError = 'feeGate: bound fee is below the marginal cost at this gas';
  const b2 = submits.length;
  const retried = fee1 * 4n < 5000000n, want = retried ? 2 : 1;
  await r.page.check('#xo-ack');
  await r.page.click('#xo-go');
  // Whatever the page says along the way, the run is over when the relay has been asked as many times as it should be.
  for (const t0 = Date.now(); submits.length - b2 < want && Date.now() - t0 < 240000;) await sleep(500);
  await sleep(3000);
  const fees = submits.slice(b2).map((b) => BigInt(b.op?.fee ?? b.fee ?? -1));
  const ladder = (v) => v.toString().replace(/0+$/, '').length <= 2;
  ok(fees.length === (retried ? 2 : 1) && fees.every(ladder) && (!retried || (fees[1] > fees[0] && fees[1] >= fee1 * 2n)), `xobridge: a fee the relay turns down is asked again once at a doubled fee on the ladder (${retried ? 'doubling fits' : 'doubling would not fit the note'}; fees ${fees.join(' → ')}${fees.length !== (retried ? 2 : 1) ? ` | status: ${(await text(r.page, '#v1-status')).replace(/\s+/g, ' ').slice(0, 300)}` : ''})`);
  statusError = 'stubbed in the fork check';
  // The rows, the receipt and the find box at phone width, with no sideways scroll.
  await r.page.setViewportSize({ width: 360, height: 760 });
  await sleep(400);
  await r.page.evaluate(() => document.querySelector('#eth-v1 #xo-find')?.closest('details')?.setAttribute('open', ''));
  const wideXo = await r.page.evaluate(() => { const d = document.querySelector('#sheet-eth .sheet-in'); return [d.scrollWidth, d.clientWidth, document.documentElement.scrollWidth, innerWidth]; });
  ok(wideXo[0] <= wideXo[1] + 1 && wideXo[2] <= wideXo[3] + 1, `xobridge: no sideways scroll at phone width (${wideXo})`);
  if (r.errors.length) { fails++; console.log('FAIL xobridge page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

// The To Bitcoin tab's tETH on Bitcoin (see the header). The key's Taproot output holds two notes made by real, signed cross-out mint
// reveals (built in the page with its own modules); the explorers, Bitcoin's proof and the worker answer from canned responses.
await step('xbring', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'c7e7'.padEnd(64, '6'), privB = Buffer.from(hex, 'hex'), pubB = secp.getPublicKey(privB, true), pub = Buffer.from(pubB).toString('hex'), XONLY = '0x' + pub.slice(2);
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
  const { makeConfidentialPool } = await import(new URL('../dapp/confidential-pool.js', import.meta.url));
  const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const rev = (h) => h.match(/../g).reverse().join('');
  const api = (re, fn) => r.page.route(re, (route) => fn(route, new URL(route.request().url())));
  await r.page.goto(r.url + '#wallet');
  // Two notes: A (0.004 tETH, in Bitcoin's proof), B (0.003 tETH, made in a block the proof has not reached).
  // A cross-out's destination blinding is HMAC(key, 'tacit-crossout-blinding-v1' || nullifier) mod n, as crossOut() derives it.
  const derive = (nullifier) => { const m = Buffer.concat([Buffer.from('tacit-crossout-blinding-v1'), Buffer.from(nullifier.slice(2), 'hex')]); let b = 0n; for (const x of hmac(sha256, privB, m)) b = (b << 8n) | BigInt(x); b %= secp.CURVE.n; return b === 0n ? 1n : b; };
  const mk = (amount, claim, nullifier) => { const nu = '0x' + nullifier.repeat(32), blinding = derive(nu), { cx, cy } = pool.commitXY(amount, blinding); return { amount, blinding, cx, cy, claimId: '0x' + claim.repeat(32), nullifier: nu }; };
  const NA = mk(400000n, 'c1', 'a1'), NB = mk(300000n, 'c2', 'a2');
  await r.page.evaluate(async () => {
    globalThis.__TACIT_NO_INIT__ = true; localStorage.setItem('tacit-network-v1', 'mainnet');
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);
    T._testSetScanHoldingsOverride(() => new Map());
  });
  const built = await r.page.evaluate(async ([hexKey, xonly, asset, notes]) => {
    const { makeBtcWallet } = await import('/bitcoin-taproot-wallet.js');
    const { makeCrossoutMintReveal } = await import('/crossout-mint-reveal.js');
    const { secp } = await import('/vendor/tacit-deps.min.js');
    const priv = Uint8Array.from(hexKey.match(/../g).map((b) => parseInt(b, 16)));
    const w = makeBtcWallet({ priv, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 3 });
    const mr = makeCrossoutMintReveal({ secp });
    return notes.map((n, i) => { const b = mr.buildCrossoutMintTxs({ prims: w.prims, assetId: asset, claimId: n.claimId, cx: n.cx, cy: n.cy, destXonly: xonly, fundingUtxo: { txid: String(i + 1).repeat(64), vout: 0, value: 50000 }, feeRate: 3 }); return { revealHex: b.revealHex, revealTxid: b.revealTxid }; });
  }, [hex, XONLY, CETH, [NA, NB].map((n) => ({ claimId: n.claimId, cx: n.cx, cy: n.cy }))]);
  NA.revealHex = built[0].revealHex; NA.txid = built[0].revealTxid; NB.revealHex = built[1].revealHex; NB.txid = built[1].revealTxid;
  const leafOf = (n) => pool.btcNoteLeaf(CETH, n.cx, n.cy, XONLY);
  const addrP2tr = await r.page.evaluate(async (x) => (await import('/crossout-notes.js')).p2trAddress(x.slice(2), 'bc'), XONLY);
  const posts = [];
  let feeNow = 150;                                                                  // high at first: a return waits for fees to fall
  const explorer = (route, u) => {
    const p = u.pathname.replace(/^\/api/, '').replace(/^\/chain/, '');
    if (route.request().method() === 'POST' && p === '/tx') { posts.push(route.request().postData()); return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'ab'.repeat(32) }); }
    if (p === `/address/${addrP2tr}/utxo`) return json(route, [NA, NB].map((n) => ({ txid: n.txid, vout: 0, value: 330, status: { confirmed: true, block_height: n === NA ? 970000 : 970200 } })));
    if (/^\/address\/bc1q[0-9a-z]+\/utxo$/.test(p)) return json(route, [{ txid: 'f1'.repeat(32), vout: 0, value: 20000, status: { confirmed: true, block_height: 960000 } }]);
    for (const n of [NA, NB]) {
      if (p === `/tx/${n.txid}/hex`) return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: n.revealHex });
      if (p === `/tx/${n.txid}`) return json(route, { txid: n.txid, status: { confirmed: true, block_height: n === NA ? 970000 : 970200 }, vout: [{ scriptpubkey: '5120' + XONLY.slice(2), value: 330 }] });
    }
    if (/\/fees\/recommended$/.test(p)) return json(route, { fastestFee: feeNow, halfHourFee: feeNow, hourFee: Math.min(feeNow, 2), economyFee: 1, minimumFee: 1 });
    if (/\/fee-estimates$/.test(p)) return json(route, { 1: feeNow, 6: Math.min(feeNow, 2), 144: 1 });
    return route.fallback();
  };
  await api(/^https:\/\/(mempool\.space|blockstream\.info)\/api\//, explorer);
  await api(/^https:\/\/api\.tacit\.finance\/chain\//, explorer);
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/dump/, (route) => json(route, { attestedHeight: 970100, snapshot: { height: 970100,
    liveTriples: [[pool.outpointKey('0x' + rev(NA.txid), 0), pool.commitmentHash(NA.cx, NA.cy), CETH, XONLY, 0]], noteLeaves: [leafOf(NA)], spentLinks: [],
    burnNodes: [['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), true]], pendingDepositRecords: [] } }));
  await api(/^https:\/\/api\.tacit\.finance\/crossout\/minted/, (route) => json(route, { decided: false, minted: false }));
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/(status|eth-state)/, (route) => json(route, { network: 'mainnet', attestedHeight: 970100, tipHeight: 970100, lagBlocks: 0 }));

  // The journal remembers both settles (a minted cross-out each), which spares the Ethereum lookup and the search.
  const big = (v) => ({ __big: String(v) });
  const jr = (n) => ({ id: n.nullifier, network: 'mainnet', walletPub: pub, stage: 'minted', createdAt: Date.now() - 36e5, destXonly: XONLY.slice(2),
    source: { nullifier: n.nullifier, value: big(n.amount), amount: big(n.amount), fee: big(0), assetId: CETH, ticker: 'tETH' }, settle: { txHash: 'e1'.repeat(32), claimId: n.claimId, cx: n.cx, cy: n.cy, ethBlock: 26000000, claimIdVerified: true } });
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify([jr(NA), jr(NB)])]);
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  await go(r.page, '#private/bitcoin');
  await r.page.waitForSelector('#xb-look', { timeout: 120000 });
  ok(/Look for it/.test(await text(r.page, '#eth-v1')), 'xbring: tETH on Bitcoin is listed on request, so a key that has bridged nothing loads nothing');
  await r.page.click('#xb-look');
  await until(r.page, () => document.querySelectorAll('#eth-v1 input[name="xb-note"]').length === 2, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | section: ${(await text(r.page, '#eth-v1')).replace(/\s+/g, ' ').slice(-400)} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const items = await r.page.$$eval('#eth-v1 label.brn', (xs) => xs.map((x) => ({ text: x.textContent.replace(/\s+/g, ' ').trim(), off: x.classList.contains('off') })));
  ok(items.length === 2 && items.some((x) => /0\.004 tETH/.test(x.text) && !x.off) && items.some((x) => /0\.003 tETH/.test(x.text) && x.off && /Waiting for Bitcoin’s proof on Ethereum to reach its block/.test(x.text)),
    `xbring: both notes are found with their amounts; the one the proof has recorded can be chosen, the other says why not (${items.map((x) => x.text).join(' | ')})`);
  // The dashboard and the landing card read the same notes: what is on Bitcoin, and how much of it can come back now.
  await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  await until(r.page, () => /on Bitcoin · 2 notes · 1 ready to bring back/.test(document.querySelector('#dash-g')?.textContent || ''), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | dash: ${(await text(r.page, '#dash-g')).replace(/\s+/g, ' ').slice(0, 300)}`); });
  ok(/0\.007/.test(await r.page.$eval('#dash-g a[href="#private/bitcoin"]', (a) => a.textContent)), `xbring: the dashboard counts the tETH on Bitcoin, 0.007 in 2 notes, 1 ready (${(await r.page.$eval('#dash-g a[href="#private/bitcoin"]', (a) => a.textContent)).replace(/\s+/g, ' ')})`);
  await r.page.click('[data-hxm="private"]'); await r.page.selectOption('#hx-from', 'tb');
  await until(r.page, () => /0\.007 tETH on Bitcoin, in 2 notes/.test(document.querySelector('#hx-have')?.textContent || ''), null, 60000);
  ok(/1 of them can come back now \(0\.004 tETH\)/.test(await text(r.page, '#hx-have')), `xbring: and the card, with tETH on Bitcoin picked, says the same (${(await text(r.page, '#hx-have')).replace(/\s+/g, ' ')})`);
  await r.page.click('#dash-g a[href="#private/bitcoin"]');
  await until(r.page, () => document.querySelectorAll('#eth-v1 input[name="xb-note"]').length === 2, null, 120000);
  ok(true, 'xbring: the dashboard line opens the To Bitcoin tab with the notes');
  // Above the ceiling nothing is offered: the receipt says so, with the cost, and there is no box to tick.
  await until(r.page, () => /fees are high right now/.test(document.querySelector('#xb-rcpt')?.textContent || ''), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | rcpt: ${(await text(r.page, '#xb-rcpt')).replace(/\s+/g, ' ')}`); });
  ok(/16\d sat\/vB/.test(await text(r.page, '#xb-rcpt')) && !(await r.page.isVisible('#xb-ackrow')), `xbring: at 165 sat/vB (150 and the priority margin) the return is not offered, the receipt says why and what it would cost, and there is nothing to tick (${(await text(r.page, '#xb-rcpt')).replace(/\s+/g, ' ')} | ackrow visible: ${await r.page.isVisible('#xb-ackrow')})`);
  feeNow = 3;
  await sleep(62000);                                                                 // the page keeps a fee for a minute
  await r.page.evaluate(() => document.querySelector('input[name="xb-note"]:checked')?.dispatchEvent(new Event('change')));
  await until(r.page, () => /You get[^]*0\.004 private tETH on Ethereum/.test(document.querySelector('#xb-rcpt')?.textContent || ''), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | rcpt: ${(await text(r.page, '#xb-rcpt')).replace(/\s+/g, ' ')}`); });
  const rc = (await text(r.page, '#xb-rcpt')).replace(/\s+/g, ' ');
  ok(/Relay feeNone/.test(rc) && /Bitcoin feeabout [\d,]+ sats/.test(rc) && !(await r.page.isVisible('#xb-ackrow')) === false, `xbring: the one ready note is chosen for the holder and its receipt names what arrives and the Bitcoin fee (${rc.slice(0, 200)})`);
  ok(await r.page.isDisabled('#xb-go'), 'xbring: the button waits for the box to be ticked');
  await r.page.check('#xb-ack');
  ok(!(await r.page.isDisabled('#xb-go')), 'xbring: ticked, it can start');
  const before = posts.length;
  await r.page.click('#xb-go');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 1, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const sent = [...new Set(posts.slice(before))];             // an explorer a transaction is offered to more than once sees it once
  ok(sent.length === 2, `xbring: the burn is signed and its commit and reveal go out through ordinary relay (${sent.length} transactions)`);
  const decs = await r.page.evaluate(async (txs) => { const { classifyConfidentialTx } = await import('/burn-deposit-bitcoin.js'); return txs.map((h) => { const d = classifyConfidentialTx('0x' + h); return d ? { type: d.type, nullifier: d.nullifier, assetId: d.assetId, target: d.target } : null; }); }, sent);
  const dec = decs.find((d) => d && d.type === 'burn') || null;
  const nu = pool.nullifier(pool.btcNoteLeaf(CETH, NA.cx, NA.cy, XONLY));
  ok(dec && dec.type === 'burn' && dec.nullifier === nu && String(dec.assetId).toLowerCase() === CETH, `xbring: the reveal burns the note under its own ν, for tETH, with this key as its owner (${JSON.stringify(dec).slice(0, 160)})`);
  const row = (await text(r.page, '#eth-v1 .brr')).replace(/\s+/g, ' ');
  ok(/0\.004 tETH/.test(row) && /Burn sent|Confirmed/.test(row) && !!(await r.page.$('#eth-v1 .brr .stp li.now')), `xbring: it shows under Coming back with its steps (${row.slice(0, 160)})`);
  const rec = await r.page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]')[0], `tacit-burndep-bridge-v1:mainnet:${pub}`);
  ok(rec && rec.source.ticker === 'tETH' && rec.source.p2tr === true && rec.path === 'reflected', 'xbring: the bridge journal holds it as a tETH, Taproot-owned, reflected burn');
  // The tab and the row stay for a return in flight even with the setting off and no cross-out left to follow.
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));
  await r.page.evaluate(([k]) => localStorage.removeItem(k), [`tacit-crossout-bridge-v1:mainnet:${pub}`]);
  await go(r.page, '#private');
  await until(r.page, () => !!document.querySelector('#eth-v1 [data-v1="btc"]'), null, 60000);
  await go(r.page, '#private/bitcoin');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 1, null, 60000);
  ok(true, 'xbring: with the setting off and no cross-out under way, a return in flight keeps the tab and its Coming back row');
  await go(r.page, '#bridge');
  await until(r.page, () => !document.querySelector('#bridge-body')?.hidden, null, 60000);
  await sleep(1500);
  ok((await r.page.$$('#bridge-body .brr')).length === 0, 'xbring: the TAC Bridge tab does not list the tETH bridge');
  // The new sections at phone width: a note with its reason, a row with its steps, the receipt, and the find box, with no sideways scroll.
  await go(r.page, '#private/bitcoin');
  await until(r.page, () => document.querySelectorAll('#eth-v1 .brr').length === 1 && !!document.querySelector('#eth-v1 #xb-find'), null, 60000);
  await r.page.setViewportSize({ width: 360, height: 760 });
  await sleep(400);
  await r.page.evaluate(() => document.querySelector('#eth-v1 #xb-find')?.closest('details')?.setAttribute('open', ''));
  const wide = await r.page.evaluate(() => { const d = document.querySelector('#sheet-eth .sheet-in'); return [d.scrollWidth, d.clientWidth, document.documentElement.scrollWidth, innerWidth]; });
  ok(wide[0] <= wide[1] + 1 && wide[2] <= wide[3] + 1, `xbring: no sideways scroll at phone width (${wide})`);
  if (r.errors.length) { fails++; console.log('FAIL xbring page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});
// The TAC sheet's Bridge tab, To Bitcoin side (see the header of the cross-out block): the same bridge as tETH's, for TAC, with its own
// ids and flag. The pool module is stubbed to hold TAC notes (and a tETH note the size of one of them, which a TAC bridge must never take);
// Bitcoin and the proof answer from canned responses; the relay is the harness's own.
await step('xtbridge', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'b7e8'.padEnd(64, '5'), pubB = secp.getPublicKey(hex, true), pub = Buffer.from(pubB).toString('hex');
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  const api = (re, fn) => r.page.route(re, (route) => fn(route, new URL(route.request().url())));
  // Follow a link from nothing: two hash changes in one tick, with another sheet closing, lose the second (the closing sheet rewrites the address).
  const toSide = async (h = '#bridge/out') => { await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); }); await sleep(400); await go(r.page, h); };
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const note = (asset, value, i) => ({ asset, value: BigInt(value), blinding: BigInt(1000 + i), leafIndex: 900000 + i, leaf: '0x' + String(i).repeat(64).slice(0, 64), nullifier: '0x' + String(i + 1).repeat(64).slice(0, 64),
        cx: '0x' + String(i).repeat(64).slice(0, 64), cy: '0x01', owner: '0x' + '02'.repeat(32), secret: '0x' + '03'.repeat(32), root: '0x' + '04'.repeat(32), path: Array.from({ length: 32 }, () => '0x' + '00'.repeat(32)) });
      // Six TAC notes (50, 20, 1,200, 12, 8 and 25 TAC), and a tETH note of the same raw size as the first (never to be taken for a TAC bridge).
      const add = [note('${TAC}', 5000000000, 1), note('${TAC}', 2000000000, 2), note('${TAC}', 120000000000, 3), note('${TAC}', 1200000000, 4), note('${TAC}', 800000000, 5), note('${CETH}', 5000000000, 6), note('${TAC}', 2500000000, 7)];
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, ...add];
        for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
        return b;
      };
      return ux;
    }` }));
  let utxos = [];
  const head = Number(BigInt(await rpc('eth_blockNumber')));
  await api(/^https:\/\/api\.tacit\.finance\/confidential\/quote\?asset=cTAC/, (route) => json(route, { ticker: 'cTAC', relayFeeEligible: true, staticFloorUnits: '400000000', gasAwareFloorUnits: null }));   // the relay's own floor: 4 TAC
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/status/, (route) => json(route, { network: 'mainnet', attestedHeight: 970373, tipHeight: 970373, lagBlocks: 0 }));
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/eth-state\/covers/, (route, u) => json(route, { network: 'mainnet', block: Number(u.searchParams.get('block')), bestBlock: head - 300, confirmedBlock: head - 3000, covered: false }));
  await api(/^https:\/\/api\.tacit\.finance\/crossout\/minted/, (route, u) => json(route, { decided: u.searchParams.get('txid') === '9a'.repeat(32), minted: false, status: 'rejected' }));
  await api(/^https:\/\/(mempool\.space|blockstream\.info|api\.tacit\.finance\/chain)\/(api\/)?address\/[^/]+\/utxo/, (route) => json(route, utxos));
  await r.page.goto(r.url + '#wallet');
  await r.page.evaluate(async () => {
    globalThis.__TACIT_NO_INIT__ = true; localStorage.setItem('tacit-network-v1', 'mainnet');
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);
    T._testSetScanHoldingsOverride(() => new Map());
  });
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));

  // On unless switched off: with nothing set the Bridge tab has its To Bitcoin side; set to false, with no TAC bridge under way, it has none,
  // and a link to it opens the tab as it is.
  await go(r.page, '#bridge/out');
  await until(r.page, () => !!document.querySelector('#bridge-body [data-brm="out"][aria-selected="true"]') && !!document.querySelector('#xt-amt'), null, 120000);
  ok(true, 'xtbridge: with nothing set the Bridge tab has its To Bitcoin side, and #bridge/out opens it');
  await r.page.evaluate(() => localStorage.setItem('tacit-tac-btc', 'false'));
  await toSide();
  await until(r.page, () => !document.querySelector('#bridge-body')?.hidden, null, 120000);
  await sleep(1500);
  ok(!(await r.page.$('#bridge-body [data-brm]')) && !(await r.page.$('#xt-amt')), 'xtbridge: switched off, with no TAC bridge under way, the Bridge tab has no To Bitcoin side, and #bridge/out opens the tab as it is');
  await r.page.evaluate(() => localStorage.setItem('tacit-tac-btc', 'true'));
  await toSide();
  await until(r.page, () => !!document.querySelector('#bridge-body [data-brm="out"][aria-selected="true"]'), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | hash: ${await r.page.evaluate(() => location.hash)} | tab: ${await r.page.evaluate(() => document.querySelector('[data-tac-mode][aria-selected="true"]')?.dataset.tacMode)} | body: ${(await text(r.page, '#bridge-body')).replace(/\s+/g, ' ').slice(0, 200)} | flag: ${await r.page.evaluate(() => localStorage.getItem('tacit-tac-btc'))} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  ok((await r.page.evaluate(() => location.hash)) === '#bridge/out' && !!(await r.page.$('#bridge-body [data-brm="in"]')), 'xtbridge: enabled, the side is there, the link selects it and the address reads #bridge/out');
  await r.page.click('#bridge-body [data-brm="in"]');
  await until(r.page, () => !!document.querySelector('#bridge-body [data-brm="in"][aria-selected="true"]') && !!document.querySelector('#bridge-body #br-go'), null, 120000);
  ok((await r.page.evaluate(() => location.hash)) === '#bridge', 'xtbridge: the From Bitcoin side is the tab as it was, and its address is #bridge');
  await until(r.page, () => /No TAC on this key’s Bitcoin address/.test(document.querySelector('#bridge-body')?.textContent || ''), null, 120000);
  ok(/TAC bridged from Ethereum is listed under To Bitcoin\./.test(await text(r.page, '#bridge-body')), 'xtbridge: with the side on, the From side says where TAC bridged from Ethereum is listed');
  await r.page.evaluate(() => localStorage.setItem('tacit-tac-btc', 'false'));
  // The tETH tab does not take the TAC flag, nor the TAC side the tETH one.
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await toSide();
  await sleep(1500);
  ok(!(await r.page.$('#bridge-body [data-brm]')), 'xtbridge: the tETH setting does not turn on the TAC side');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));

  // A bridge already under way shows the side even when it is switched off, and its rows are TAC's alone.
  await r.page.evaluate(() => localStorage.setItem('tacit-tac-btc', 'false'));
  const big = (v) => ({ __big: String(v) }), ago = (ms) => Date.now() - ms;
  const src = (id, extra = {}) => ({ nullifier: id, value: big(5000000000), amount: big(4800000000), fee: big(200000000), assetId: TAC, ticker: 'TAC', ...extra });
  const settle = (n, extra = {}) => ({ txHash: n.repeat(32), claimId: '0x' + n.repeat(32), cx: '0x' + 'c2'.repeat(32), cy: '0x' + 'c3'.repeat(32), destCommitment: '0x' + 'dd'.repeat(32), ethBlock: head - 400, claimIdVerified: true, ...extra });
  const rec = (n, stage, extra = {}) => ({ id: '0x' + n.repeat(32), network: 'mainnet', walletPub: pub, stage, createdAt: ago(9e6 - Number('0x' + n) * 1e3), destXonly: 'ab'.repeat(32), source: src('0x' + n.repeat(32)), ...extra });
  const mint = { commitHex: '00', commitTxid: '8a'.repeat(32), revealHex: '00', revealTxid: '9a'.repeat(32), feeRate: 3 };
  const journal = [
    rec('a1', 'settling', { createdAt: ago(5 * 3600e3), startBlock: head - 50, dests: [{ amount: big(4800000000), cx: '0x' + 'c2'.repeat(32), cy: '0x' + 'c3'.repeat(32), destCommitment: '0x' + 'dd'.repeat(32) }], source: src('0x' + 'a1'.repeat(32), { attempts: ['200000000'] }) }),
    rec('a2', 'settled', { settle: settle('a2') }),
    rec('a3', 'covered', { settle: settle('a3'), lastError: { message: 'crossout-ux: Bitcoin fees are high right now (400 sat/vB), so the Bitcoin step is waiting for them to fall under 100', at: Date.now() }, errorCount: 1 }),
    rec('a4', 'mint-signed', { settle: settle('a4'), mint, lastError: { message: 'bad-txns-inputs-missingorspent', at: Date.now() }, errorCount: 3 }),
    rec('a5', 'mint-confirmed', { settle: settle('a5'), mint: { ...mint, revealTxid: '9b'.repeat(32) } }),
    rec('a6', 'mint-rejected', { settle: settle('a6'), mint, rejectedStatus: 'rejected' }),
    rec('a7', 'minted', { settle: settle('a7'), mint }),
    rec('a8', 'settled', { settle: settle('a8'), source: src('0x' + 'a8'.repeat(32), { assetId: CETH, ticker: 'tETH' }) }),
  ];
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify(journal)]);
  await toSide();
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 6, null, 120000);
  ok(!!(await r.page.$('#bridge-body [data-brm="out"][aria-selected="true"]')) && (await r.page.evaluate(() => location.hash)) === '#bridge/out', 'xtbridge: a TAC bridge under way shows the side, selected by the link');
  const rows = await r.page.$$eval('#bridge-body .brr', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 6 && !rows.some((x) => /tETH/.test(x)) && /Sent to Ethereum/.test(rows[0]) && /Waiting for Bitcoin’s proof/.test(rows[1]) && /fees are high/.test(rows[2]) && /Waiting for the TAC to be credited/.test(rows[4]) && /TAC was not credited/.test(rows[5]),
    `xtbridge: the six unfinished TAC bridges are listed in order, a finished one and a tETH one are not (${rows.length}: ${rows.map((x) => x.slice(0, 80)).join(' || ')})`);
  ok(/48 TAC/.test(rows[0]) && !!(await r.page.$('#bridge-body .brr:nth-child(1) .stp li.now')), 'xtbridge: a row names what arrives (the note less the relay fee, in TAC) and marks its step');
  ok(/Cancel/.test(rows[0]) && /Look again/.test(rows[0]) && /Send it anyway/.test(rows[2]) && /Sign it again/.test(rows[3]), 'xtbridge: the rows offer what each state allows');
  ok(!!(await r.page.$('[data-tac-mode="bridge"] .dot.live')), 'xtbridge: the Bridge tab carries a dot while a bridge is under way');
  // The lander's dashboard says so too, for each asset: what needs the holder in one line, where the rest is in another, and a way to them.
  await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  await until(r.page, () => /3 bridges of TAC to Bitcoin are waiting for you\./.test(document.querySelector('#dash')?.textContent || ''), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | dash: ${(await text(r.page, '#dash')).replace(/\s+/g, ' ').slice(0, 500)}`); });
  const dash0 = (await text(r.page, '#dash')).replace(/\s+/g, ' ');
  ok(/48 tETH is on its way from Ethereum to Bitcoin, waiting for Bitcoin’s proof on Ethereum to see the burn\./.test(dash0), `xtbridge: the dashboard names the TAC bridges that wait for the holder and says where a tETH one is (${dash0.slice(0, 260)})`);
  await r.page.click('#dash [data-dash-do="bridge/out"]');
  await until(r.page, () => location.hash === '#bridge/out' && document.querySelectorAll('#bridge-body .brr').length === 6, null, 120000);
  ok(true, 'xtbridge: and its button opens the To Bitcoin side');
  // The tETH tab sees the TAC bridges as nothing of its own.
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await toSide('#private/bitcoin');
  await sleep(2500);
  const tethRows = await r.page.$$eval('#eth-v1 .brr', (xs) => xs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(tethRows.length === 1 && /tETH/.test(tethRows[0]) && !/TAC/.test(tethRows[0].replace(/tETH/g, '')), `xtbridge: the tETH tab lists the tETH bridge and none of TAC's (${tethRows.length})`);
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));
  // Cancelling the old unseen burn drops it, as for tETH.
  await toSide();
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 6, null, 120000);
  await r.page.click('#bridge-body [data-xoact="cancel"]');
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 5, null, 120000);
  ok(/Cancelled: no burn for it was found on Ethereum/.test(await text(r.page, '#xt-rstatus')), 'xtbridge: cancelling it drops the row once Ethereum shows no burn for it');

  // A record from before the ticker and the amount were kept (the asset's id and the note's value only) is still TAC, and read as one.
  const jkey = `tacit-crossout-bridge-v1:mainnet:${pub}`, kept = await r.page.evaluate((k) => localStorage.getItem(k), jkey);
  const older = rec('b1', 'settled', { settle: settle('b1'), source: { nullifier: '0x' + 'b1'.repeat(32), value: big(5000000000), assetId: TAC } });
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [jkey, JSON.stringify([older])]);
  await toSide();
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 1, null, 120000);
  const olderRow = (await text(r.page, '#bridge-body .brr')).replace(/\s+/g, ' ');
  ok(/50 TAC/.test(olderRow) && !/tETH/.test(olderRow), `xtbridge: an older TAC record, kept with no ticker, is read as TAC (${olderRow.slice(0, 120)})`);
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [jkey, kept]);
  await toSide();
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 5, null, 120000);
  // Without the setting the side only follows the bridges under way; with it, a new one can be started.
  ok(!(await r.page.$('#xt-amt')), 'xtbridge: without the setting, bridges under way are followed and no new one is offered');
  await r.page.evaluate(() => localStorage.setItem('tacit-tac-btc', 'true'));
  await toSide();
  await r.page.waitForSelector('#xt-amt');
  await r.page.fill('#xt-amt', '50');
  await until(r.page, () => /Bitcoin fee, when it is sent/.test(document.querySelector('#xt-rcpt')?.textContent || ''), null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | receipt: ${(await text(r.page, '#xt-rcpt')).replace(/\s+/g, ' ')} | status: ${await text(r.page, '#bt-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
  const rc0 = (await text(r.page, '#xt-rcpt')).replace(/\s+/g, ' ');
  ok(/You get46 TAC on your Bitcoin address/.test(rc0) && /Relay fee4 TAC/.test(rc0) && /Arrivesusually a few hours, sometimes up to a day/.test(rc0) && !/Relay fee to (split|combine)/.test(rc0), `xtbridge: the receipt names what arrives (50 less the relay's 4 TAC floor), the fee and the time, with no split since a note is exactly that size (${rc0.slice(0, 200)})`);
  ok(/If the relay’s floor has moved by the time it takes the burn, its fee is 8 TAC and 4 TAC less arrives\./.test(rc0), 'xtbridge: the receipt says what the fee is if the relay’s floor has moved: 8 TAC, with 4 TAC less arriving');
  ok(/needs a coin of \d[\d,]* sats|needs one coin of \d[\d,]* sats/.test(rc0) && await r.page.isDisabled('#xt-go') && await r.page.isHidden('#xt-ackrow'), 'xtbridge: with no sats on the key’s Bitcoin address it cannot start, and says how many it needs');
  utxos = Array.from({ length: 8 }, (_, i) => ({ txid: (i + 10).toString(16).padStart(2, '0').repeat(32), vout: 0, value: 20000, status: { confirmed: true, block_height: 970000 } }));
  await r.page.click('#xt-recheck');
  await until(r.page, () => !document.querySelector('#xt-ackrow')?.hidden, null, 240000).catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | receipt: ${(await text(r.page, '#xt-rcpt')).replace(/\s+/g, ' ')}`); });
  ok(await r.page.isDisabled('#xt-go'), 'xtbridge: with sats free, the button still waits for the box to be ticked');
  await r.page.check('#xt-ack');
  ok(!(await r.page.isDisabled('#xt-go')), 'xtbridge: ticked, it can start');
  // The limits: over the cap, under the minimum, and the fee taking all of it.
  await r.page.fill('#xt-amt', '1001');
  await until(r.page, () => /at most 1,000 TAC/.test(document.querySelector('#xt-rcpt')?.textContent || ''), null, 120000);
  ok(await r.page.isDisabled('#xt-go') && await r.page.isHidden('#xt-ackrow'), 'xtbridge: more than the limit is refused with the limit named, and the box goes away');
  await r.page.fill('#xt-amt', '5');
  await until(r.page, () => /at least 20 TAC/.test(document.querySelector('#xt-rcpt')?.textContent || ''), null, 120000);
  ok(await r.page.isDisabled('#xt-go'), 'xtbridge: under the minimum is refused with the minimum named');
  // More than is held (1,290 TAC in all, 1,200 of it one note over the limit).
  await r.page.fill('#xt-amt', '1290');
  await until(r.page, () => /at most 1,000 TAC|private balance/.test(document.querySelector('#xt-rcpt')?.textContent || ''), null, 120000);
  ok(await r.page.isDisabled('#xt-go'), 'xtbridge: a figure over the limit or the balance is refused');

  // The card says what the sheet will: what arrives, the cut of a note of that size when no note is, and nothing promised for a size the sheet refuses.
  const lander = () => r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  await lander();
  await r.page.click('[data-hxm="private"]'); await r.page.selectOption('#hx-from', 'tac');
  await until(r.page, () => document.querySelector('#hx-go')?.textContent === 'Bridge TAC to Bitcoin', null, 60000);
  const cardAt = async (v, out, line) => {
    await r.page.fill('#hx-amt', v);
    await until(r.page, ([o, l]) => document.querySelector('#hx-out')?.textContent === o && new RegExp(l).test(document.querySelector('#hx-q')?.textContent || ''), [out, line], 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | card at ${v}: ${(await text(r.page, '#hx-body')).replace(/\s+/g, ' ').slice(0, 300)}`); });
    return (await text(r.page, '#hx-q')).replace(/\s+/g, ' ');
  };
  const l50 = await cardAt('50', '46', '^Relay fee 4 TAC');
  ok(!/cut a note/.test(l50), `xtbridge: the card shows 50 TAC as 46 with no cut, a note being exactly 50 (${l50.slice(0, 100)})`);
  const l40 = await cardAt('40', '36', 'to cut a note of this size');
  ok(/^Relay fee 4 TAC \(8 TAC if its floor has moved\), and 2 TAC to cut a note of this size,/.test(l40), `xtbridge: and 40 TAC as 36 with the cut named, no note being exactly 40 (${l40.slice(0, 120)})`);
  const l5 = await cardAt('5', '—', '^A bridge takes 20 to 1,000 TAC while this is new\\.$');
  const l5000 = await cardAt('5000', '—', '^A bridge takes 20 to 1,000 TAC while this is new\\.$');
  ok(l5.length > 0 && l5000.length > 0, `xtbridge: and a size the sheet refuses is not quoted, on either side of its limits (${l5} | ${l5000})`);
  await r.page.fill('#hx-amt', '40');
  await until(r.page, () => document.querySelector('#hx-out')?.textContent === '36', null, 120000);
  await r.page.click('#hx-go');
  await until(r.page, () => location.hash === '#bridge/out' && document.querySelector('#xt-amt')?.value === '40' && /Relay fee to split a note/.test(document.querySelector('#xt-rcpt')?.textContent || ''), null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | hash ${await r.page.evaluate(() => location.hash)} | rcpt: ${(await text(r.page, '#xt-rcpt')).replace(/\s+/g, ' ')}`); });
  const sheet40 = (await text(r.page, '#xt-rcpt')).replace(/\s+/g, ' ');
  ok(/You get36 TAC/.test(sheet40) && /Relay fee to split a note2 TAC/.test(sheet40), `xtbridge: the sheet it opens says the same: 36 arrives and 2 TAC more cuts the note (${sheet40.slice(0, 150)})`);
  await r.page.fill('#xt-amt', '');
  await until(r.page, () => document.querySelector('#xt-rcpt')?.hidden, null, 30000);

  // Start one: the page checks again, takes the TAC note of exactly that size (never the tETH note the same raw size), and the relay is
  // sent a bridge-burn job at the relay's 4 TAC floor; the harness's relay then reports the job failed, and the intent record is what is left.
  const before = submits.length;
  await r.page.fill('#xt-amt', '50');
  await until(r.page, () => !document.querySelector('#xt-ackrow')?.hidden, null, 240000);
  await r.page.check('#xt-ack');
  await r.page.click('#xt-go');
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 6, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#bt-status')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const sent = submits.slice(before);
  ok(sent.length === 1 && /bridgeburn/i.test(JSON.stringify(sent[0]).slice(0, 400)), `xtbridge: starting one sends the relay a bridge-burn job (${sent.length}: ${JSON.stringify(sent[0] || {}).slice(0, 160)})`);
  const after = await r.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), `tacit-crossout-bridge-v1:mainnet:${pub}`);
  const mine = after.find((x) => x.id === '0x' + '2'.repeat(64));
  ok(!!mine && mine.stage === 'settling' && mine.source.ticker === 'TAC' && String(mine.source.assetId).toLowerCase() === TAC && !after.some((x) => x.id === '0x' + '7'.repeat(64)) && mine.startBlock >= head && mine.source.attempts.length === 1 && String(mine.source.attempts[0]) === '400000000',
    'xtbridge: a settle the page could not see through leaves an intent record for the TAC note (not the tETH one), at the 4 TAC fee, with where to look for it');
  const said = (await text(r.page, '#bt-status')).replace(/\s+/g, ' ').trim();
  ok(said.length > 0 && !/Burned on Ethereum/.test(said), `xtbridge: the failure is reported on the sheet, not passed off as a burn (${said.slice(0, 140)})`);

  // A send the relay refuses at submit: nothing was queued, so the intent is let go and the paying account is offered.
  refuseSubmits = 1;
  await r.page.fill('#xt-amt', '20');                       // another whole note (the first is held by the action still following its job)
  await until(r.page, () => !document.querySelector('#xt-ackrow')?.hidden, null, 240000);
  await r.page.check('#xt-ack');
  await r.page.click('#xt-go');
  await until(r.page, () => !!document.querySelector('#bt-status [data-selfdo]'), null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#bt-status')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const left = JSON.parse(await r.page.evaluate((k) => localStorage.getItem(k), `tacit-crossout-bridge-v1:mainnet:${pub}`));
  ok(!left.some((x) => x.id === '0x' + '3'.repeat(64)) && left.some((x) => x.id === '0x' + '2'.repeat(64)) && refused.length > 0, 'xtbridge: a send the relay refuses at submit offers the paying account and leaves no record of that note behind');
  // A relay that turns the fee down when it picks the job up: asked once more at a doubled fee on the ladder (4 TAC to 8 TAC).
  await r.page.fill('#xt-amt', '');
  await until(r.page, () => document.querySelector('#xt-rcpt')?.hidden, null, 30000);
  await r.page.fill('#xt-amt', '25');
  await until(r.page, () => /Relay fee4 TAC/.test(document.querySelector('#xt-rcpt')?.textContent || '') && !document.querySelector('#xt-ackrow')?.hidden, null, 240000);
  statusError = 'feeGate: bound fee is below the marginal cost at this gas';
  const b2 = submits.length;
  await r.page.check('#xt-ack');
  await r.page.click('#xt-go');
  for (const t0 = Date.now(); submits.length - b2 < 2 && Date.now() - t0 < 240000;) await sleep(500);
  await sleep(3000);
  const fees = submits.slice(b2).map((b) => BigInt(b.op?.fee ?? b.fee ?? -1));
  ok(fees.length === 2 && fees[0] === 400000000n && fees[1] === 800000000n, `xtbridge: a fee the relay turns down is asked again once at a doubled fee (${fees.join(' → ')})`);
  statusError = 'stubbed in the fork check';
  await r.page.setViewportSize({ width: 360, height: 760 });
  await sleep(400);
  await r.page.evaluate(() => document.querySelector('#bridge-body #xt-find')?.closest('details')?.setAttribute('open', ''));
  const wideXt = await r.page.evaluate(() => { const d = document.querySelector('#sheet-tac .sheet-in'); return [d.scrollWidth, d.clientWidth, document.documentElement.scrollWidth, innerWidth]; });
  ok(wideXt[0] <= wideXt[1] + 1 && wideXt[2] <= wideXt[3] + 1, `xtbridge: no sideways scroll at phone width (${wideXt})`);
  if (r.errors.length) { fails++; console.log('FAIL xtbridge page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

// The TAC sheet's To Bitcoin side, TAC on Bitcoin and the way back (see the header of the cross-out block). The key's Taproot output holds two
// TAC notes made by real, signed cross-out mint reveals (built in the page with its own modules): the journal remembers one, and not the
// other, whose amount (30 TAC) is past the search's reach and is found from the note this key spent to make it (the pool scan's spent notes
// and the settle's event, both stubbed). The explorers, Bitcoin's proof and the worker answer from canned responses.
await step('xtring', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'c7e8'.padEnd(64, '6'), privB = Buffer.from(hex, 'hex'), pubB = secp.getPublicKey(privB, true), pub = Buffer.from(pubB).toString('hex'), XONLY = '0x' + pub.slice(2);
  const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', CROSSOUT_TOPIC = '0x1dcbefc1323b3b80f7cedfeb490313eff6ded6186b4cf10d72b383ee81d90c13';
  const { makeConfidentialPool } = await import(new URL('../dapp/confidential-pool.js', import.meta.url));
  const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const rev = (h) => h.match(/../g).reverse().join('');
  const api = (re, fn) => r.page.route(re, (route) => fn(route, new URL(route.request().url())));
  // Follow a link from nothing: two hash changes in one tick, with another sheet closing, lose the second (the closing sheet rewrites the address).
  const toSide = async (h = '#bridge/out') => { await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); }); await sleep(400); await go(r.page, h); };
  // A cross-out's destination blinding is HMAC(key, 'tacit-crossout-blinding-v1' || nullifier) mod n, as crossOut() derives it.
  const derive = (nullifier) => { const m = Buffer.concat([Buffer.from('tacit-crossout-blinding-v1'), Buffer.from(nullifier.slice(2), 'hex')]); let b = 0n; for (const x of hmac(sha256, privB, m)) b = (b << 8n) | BigInt(x); b %= secp.CURVE.n; return b === 0n ? 1n : b; };
  const mk = (amount, claim, nullifier) => { const nu = '0x' + nullifier.repeat(32), blinding = derive(nu), { cx, cy } = pool.commitXY(amount, blinding); return { amount, blinding, cx, cy, claimId: '0x' + claim.repeat(32), nullifier: nu }; };
  // A (40 TAC, in Bitcoin's proof) and B (30 TAC, made in a block the proof has not reached); each made from a 42 and a 32 TAC note, less the 2 TAC fee.
  const NA = mk(4_000_000_000n, 'c1', 'a1'), NB = mk(3_000_000_000n, 'c2', 'a2');
  // The page reads the pool module with a token, tacit.js (where a bridge is rebuilt from its burn) without: both get the stub.
  const poolStub = `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv, opts) => {
        const b = await balance(priv, opts);
        if (opts && opts.spent) b.spentNotes = [...(b.spentNotes || []), { nullifier: '${NB.nullifier}', asset: '${TAC}', value: 3200000000n }, { nullifier: '${NA.nullifier}', asset: '${TAC}', value: 4200000000n }];
        return b;
      };
      return ux;
    }`;
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: poolStub }));
  await r.page.route(/\/confidential-pool-ux\.js$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: poolStub }));
  await r.page.goto(r.url + '#wallet');
  await r.page.evaluate(async () => {
    globalThis.__TACIT_NO_INIT__ = true; localStorage.setItem('tacit-network-v1', 'mainnet');
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);
    T._testSetScanHoldingsOverride(() => new Map());
  });
  const built = await r.page.evaluate(async ([hexKey, xonly, asset, notes]) => {
    const { makeBtcWallet } = await import('/bitcoin-taproot-wallet.js');
    const { makeCrossoutMintReveal } = await import('/crossout-mint-reveal.js');
    const { secp } = await import('/vendor/tacit-deps.min.js');
    const priv = Uint8Array.from(hexKey.match(/../g).map((b) => parseInt(b, 16)));
    const w = makeBtcWallet({ priv, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 3 });
    const mr = makeCrossoutMintReveal({ secp });
    return notes.map((n, i) => { const b = mr.buildCrossoutMintTxs({ prims: w.prims, assetId: asset, claimId: n.claimId, cx: n.cx, cy: n.cy, destXonly: xonly, fundingUtxo: { txid: String(i + 1).repeat(64), vout: 0, value: 50000 }, feeRate: 3 }); return { revealHex: b.revealHex, revealTxid: b.revealTxid }; });
  }, [hex, XONLY, TAC, [NA, NB].map((n) => ({ claimId: n.claimId, cx: n.cx, cy: n.cy }))]);
  NA.revealHex = built[0].revealHex; NA.txid = built[0].revealTxid; NB.revealHex = built[1].revealHex; NB.txid = built[1].revealTxid;
  const leafOf = (n) => pool.btcNoteLeaf(TAC, n.cx, n.cy, XONLY);
  const addrP2tr = await r.page.evaluate(async (x) => (await import('/crossout-notes.js')).p2trAddress(x.slice(2), 'bc'), XONLY);
  // Ethereum's own log of B's settle, which the journal does not have: its claim, its destination, the note it spent and its asset.
  const head = Number(BigInt(await rpc('eth_blockNumber')));
  const logOf = (n, tx) => ({ address: POOL, topics: [CROSSOUT_TOPIC, n.claimId], data: '0x' + '00'.repeat(31) + '01' + leafOf(n).slice(2) + n.nullifier.slice(2) + TAC.slice(2), blockNumber: '0x' + (head - 100).toString(16), transactionHash: '0x' + tx.repeat(32), logIndex: '0x0' });
  const logs = new Map([[NB.claimId, logOf(NB, 'e2')], [NA.claimId, logOf(NA, 'e1')]]);               // A's is looked for only when its bridge is rebuilt from its burn
  for (const h of ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'cloudflare-eth.com', 'rpc.flashbots.net'])
    await r.page.route(`https://${h}/**`, async (route) => {
      try {
        const b = JSON.parse(route.request().postData() || '{}');
        if (b.method === 'eth_getLogs' && b.params?.[0]?.topics?.[0] === CROSSOUT_TOPIC && logs.has(String(b.params[0].topics[1] || '').toLowerCase())) {
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: [logs.get(String(b.params[0].topics[1]).toLowerCase())] }) });
        }
      } catch { /* not a single JSON-RPC call: the fork answers it */ }
      return route.fallback();
    });
  const posts = [];
  let feeNow = 150;                                                                  // high at first: a return waits for fees to fall
  let burn = null;                                                                   // the burn the page sent, once it has: { txid, hex, vin, commitTxid, commitHex }
  const plainText = (route, body) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body });
  const explorer = (route, u) => {
    const p = u.pathname.replace(/^\/api/, '').replace(/^\/chain/, '');
    if (route.request().method() === 'POST' && p === '/tx') { posts.push(route.request().postData()); return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'ab'.repeat(32) }); }
    if (burn && p === `/tx/${burn.txid}`) return json(route, { txid: burn.txid, status: { confirmed: true, block_height: 970050 }, vin: burn.vin.map((v, i) => ({ ...v, prevout: { value: i ? 330 : 1500 } })), vout: [] });
    if (burn && p === `/tx/${burn.txid}/hex`) return plainText(route, burn.hex);
    if (burn && p === `/tx/${burn.commitTxid}/hex`) return plainText(route, burn.commitHex);
    if (p === `/address/${addrP2tr}/utxo`) return json(route, [NA, NB].map((n) => ({ txid: n.txid, vout: 0, value: 330, status: { confirmed: true, block_height: n === NA ? 970000 : 970200 } })));
    if (/^\/address\/bc1q[0-9a-z]+\/utxo$/.test(p)) return json(route, [{ txid: 'f1'.repeat(32), vout: 0, value: 20000, status: { confirmed: true, block_height: 960000 } }]);
    for (const n of [NA, NB]) {
      if (p === `/tx/${n.txid}/hex`) return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: n.revealHex });
      if (p === `/tx/${n.txid}`) return json(route, { txid: n.txid, status: { confirmed: true, block_height: n === NA ? 970000 : 970200 }, vout: [{ scriptpubkey: '5120' + XONLY.slice(2), value: 330 }] });
    }
    if (/\/fees\/recommended$/.test(p)) return json(route, { fastestFee: feeNow, halfHourFee: feeNow, hourFee: Math.min(feeNow, 2), economyFee: 1, minimumFee: 1 });
    if (/\/fee-estimates$/.test(p)) return json(route, { 1: feeNow, 6: Math.min(feeNow, 2), 144: 1 });
    return route.fallback();
  };
  await api(/^https:\/\/(mempool\.space|blockstream\.info)\/api\//, explorer);
  await api(/^https:\/\/api\.tacit\.finance\/chain\//, explorer);
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/dump/, (route) => json(route, { attestedHeight: 970100, snapshot: { height: 970100,
    liveTriples: [[pool.outpointKey('0x' + rev(NA.txid), 0), pool.commitmentHash(NA.cx, NA.cy), TAC, XONLY, 0]], noteLeaves: [leafOf(NA)], spentLinks: [],
    burnNodes: [['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), true]], pendingDepositRecords: [] } }));
  await api(/^https:\/\/api\.tacit\.finance\/crossout\/minted/, (route) => json(route, { decided: false, minted: false }));
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/(status|eth-state)/, (route) => json(route, { network: 'mainnet', attestedHeight: 970100, tipHeight: 970100, lagBlocks: 0 }));

  // The journal remembers A's settle only (a minted cross-out), which spares A its Ethereum lookup and its search.
  const big = (v) => ({ __big: String(v) });
  const jr = (n) => ({ id: n.nullifier, network: 'mainnet', walletPub: pub, stage: 'minted', createdAt: Date.now() - 36e5, destXonly: XONLY.slice(2),
    source: { nullifier: n.nullifier, value: big(n.amount + 200000000n), amount: big(n.amount), fee: big(200000000), assetId: TAC, ticker: 'TAC' }, settle: { txHash: 'e1'.repeat(32), claimId: n.claimId, cx: n.cx, cy: n.cy, ethBlock: 26000000, claimIdVerified: true } });
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify([jr(NA)])]);
  await r.page.evaluate(() => localStorage.setItem('tacit-tac-btc', 'true'));
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  await go(r.page, '#bridge/out');
  await r.page.waitForSelector('#xc-look', { timeout: 120000 });
  ok(/Look for it/.test(await text(r.page, '#bridge-body')), 'xtring: bridged TAC is listed on request, so a key that has bridged nothing loads nothing');
  // A key with no private TAC at all is told so, and where to get some, rather than that the amount is "more than your private balance".
  await r.page.fill('#xt-amt', '25');
  await until(r.page, () => /You have no private TAC yet\./.test(document.querySelector('#xt-rcpt')?.textContent || ''), null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | rcpt: ${(await text(r.page, '#xt-rcpt')).replace(/\s+/g, ' ')}`); });
  ok(/Make TAC private above, buy it on the Buy tab, or bring it from Bitcoin/.test(await text(r.page, '#xt-rcpt')), 'xtring: a key with no private TAC is told where to get some');
  await r.page.fill('#xt-amt', '');
  await r.page.click('#xc-look');
  await until(r.page, () => document.querySelectorAll('#bridge-body input[name="xc-note"]').length === 2, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | section: ${(await text(r.page, '#bridge-body')).replace(/\s+/g, ' ').slice(-420)} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const items = await r.page.$$eval('#bridge-body label.brn', (xs) => xs.map((x) => ({ text: x.textContent.replace(/\s+/g, ' ').trim(), off: x.classList.contains('off') })));
  ok(items.length === 2 && items.some((x) => /40 TAC/.test(x.text) && !x.off) && items.some((x) => /30 TAC/.test(x.text) && x.off && /Waiting for Bitcoin’s proof on Ethereum to reach its block/.test(x.text)),
    `xtring: both notes are found with their amounts (the 30 TAC one, past the search's reach, from the note spent to make it); the one the proof has recorded can be chosen, the other says why not (${items.map((x) => x.text).join(' | ')})`);
  // Above the ceiling nothing is offered: the receipt says so, with the cost, and there is no box to tick.
  await until(r.page, () => /fees are high right now/.test(document.querySelector('#xc-rcpt')?.textContent || ''), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | rcpt: ${(await text(r.page, '#xc-rcpt')).replace(/\s+/g, ' ')}`); });
  ok(/16\d sat\/vB/.test(await text(r.page, '#xc-rcpt')) && !(await r.page.isVisible('#xc-ackrow')) && /Bringing TAC back waits/.test(await text(r.page, '#xc-rcpt')), 'xtring: at 165 sat/vB the return is not offered, the receipt says why, in TAC, and there is nothing to tick');
  feeNow = 3;
  await sleep(62000);                                                                 // the page keeps a fee for a minute
  await r.page.evaluate(() => document.querySelector('input[name="xc-note"]:checked')?.dispatchEvent(new Event('change')));
  await until(r.page, () => /You get[^]*40 private TAC on Ethereum/.test(document.querySelector('#xc-rcpt')?.textContent || ''), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | rcpt: ${(await text(r.page, '#xc-rcpt')).replace(/\s+/g, ' ')}`); });
  const rc = (await text(r.page, '#xc-rcpt')).replace(/\s+/g, ' ');
  ok(/Relay feeNone/.test(rc) && /Bitcoin feeabout [\d,]+ sats/.test(rc), `xtring: the one ready note is chosen for the holder and its receipt names what arrives and the Bitcoin fee (${rc.slice(0, 200)})`);
  ok(await r.page.isDisabled('#xc-go'), 'xtring: the button waits for the box to be ticked');
  await r.page.check('#xc-ack');
  ok(!(await r.page.isDisabled('#xc-go')), 'xtring: ticked, it can start');
  const before = posts.length;
  await r.page.click('#xc-go');
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 1, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#bt-status')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const sent = [...new Set(posts.slice(before))];
  ok(sent.length === 2, `xtring: the burn is signed and its commit and reveal go out through ordinary relay (${sent.length} transactions)`);
  const decs = await r.page.evaluate(async (txs) => { const { classifyConfidentialTx } = await import('/burn-deposit-bitcoin.js'); return txs.map((h) => { const d = classifyConfidentialTx('0x' + h); return d ? { type: d.type, nullifier: d.nullifier, assetId: d.assetId, target: d.target } : null; }); }, sent);
  const dec = decs.find((d) => d && d.type === 'burn') || null;
  const nu = pool.nullifier(pool.btcNoteLeaf(TAC, NA.cx, NA.cy, XONLY));
  ok(dec && dec.nullifier === nu && String(dec.assetId).toLowerCase() === TAC, `xtring: the reveal burns the note under its own ν, for TAC, with this key as its owner (${JSON.stringify(dec).slice(0, 160)})`);
  const row = (await text(r.page, '#bridge-body .brr')).replace(/\s+/g, ' ');
  ok(/40 TAC/.test(row) && /Burn sent|Confirmed/.test(row) && !!(await r.page.$('#bridge-body .brr .stp li.now')), `xtring: it shows under Coming back with its steps (${row.slice(0, 160)})`);
  const rec = await r.page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]')[0], `tacit-burndep-bridge-v1:mainnet:${pub}`);
  ok(rec && rec.source.ticker === 'TAC' && rec.source.p2tr === true && rec.path === 'reflected', 'xtring: the bridge journal holds it as a TAC, Taproot-owned, reflected burn');
  // The Private ETH sheet's tETH tab does not take a TAC return as its own.
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await toSide('#private/bitcoin');
  await sleep(2500);
  ok((await r.page.$$('#eth-v1 .brr')).length === 0, 'xtring: the tETH tab does not list the TAC return');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));
  // A press on the return's row reports on this side's own line (it looked for the other side's, and a press said nothing here).
  await toSide();
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 1 && !!document.querySelector('#bridge-body .brr [data-bract="poll"]'), null, 120000);
  await r.page.click('#bridge-body .brr [data-bract="poll"]');
  await until(r.page, () => /Not yet|Checking|arrived/.test(document.querySelector('#xc-rstatus')?.textContent || ''), null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | line: ${await text(r.page, '#xc-rstatus')} | body: ${(await text(r.page, '#bridge-body')).replace(/\s+/g, ' ').slice(0, 300)}`); });
  const said = (await text(r.page, '#xc-rstatus')).replace(/\s+/g, ' ');
  ok(/^(Not yet|Checking)/.test(said), `xtring: Check now on a return reports on the To Bitcoin side's own line (${said.slice(0, 120)})`);
  // Cancel is pressed twice; this one is not offered (a burn Bitcoin has taken), so the explanation is checked on the burn's own record below.
  // Rebuilt from its burn alone: the journal is gone (another device, cleared storage) and the burn's transaction id is all there is. That note
  // is 40 TAC, past the search's reach, so its amount is found from the key's own spent notes, which tacit.js reads for itself.
  const rawTx = (hex) => {                                                          // a transaction's id and inputs, read from its raw hex
    const b = Buffer.from(hex, 'hex'), seg = b[4] === 0 && b[5] === 1, inStart = seg ? 6 : 4; let o = inStart;
    const varint = () => { const f = b[o++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(o); o += 2; return v; } const v = b.readUInt32LE(o); o += 4; return v; };
    const vin = [], nin = varint();
    for (let i = 0; i < nin; i++) { const txid = Buffer.from(b.subarray(o, o + 32)).reverse().toString('hex'); o += 32; const vout = b.readUInt32LE(o); o += 4; const sl = varint(); o += sl + 4; vin.push({ txid, vout }); }
    const nout = varint(); for (let i = 0; i < nout; i++) { o += 8; const sl = varint(); o += sl; }
    const legacy = Buffer.concat([b.subarray(0, 4), b.subarray(inStart, o), b.subarray(b.length - 4)]);   // what a transaction id hashes: no witness
    return { txid: Buffer.from(sha256(sha256(legacy))).reverse().toString('hex'), vin };
  };
  const bi = decs.findIndex((d) => d && d.type === 'burn'), ci = bi === 0 ? 1 : 0, btx = rawTx(sent[bi]), ctx = rawTx(sent[ci]);
  ok(btx.vin.length === 2 && btx.vin[0].txid === ctx.txid && btx.vin[1].txid === NA.txid && btx.vin[1].vout === 0, `xtring: the burn spends its commit's output and the 40 TAC note (${JSON.stringify(btx.vin).slice(0, 140)})`);
  burn = { txid: btx.txid, hex: sent[bi], vin: btx.vin, commitTxid: ctx.txid, commitHex: sent[ci] };
  await r.page.evaluate(([k]) => localStorage.removeItem(k), [`tacit-burndep-bridge-v1:mainnet:${pub}`]);
  await toSide();
  await until(r.page, () => !!document.querySelector('#bridge-body #xc-find') && document.querySelectorAll('#bridge-body .brr').length === 0, null, 120000);
  await r.page.evaluate(() => document.querySelector('#bridge-body #xc-find')?.closest('details')?.setAttribute('open', ''));
  await r.page.fill('#xc-txid', burn.txid);
  await r.page.click('#xc-find');
  await until(r.page, () => /Found it/.test(document.querySelector('#xc-fstatus')?.textContent || '') && document.querySelectorAll('#bridge-body .brr').length === 1, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | find: ${await text(r.page, '#xc-fstatus')} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const rebuilt = await r.page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]')[0], `tacit-burndep-bridge-v1:mainnet:${pub}`);
  ok(rebuilt && rebuilt.source.amount?.__big === '4000000000' && rebuilt.source.p2tr === true && rebuilt.source.ticker === 'TAC' && rebuilt.path === 'reflected',
    `xtring: a return whose journal is gone is rebuilt from its burn and the key alone, its 40 TAC read from the key's own spent notes (${JSON.stringify(rebuilt?.source?.amount)})`);
  // The setting off, with no cross-out left to follow.
  await r.page.evaluate(() => localStorage.setItem('tacit-tac-btc', 'false'));
  await r.page.evaluate(([k]) => localStorage.removeItem(k), [`tacit-crossout-bridge-v1:mainnet:${pub}`]);
  await toSide();
  await until(r.page, () => document.querySelector('#sheet-tac')?.open && !document.querySelector('#bridge-body')?.hidden && !!document.querySelector('#bridge-body [data-brm="out"][aria-selected="true"]') && document.querySelectorAll('#bridge-body .brr').length === 1, null, 120000);
  ok(true, 'xtring: with the setting off and no cross-out under way, a return in flight keeps the side and its Coming back row');
  // The From Bitcoin side lists the same bridge, as it lists every TAC bridge.
  await r.page.click('#bridge-body [data-brm="in"]');
  await until(r.page, () => document.querySelector('#sheet-tac')?.open && !document.querySelector('#bridge-body')?.hidden && !!document.querySelector('#bridge-body #br-go') && document.querySelectorAll('#bridge-body .brr').length >= 1, null, 120000);
  ok(true, 'xtring: the From Bitcoin side lists it too, among the TAC bridges');
  // An ordinary TAC bridge from Bitcoin (no Taproot output) does not keep the To Bitcoin side.
  const plain = { ...rec, id: 'f2'.repeat(32) + ':0', source: { ...rec.source, txid: 'f2'.repeat(32), p2tr: undefined } };
  // Both in one journal (a return, and an ordinary bridge in): the side stays for the return and lists only it, the From side lists both,
  // and the tETH tab lists neither.
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-burndep-bridge-v1:mainnet:${pub}`, JSON.stringify([rec, plain])]);
  await toSide();
  await until(r.page, () => document.querySelector('#sheet-tac')?.open && !!document.querySelector('#bridge-body [data-brm="out"][aria-selected="true"]') && document.querySelectorAll('#bridge-body .brr').length === 1, null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | rows: ${(await r.page.$$('#bridge-body .brr')).length} | body: ${(await text(r.page, '#bridge-body')).replace(/\s+/g, ' ').slice(0, 240)}`); });
  ok(/40 TAC/.test(await text(r.page, '#bridge-body .brr')), 'xtring: with a return and an ordinary bridge in together, the To Bitcoin side lists the return alone');
  await r.page.click('#bridge-body [data-brm="in"]');
  await until(r.page, () => !!document.querySelector('#bridge-body #br-go') && document.querySelectorAll('#bridge-body .brr').length === 2, null, 120000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | rows: ${(await r.page.$$('#bridge-body .brr')).length}`); });
  ok(true, 'xtring: and the From Bitcoin side lists both');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
  await toSide('#private/bitcoin');
  await sleep(2500);
  ok((await r.page.$$('#eth-v1 .brr')).length === 0, 'xtring: and the tETH tab lists neither');
  await r.page.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-burndep-bridge-v1:mainnet:${pub}`, JSON.stringify([plain])]);
  await toSide('#bridge');
  await until(r.page, () => document.querySelector('#sheet-tac')?.open && !document.querySelector('#bridge-body')?.hidden && !!document.querySelector('#bridge-body #br-go'), null, 120000);
  ok(!(await r.page.$('#bridge-body [data-brm]')), 'xtring: a TAC bridge from Bitcoin alone does not bring the To Bitcoin side');
  // The sections at phone width, with no sideways scroll.
  await r.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`tacit-burndep-bridge-v1:mainnet:${pub}`, JSON.stringify([rec])]);
  await toSide();
  await until(r.page, () => document.querySelector('#sheet-tac')?.open && !document.querySelector('#bridge-body')?.hidden && document.querySelectorAll('#bridge-body .brr').length === 1 && !!document.querySelector('#bridge-body #xc-find'), null, 120000);
  await r.page.setViewportSize({ width: 360, height: 760 });
  await sleep(400);
  await r.page.evaluate(() => document.querySelector('#bridge-body #xc-find')?.closest('details')?.setAttribute('open', ''));
  const wide = await r.page.evaluate(() => { const d = document.querySelector('#sheet-tac .sheet-in'); return [d.scrollWidth, d.clientWidth, document.documentElement.scrollWidth, innerWidth]; });
  ok(wide[0] <= wide[1] + 1 && wide[2] <= wide[3] + 1, `xtring: no sideways scroll at phone width (${wide})`);
  if (r.errors.length) { fails++; console.log('FAIL xtring page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

// A burn this browser has no record of (another device, storage cleared) is found from the key alone: its settle on Ethereum names a note the key
// spent, and the destination is the one the key makes for that note less a fee on the ladder. One burn is still on its way (20 TAC, a 2 TAC fee); another
// the worker already has minted. The first becomes a record the bridge carries on from, the second is journaled as arrived and not sent again.
await step('xtfind', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'd7e8'.padEnd(64, '7'), privB = Buffer.from(hex, 'hex'), pubB = secp.getPublicKey(privB, true), pub = Buffer.from(pubB).toString('hex'), XONLY = '0x' + pub.slice(2);
  const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', CROSSOUT_TOPIC = '0x1dcbefc1323b3b80f7cedfeb490313eff6ded6186b4cf10d72b383ee81d90c13';
  const { makeConfidentialPool } = await import(new URL('../dapp/confidential-pool.js', import.meta.url));
  const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const derive = (nullifier) => { const m = Buffer.concat([Buffer.from('tacit-crossout-blinding-v1'), Buffer.from(nullifier.slice(2), 'hex')]); let b = 0n; for (const x of hmac(sha256, privB, m)) b = (b << 8n) | BigInt(x); b %= secp.CURVE.n; return b === 0n ? 1n : b; };
  const mk = (amount, claim, nullifier) => { const nu = '0x' + nullifier.repeat(32), { cx, cy } = pool.commitXY(amount, derive(nu)); return { amount, cx, cy, claimId: '0x' + claim.repeat(32), nullifier: nu }; };
  const N1 = mk(2_000_000_000n, 'd1', 'b1'), N2 = mk(4_600_000_000n, 'd2', 'b2');           // 22 TAC and 50 TAC spent, each less a 2 and a 4 TAC fee
  const spentOf = [{ n: N1, value: 2_200_000_000n }, { n: N2, value: 5_000_000_000n }];
  const poolStub = `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv, opts) => { const b = await balance(priv, opts); if (opts && opts.spent) b.spentNotes = [...(b.spentNotes || []), ${spentOf.map(({ n, value }) => `{ nullifier: '${n.nullifier}', asset: '${TAC}', value: ${value}n }`).join(', ')}]; return b; };
      return ux;
    }`;
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: poolStub }));
  await r.page.route(/\/confidential-pool-ux\.js$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: poolStub }));
  const head = Number(BigInt(await rpc('eth_blockNumber')));
  const logOf = (n, tx) => ({ address: POOL, topics: [CROSSOUT_TOPIC, n.claimId], data: '0x' + '00'.repeat(31) + '01' + pool.btcNoteLeaf(TAC, n.cx, n.cy, XONLY).slice(2) + n.nullifier.slice(2) + TAC.slice(2), blockNumber: '0x' + (head - 100).toString(16), transactionHash: '0x' + tx.repeat(32), logIndex: '0x0' });
  const logs = [logOf(N1, 'f1'), logOf(N2, 'f2')];
  let reads = 0;
  for (const h of ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'cloudflare-eth.com', 'rpc.flashbots.net'])
    await r.page.route(`https://${h}/**`, async (route) => {
      try {
        const b = JSON.parse(route.request().postData() || '{}');
        if (b.method === 'eth_getLogs' && b.params?.[0]?.topics?.[0] === CROSSOUT_TOPIC) {
          const f = b.params[0]; reads++;
          const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
          const hit = logs.filter((l) => { const blk = Number(BigInt(l.blockNumber)); return blk >= from && blk <= to && (!f.topics[1] || String(f.topics[1]).toLowerCase() === l.topics[1]); });
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: hit }) });
        }
      } catch { /* not a single JSON-RPC call: the fork answers it */ }
      return route.fallback();
    });
  const api = (re, fn) => r.page.route(re, (route) => fn(route, new URL(route.request().url())));
  await api(/^https:\/\/(mempool\.space|blockstream\.info|api\.tacit\.finance\/chain)\/(api\/)?address\/[^/]+\/utxo/, (route) => json(route, []));
  await api(/^https:\/\/api\.tacit\.finance\/crossout\/minted/, (route, u) => json(route, u.searchParams.get('claim') === N2.claimId.slice(2) ? { decided: true, minted: false, status: 'minted', mintedTxid: 'ab'.repeat(32) } : { decided: false, minted: false, status: null }));
  await api(/^https:\/\/api\.tacit\.finance\/reflection\/(status|eth-state)/, (route) => json(route, { network: 'mainnet', attestedHeight: 970100, tipHeight: 970100, lagBlocks: 0, covered: false }));
  await r.page.goto(r.url + '#wallet');
  await r.page.evaluate(async () => {
    globalThis.__TACIT_NO_INIT__ = true; localStorage.setItem('tacit-network-v1', 'mainnet');
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);
    T._testSetScanHoldingsOverride(() => new Map());
  });
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  const key = `tacit-crossout-bridge-v1:mainnet:${pub}`;
  ok((await r.page.evaluate((k) => localStorage.getItem(k), key)) == null, 'xtfind: this browser has no record of either burn');
  await go(r.page, '#bridge/out');
  await until(r.page, () => document.querySelectorAll('#bridge-body .brr').length === 1, null, 240000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | body: ${(await text(r.page, '#bridge-body')).replace(/\s+/g, ' ').slice(0, 300)} | errors: ${r.errors.slice(0, 3).join(' | ')}`); });
  const row = (await text(r.page, '#bridge-body .brr')).replace(/\s+/g, ' ');
  ok(/20 TAC/.test(row) && /Burned on Ethereum/.test(row), `xtfind: the burn still on its way is found from the key and Ethereum, and listed with what arrives (${row.slice(0, 150)})`);
  const recs = await r.page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), key);
  const one = recs.find((x) => x.id === N1.nullifier), two = recs.find((x) => x.id === N2.nullifier);
  ok(!!one && one.stage === 'settled' && one.source.amount.__big === '2000000000' && one.source.fee.__big === '200000000' && one.source.ticker === 'TAC' && !!one.recoveredAt, 'xtfind: its record has the amount, the 2 TAC fee and the claim, and the bridge goes on from it');
  ok(!!two && two.stage === 'minted' && two.creditedTxid === 'ab'.repeat(32), 'xtfind: the burn the worker already has minted is journaled as arrived, not listed, and not sent again');
  const seen = reads;
  await go(r.page, '#bridge'); await go(r.page, '#bridge/out'); await sleep(2500);
  ok(reads === seen, `xtfind: a second look within ten minutes reads nothing more (${reads - seen} reads)`);
  if (r.errors.length) { fails++; console.log('FAIL xtfind page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

const WNS = '0x0000000000696760E15f265e828DB644A0c242EB';
const namehash = (n) => n.split('.').reverse().reduce((node, l) => Buffer.from(keccak_256(Buffer.concat([node, Buffer.from(keccak_256(Buffer.from(l)))]))), Buffer.alloc(32)).toString('hex');
const abiStr = (x) => { const b = Buffer.from(x).toString('hex'); return word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); };
const readStr = (h) => { const d = h.replace(/^0x/, ''); const len = parseInt(d.slice(64, 128), 16); return Buffer.from(d.slice(128, 128 + len * 2), 'hex').toString(); };
await step('pts', async () => {
  await rpc('anvil_impersonateAccount', [RECIPIENT]);
  await rpc('anvil_setBalance', [RECIPIENT, '0x' + (10n ** 18n).toString(16)]);
  const r = await openPage({ account: RECIPIENT });
  await r.page.goto(r.url + '#pts');
  await r.page.click('#pts-connect');
  await until(r.page, () => !!document.querySelector('#pts-body .pt'), null, 120000);
  if (await r.page.$('[data-claim]')) {
    const t0 = await tacOf(RECIPIENT);
    await r.page.click('[data-claim]');
    await until(r.page, () => /Claimed|err/.test(document.querySelector('#pts-status')?.innerHTML || ''), null, 120000);
    ok((await tacOf(RECIPIENT)) > t0, `pts: a points reward claims to its own address ${await text(r.page, '#pts-status')}`);
  } else ok(true, 'pts: nothing is waiting for this address on the fork');
  if (r.errors.length) { fails++; console.log('FAIL pts page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
  const w = await openPage({ account: A0, key: K0 });
  const hex = 'a11ce'.padEnd(64, '7'), acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 17n).toString(16)]);
  await w.page.goto(w.url + '#wallet');
  await w.page.click('#wallet-body [data-in="paste"]');
  await w.page.fill('#ws-hex', hex);
  await w.page.click('#wallet-body [data-in="key"]');
  await until(w.page, () => !!document.querySelector('#wallet-dot.on'));
  await go(w.page, '#pts');
  await w.page.waitForSelector('#wei-name', { timeout: 60000 });
  const label = 'tacitlite' + Date.now().toString(36);
  await w.page.fill('#wei-name', label);
  await until(w.page, () => !document.querySelector('#wei-go').disabled, null, 60000);
  await w.page.click('#wei-go');
  const tick = setInterval(async () => { try { console.log('    [pts] ' + (await w.page.evaluate(() => document.querySelector('#pts-status')?.textContent || '(no status)')).slice(0, 140)); } catch {} }, 20000);
  await until(w.page, () => /pays you privately|err/.test(document.querySelector('#pts-status')?.innerHTML || ''), null, 300000).finally(() => clearInterval(tick));
  const node = namehash(label + '.wei');
  const owner = await rpc('eth_call', [{ to: WNS, data: '0x6352211e' + node }, 'latest']).catch(() => '0x');
  const rec = readStr(await rpc('eth_call', [{ to: WNS, data: '0x59d1d43c' + node + word(64) + abiStr('finance.tacit') }, 'latest']).catch(() => '0x'));
  ok(owner.slice(-40) === acct.slice(2) && rec === shownAddress(hex), `pts: ${label}.wei registers to the Tacit account through zRouter and carries its unified tacit1 (${await text(w.page, '#pts-status')})`);
  if (w.errors.length) { fails++; console.log('FAIL pts page errors: ' + w.errors.slice(0, 3).join(' | ')); }
  await w.browser.close();
});
// A points claim made through the page by an address the service owes TAC, with the service's real proof against the fork's distributor;
// then again with the proof it read spoiled until the press (a list replaced since it was read), when the page reads the address again and
// claims. Needs an address with TAC to claim: PTS_ACCOUNT=0x… node tools/weld-check.mjs ptsclaim
await step('ptsclaim', async () => {
  const who = process.env.PTS_ACCOUNT;
  if (!/^0x[0-9a-fA-F]{40}$/.test(who || '')) { ok(true, 'ptsclaim: set PTS_ACCOUNT to an address that is owed points to run this'); return; }
  await rpc('anvil_impersonateAccount', [who]);
  await rpc('anvil_setBalance', [who, '0x' + (10n ** 18n).toString(16)]);
  for (const stale of [false, true]) {
    const snap = await rpc('evm_snapshot');
    const r = await openPage({ account: who });
    let spoil = stale, spoiled = 0;
    await r.ctx.route(/api\.tacit\.finance\/claim\/0x/, async (route) => {
      if (!spoil) return route.continue();
      const res = await route.fetch(), body = await res.json();
      if (body.proof?.length) { spoiled++; const h = body.proof[0]; body.proof[0] = h.slice(0, -1) + (h.endsWith('0') ? '1' : '0'); }
      return route.fulfill({ response: res, json: body });
    });
    await r.page.goto(r.url + '#pts');
    await r.page.click('#pts-connect');
    await until(r.page, () => !!document.querySelector('#pts-body [data-claim]'), null, 120000);
    const before = await tacOf(who);
    spoil = false;
    await r.page.click('#pts-body [data-claim]');
    await until(r.page, () => /Claimed|err/.test(document.querySelector('#pts-status')?.innerHTML || ''), null, 120000);
    const said = await text(r.page, '#pts-status');
    ok(/Claimed/.test(said) && (await tacOf(who)) > before && (!stale || spoiled > 0), `ptsclaim: ${stale ? `a claim list replaced before the press is read again and claimed (${spoiled} spoiled read${spoiled === 1 ? '' : 's'})` : 'a points reward claims to its own address'} (${said})`);
    if (r.errors.length) { fails++; console.log('FAIL ptsclaim page errors: ' + r.errors.slice(0, 3).join(' | ')); }
    await r.browser.close();
    await rpc('evm_revert', [snap]);
  }
});
// The rewards page: one bar that takes an address or a .eth, .wei or .gwei name and answers with that account's airdrop and points. The points
// service is stubbed (so its numbers are known, and its calls can be counted and slowed); the names and the airdrop contract are read from the
// fork. z0r0z.wei points to an address the airdrop lists. A lookup starts on its own once what is typed can be one, each card draws as its own
// reading arrives, a second look costs no new reading, and the bar offers the three services for a bare name and what was looked up before.
await step('rewards', async () => {
  const LISTED = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20', OTHER = '0x' + 'ab'.repeat(20), hex40 = (c) => '0x' + c.repeat(40);
  const n = await openPage({ account: A0, viewport: { width: 1280, height: 900 } });
  await n.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(n.url).origin }).catch(() => {});
  const hits = { points: 0, claim: 0, board: 0 }; let slow = 0;
  await n.ctx.route(/api\.tacit\.finance\/(points|claim)\/0x/, async (route) => {
    const u = route.request().url(), a = (u.match(/0x[0-9a-fA-F]{40}/) || [''])[0].toLowerCase(), mine = a === LISTED;
    if (/\/claim\//.test(u)) { hits.claim++; return json(route, mine ? { cumulativeAmount: '8000000000000000000', claimedWei: '5000000000000000000', unclaimedWei: '3000000000000000000', proof: ['0x' + '11'.repeat(32)] } : { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null }); }
    hits.points++;
    if (slow) await sleep(slow);
    return json(route, { address: a, points: mine ? 12345.6 : 0, deposit_count: mine ? 4 : 0, deposits: [] });
  });
  await n.ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => { hits.board++; return json(route, [{ address: hex40('1'), points: 9e9 }, { address: hex40('2'), points: 50000 }, { address: LISTED, points: 12345.6 }]); });
  const out = async () => (await text(n.page, '#out')).replace(/\s+/g, ' ').trim();
  const settled = () => until(n.page, () => !!document.querySelector('#out .cu') && !document.querySelector('#out .cu:not([data-settled])') && !document.querySelector('#out .sk'), null, 120000);
  const read = (txt) => n.page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  const primed = new Set(); n.page.on('request', (r) => { if (r.method() === 'POST' && /eth_chainId/.test(r.postData() || '')) primed.add(new URL(r.url()).host); });
  try {
    await n.page.goto(n.url + 'rewards/');
    await n.page.waitForSelector('#q', { timeout: 60000 });
    const box = await n.page.evaluate(() => { const r = document.querySelector('.bar').getBoundingClientRect(), h = document.querySelector('#find-h').getBoundingClientRect(); return { bar: r.left + r.width / 2, h1: h.left + h.width / 2, vw: innerWidth }; });
    ok(Math.abs(box.bar - box.vw / 2) < 3 && Math.abs(box.h1 - box.vw / 2) < 3 && !!(await n.page.$('header.top nav.sn')) && !!(await n.page.$('footer.sf')), `rewards: the bar and the title are centred, under the shared header and footer (${JSON.stringify(box)})`);
    const pre = await n.page.$$eval('link[rel="preconnect"]', (l) => l.map((x) => x.href));
    ok(['https://api.tacit.finance/', 'https://ethereum-rpc.publicnode.com/', 'https://eth.drpc.org/', 'https://1rpc.io/'].every((h) => pre.includes(h)), `rewards: the hosts it reads are connected while the person types (${pre.length} preconnect links)`);
    await until(n.page, () => true); await sleep(1200);
    ok(hits.board === 1, `rewards: the leaderboard is fetched once, before anything is asked (${hits.board})`);
    ok(['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io'].every((h) => primed.has(h)), `rewards: the three Ethereum endpoints are warmed while the page is idle, so a lookup finds them connected (${[...primed]})`);
    await n.page.fill('#q', 'hello'); await n.page.click('#go');
    await until(n.page, () => /Enter a 0x address/.test(document.querySelector('#out')?.textContent || ''), null, 30000);
    ok((await n.page.getAttribute('#q', 'aria-invalid')) === 'true', 'rewards: something that is neither an address nor a name is told, and marked on the bar');
    ok((await n.page.getAttribute('#ninja', 'data-mood')) === 'shake' && (await text(n.page, '#emo')) === '', 'rewards: the ninja shakes its head at it, with no thumb either way');
    await n.page.fill('#q', '0x1c0aA8ccd568d90d61659f060d1bfb1e6f855a20');
    await until(n.page, () => /bad checksum/.test(document.querySelector('#out')?.textContent || ''), null, 30000);
    ok(true, 'rewards: an address in mixed case that fails its checksum is refused, with nothing pressed');
    // A whole address starts the lookup by itself; the airdrop card is drawn while the points are still being read.
    slow = 1500;
    await n.page.fill('#q', OTHER);
    await until(n.page, () => /Not on the airdrop list/.test(document.querySelector('#c-air')?.textContent || '') && !!document.querySelector('#c-pts .sk'), null, 30000);
    ok((await n.page.getAttribute('#ninja', 'data-mood')) === 'think', 'rewards: a pasted address answers at once, the airdrop card draws while the points are still read, and the ninja thinks');
    await until(n.page, () => /No points yet/.test(document.querySelector('#c-pts')?.textContent || ''), null, 30000);
    await until(n.page, () => document.querySelector('#ninja')?.dataset.mood === 'down', null, 10000);
    ok((await text(n.page, '#emo')) === '👎', 'rewards: nothing to claim (not on the list, no points): the ninja shakes its head and a thumbs down appears');
    slow = 0;
    // A name starts it too, a moment after the last key; the address it points to was not read before, so this reads it.
    await n.page.evaluate(() => { window.__winked = false; new MutationObserver(() => { if (document.querySelector('#ninja').classList.contains('wink')) window.__winked = true; }).observe(document.querySelector('#ninja'), { attributes: true, attributeFilter: ['class'] }); });
    await n.page.fill('#q', LISTED);
    await settled();
    ok((await n.page.getAttribute('#ninja', 'data-mood')) === 'up' && (await text(n.page, '#emo')) === '👍', 'rewards: something to claim: the ninja nods and a thumbs up appears');
    await until(n.page, () => document.querySelector('#ninja')?.dataset.mood === 'idle' && document.querySelector('#emo')?.textContent === '', null, 10000);
    ok(await n.page.evaluate(() => window.__winked), 'rewards: it winked on the way');
    ok(true, 'rewards: and it settles back behind the bar, the thumb gone');
    await n.page.click('#ninja');
    ok(await n.page.evaluate(() => document.querySelector('#ninja').classList.contains('wink')), 'rewards: pressing the ninja makes it wink');
    const readsBefore = { ...hits };
    await n.page.fill('#q', 'z0r0z.wei');
    await sleep(150);
    ok((await out()) !== '', 'rewards: a pasted name starts at once, with no wait for more keys');
    await until(n.page, () => /^z0r0z\.wei/.test((document.querySelector('#out')?.textContent || '').trim()) && !document.querySelector('#out .sk'), null, 60000);
    await settled();
    let t = await out();
    ok(/^z0r0z\.wei\s*0x1c0a…5a20/.test(t) && /Airdrop[\d.,]+\s*TAC/.test(t) && /(Claimed|Claim by [^·]+· \d+ days? left|Closed)/.test(t), `rewards: a .wei name answers by itself, with its address and the airdrop (${t.slice(0, 200)})`);
    await until(n.page, () => /Rank #3/.test(document.querySelector('#out')?.textContent || ''), null, 30000);
    t = await out();
    ok(/12,346\s*points/.test(t) && /Earned from finished days\s*8 TAC/.test(t) && /Claimed\s*0 TAC/.test(t) && /To claim\s*8 TAC/.test(t), `rewards: its points and rank, what it has earned, what the distributor says it has claimed, and what it can claim (${t.slice(t.indexOf('Points'), t.indexOf('Points') + 200)})`);
    ok(hits.points === readsBefore.points && hits.claim === readsBefore.claim && hits.board === readsBefore.board, `rewards: the same account read again by its name costs no new reading (${JSON.stringify(hits)})`);
    ok((await n.page.$$('#out button[data-claim]:not([data-claim="airdrop-to"])')).length === 2 && !(await n.page.$('#out a.act')), 'rewards: with a browser wallet each claim is a button on its card');
    ok((await n.page.evaluate(() => location.search)) === '?q=z0r0z.wei', 'rewards: the address bar carries the lookup, so it can be shared');
    // Copying.
    await n.page.click('#out [data-copy^="0x"]');
    await until(n.page, () => document.querySelector('#out [data-copy^="0x"]')?.textContent === 'Copied', null, 10000);
    ok((await read()) === LISTED, 'rewards: Copy address copies the address and says so');
    await n.page.click('[data-said="Link copied"]');
    await until(n.page, () => document.querySelector('[data-said="Link copied"]')?.textContent === 'Copied', null, 10000);
    ok((await read()) === `${new URL(n.url).origin}/rewards/?q=z0r0z.wei`, 'rewards: Copy link copies the address of this lookup');
    // A bare name is offered under the three services; a lookup is remembered; / finds the bar; Esc clears it.
    await n.page.fill('#q', 'alice');
    const chips = await n.page.$$eval('#hints .chip', (c) => c.map((x) => x.textContent));
    ok(chips.join() === 'alice.eth,alice.wei,alice.gwei' && (await n.page.$$('#recent .chip')).length === 0, `rewards: a bare name is offered as .eth, .wei and .gwei, and what was looked up before steps aside (${chips})`);
    await n.page.click('#hints [data-q="alice.gwei"]');
    await until(n.page, () => /^alice\.gwei/.test((document.querySelector('#out')?.textContent || '').trim()) && !document.querySelector('#out .sk'), null, 120000);
    ok(/^alice\.gwei\s*0xdc10…f86a/.test(await out()), 'rewards: choosing one answers (a .gwei name is read through GNS)');
    await n.page.press('#q', 'Escape');
    ok((await n.page.inputValue('#q')) === '' && (await out()) === '' && (await n.page.evaluate(() => location.search)) === '', 'rewards: Esc empties the bar and the answer');
    const rec = await n.page.$$eval('#recent .chip[data-q]', (c) => c.map((x) => x.dataset.q));
    ok(rec[0] === 'alice.gwei' && rec.includes('z0r0z.wei') && rec.includes(LISTED), `rewards: what was looked up is offered again, newest first (${rec})`);
    await n.page.evaluate(() => document.activeElement.blur());
    await n.page.keyboard.press('/');
    ok(await n.page.evaluate(() => document.activeElement.id === 'q'), 'rewards: / puts the cursor in the bar');
    await n.page.click('#recent [data-q="z0r0z.wei"]').catch(async () => { await n.page.evaluate(() => document.activeElement.blur()); await n.page.press('#q', 'Escape'); await n.page.click('#recent [data-q="z0r0z.wei"]'); });
    await until(n.page, () => /^z0r0z\.wei/.test((document.querySelector('#out')?.textContent || '').trim()) && !document.querySelector('#out .sk'), null, 60000);
    ok(true, 'rewards: a recent lookup answers when pressed');
    await n.page.press('#q', 'Escape');
    await n.page.type('#q', 'vitalik.eth', { delay: 12 });
    await sleep(150);
    ok((await out()) === '', 'rewards: a name typed key by key waits a moment after the last key, in case there is more of it');
    await until(n.page, () => /^vitalik\.eth/.test((document.querySelector('#out')?.textContent || '').trim()) && !document.querySelector('#out .sk'), null, 120000);
    t = await out();
    ok(/^vitalik\.eth\s*0xd8da…6045/.test(t), `rewards: an .eth name is read through ENS (${t.slice(0, 80)})`);
    await n.page.fill('#q', 'alice.wei');
    await until(n.page, () => /has no address set/.test(document.querySelector('#out')?.textContent || ''), null, 120000);
    ok(/^alice\.wei has no address set/.test(await out()), 'rewards: a name with no address says so');
    await n.page.goto(n.url + 'rewards/?q=z0r0z.wei');
    await until(n.page, () => /Airdrop/.test(document.querySelector('#out')?.textContent || '') && !document.querySelector('#out .sk'), null, 120000);
    ok((await n.page.inputValue('#q')) === 'z0r0z.wei' && /^z0r0z\.wei/.test(await out()), 'rewards: a link with ?q= fills the bar and answers at once');
    await settled();
    if (SHOTS) await n.page.screenshot({ path: join(SHOTS, 'weld-rewards.png'), fullPage: true });
    await n.page.setViewportSize({ width: 390, height: 900 });
    await sleep(500);
    ok(!(await n.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'rewards: no sideways scroll at phone width');
    if (SHOTS) await n.page.screenshot({ path: join(SHOTS, 'weld-rewards-phone.png'), fullPage: true });
    if (n.errors.length) { fails++; console.log('FAIL rewards page errors: ' + n.errors.slice(0, 3).join(' | ')); }
  } finally { await n.browser.close(); }
});

// Claiming on the rewards page, by the account itself. First the cases that send nothing (a wallet on another account; no wallet at all, where a
// claim is a link into the dapp), then the airdrop (read from the fork's contract, claimed through the page), then points with the service's real
// proof for PTS_ACCOUNT (an address with points to claim, as for ptsclaim) both as it is and with a proof that has been replaced since it was read.
// A claim that lands rains TAC coins, lists its transaction, and the ninja nods; the card reads claimed.
await step('rewardsclaim', async () => {
  const LISTED = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20', AIRDROP = '0x4b4cb98d0c836c2783ac46f0078b904dab533ae8', hex40 = (c) => '0x' + c.repeat(40);
  const stubs = async (ctx) => {
    await ctx.route(/api\.tacit\.finance\/(points|claim)\/0x/, (route) => {
      const u = route.request().url(), a = (u.match(/0x[0-9a-fA-F]{40}/) || [''])[0].toLowerCase(), mine = a === LISTED;
      if (/\/claim\//.test(u)) return json(route, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null });
      return json(route, { address: a, points: mine ? 12345.6 : 0, deposit_count: mine ? 4 : 0, deposits: [] });
    });
    await ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, [{ address: hex40('1'), points: 9e9 }, { address: LISTED, points: 12345.6 }]));
  };
  await rpc('anvil_impersonateAccount', [LISTED]); await rpc('anvil_setBalance', [LISTED, '0x' + (10n ** 18n).toString(16)]);
  // The first connection opens the list of wallets (the browser's and WalletConnect), as it does for a person; the browser's is chosen, if the
  // list opens (it is not waited for: what the page does next is read as it happens).
  const choose = (page) => page.waitForSelector('.bsheet .way', { timeout: 8000 }).then(() => page.click('.bsheet .way:has-text("Browser wallet")')).catch(() => {});
  // A wallet on another account is told which to switch to, and nothing is sent.
  {
    const n = await openPage({ account: A0, viewport: { width: 1000, height: 900 } });
    await stubs(n.ctx);
    try {
      await n.page.goto(n.url + 'rewards/?q=' + LISTED);
      await n.page.waitForSelector('[data-claim="airdrop"]', { timeout: 120000 });
      const sent = walletTxs.length, before = await tacOf(LISTED);
      choose(n.page); await n.page.click('[data-claim="airdrop"]');
      await until(n.page, () => /Switch it to/.test(document.querySelector('#done')?.textContent || ''), null, 30000);
      const t = (await text(n.page, '#done')).replace(/\s+/g, ' ');
      ok(/Your wallet is on 0xf39f…2266\. Switch it to 0x1c0a…5a20 to claim\./.test(t) && walletTxs.length === sent && (await tacOf(LISTED)) === before, `rewardsclaim: a wallet on another account is told which to switch to, and nothing is sent (${t.trim()})`);
      ok((await n.page.getAttribute('#ninja', 'data-mood')) === 'shake', 'rewardsclaim: and the ninja shakes its head');
      ok(/Your wallet is on 0xf39f…2266\./.test(await text(n.page, '#wl')) && !!(await n.page.$('#wl [data-mine]')) && !!(await n.page.$('#wl [data-switch]')), 'rewardsclaim: and the line under the result offers to look up the wallet\'s own account or to switch');
    } finally { await n.browser.close(); }
  }
  // No browser wallet at all (a phone): WalletConnect is offered by itself, so a claim is still a button, and pressing it pairs a wallet app.
  {
    const n = await openPage({ account: A0, init: { fn: () => { delete window.ethereum; } } });
    await stubs(n.ctx);
    try {
      await n.page.goto(n.url + 'rewards/?q=' + LISTED);
      await n.page.waitForSelector('#c-air .act', { timeout: 120000 });
      ok(!!(await n.page.$('#c-air button[data-claim="airdrop"]')) && !(await n.page.$('#c-air a.act')), 'rewardsclaim: with no browser wallet the claim is still a button (it pairs a wallet app through WalletConnect)');
    } finally { await n.browser.close(); }
  }
  // The airdrop, claimed by its account (and taken back on the fork afterwards, so the farm check that follows can claim it too).
  {
    const snapAir = await rpc('evm_snapshot');
    const n = await openPage({ account: LISTED, viewport: { width: 1000, height: 900 } });
    await stubs(n.ctx);
    try {
      await n.page.goto(n.url + 'rewards/?q=' + LISTED);
      await n.page.waitForSelector('[data-claim="airdrop"]', { timeout: 120000 });
      const sent = walletTxs.length, before = await tacOf(LISTED);
      choose(n.page); await n.page.click('[data-claim="airdrop"]');
      await until(n.page, () => !!document.querySelector('#done .done a[href^="https://etherscan.io/tx/0x"]'), null, 180000);
      const coins = await n.page.evaluate(() => Number(document.querySelector('#fx')?.dataset.coins || 0));
      const tx = walletTxs[walletTxs.length - 1], done = (await text(n.page, '#done')).replace(/\s+/g, ' ');
      ok(walletTxs.length === sent + 1 && String(tx.to).toLowerCase() === AIRDROP && String(tx.from).toLowerCase() === LISTED, `rewardsclaim: the airdrop claim is one transaction to the airdrop contract, from the account (${tx.to})`);
      ok((await tacOf(LISTED)) - before > 216000n * 10n ** 18n && /Claimed [\d.,]+ TAC\s*0x[0-9a-f]{8}…[0-9a-f]{6} ↗/.test(done), `rewardsclaim: the TAC arrives and the page lists the transaction (${done.slice(0, 80)})`);
      ok(coins >= 40 && (await n.page.getAttribute('#ninja', 'data-mood')) === 'up' && (await text(n.page, '#emo')) === '👍', `rewardsclaim: TAC coins fall down the screen (${coins}) and the ninja nods`);
      await until(n.page, () => !document.querySelector('#fx'), null, 20000);
      ok(true, 'rewardsclaim: and the coins are gone once they have fallen');
      await until(n.page, () => /Claimed/.test(document.querySelector('#c-air .st')?.textContent || '') && !document.querySelector('#c-air [data-claim]'), null, 60000);
      ok(true, 'rewardsclaim: the airdrop card is read again and says claimed, with nothing left to press');
      if (SHOTS) await n.page.screenshot({ path: join(SHOTS, 'weld-rewardsclaim.png') });
      if (n.errors.length) { fails++; console.log('FAIL rewardsclaim page errors: ' + n.errors.slice(0, 3).join(' | ')); }
    } finally { await n.browser.close(); await rpc('evm_revert', [snapAir]); }
  }
  // Points, with the service's real proof (the live service is read, so this runs only for an address that has some to claim).
  const who = process.env.PTS_ACCOUNT;
  if (!/^0x[0-9a-fA-F]{40}$/.test(who || '')) { ok(true, 'rewardsclaim: set PTS_ACCOUNT to an address with points to claim to run the points claim'); return; }
  await rpc('anvil_impersonateAccount', [who]); await rpc('anvil_setBalance', [who, '0x' + (10n ** 18n).toString(16)]);
  const DISTRIBUTOR = '0x000000c918e44a3a443937fa7594ea4f7c95d6b9';
  for (const stale of [false, true]) {
    const snap = await rpc('evm_snapshot');
    const n = await openPage({ account: who, viewport: { width: 1000, height: 900 } });
    let spoil = 0, spoiled = 0;
    await n.ctx.route(/api\.tacit\.finance\/claim\/0x/, async (route) => {
      if (!spoil) return route.continue();
      spoil--; spoiled++;
      const res = await route.fetch(), body = await res.json();
      if (body.proof?.length) { const h = body.proof[0]; body.proof[0] = h.slice(0, -1) + (h.endsWith('0') ? '1' : '0'); }
      return route.fulfill({ response: res, json: body });
    });
    try {
      await n.page.goto(n.url + 'rewards/?q=' + who);
      await n.page.waitForSelector('[data-claim="points"]', { timeout: 120000 });
      const before = await tacOf(who), sent = walletTxs.length;
      if (stale) spoil = 1;
      choose(n.page); await n.page.click('[data-claim="points"]');
      await until(n.page, () => !!document.querySelector('#done .done a[href^="https://etherscan.io/tx/0x"]') || /did not|refuse|nothing left|just updated/i.test(document.querySelector('#done')?.textContent || ''), null, 180000);
      const tx = walletTxs[walletTxs.length - 1];
      ok(walletTxs.length === sent + 1 && String(tx.to).toLowerCase() === DISTRIBUTOR && (await tacOf(who)) > before && (!stale || spoiled === 1), `rewardsclaim: points ${stale ? 'with a proof replaced since it was read: it is read again, once, and the claim goes through' : 'are claimed with the service\'s proof'} (${(await text(n.page, '#done')).replace(/\s+/g, ' ').trim().slice(0, 90)})`);
    } finally { await n.browser.close(); }
    await rpc('evm_revert', [snap]);
  }
});

// Getting a wallet onto the rewards page: the header chip (the swap page's own connect module), the list of wallets, what a first connection
// does (the account's own rewards), what the page says when the wallet is on another account (look up the wallet's, or switch), and the account sheet.
await step('rewardswallet', async () => {
  const LISTED = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20', hex40 = (c) => '0x' + c.repeat(40);
  // Two wallets announce themselves (EIP-6963), both the test browser's, so the list has something to choose from.
  const two = { fn: () => { const say = () => { for (const [u, name] of [['a', 'Test wallet A'], ['b', 'Test wallet B']]) dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: u, name, icon: '', rdns: `test.${u}` }, provider: window.ethereum }) })); }; addEventListener('eip6963:requestProvider', say); } };
  const n = await openPage({ account: A0, viewport: { width: 1000, height: 900 }, init: two });
  await n.ctx.route(/api\.tacit\.finance\/(points|claim)\/0x/, (route) => {
    const u = route.request().url(), a = (u.match(/0x[0-9a-fA-F]{40}/) || [''])[0].toLowerCase();
    if (/\/claim\//.test(u)) return json(route, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null });
    return json(route, { address: a, points: a === LISTED ? 12345.6 : 0, deposit_count: 0, deposits: [] });
  });
  await n.ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, [{ address: hex40('1'), points: 9e9 }]));
  const line = async () => (await text(n.page, '#wl')).replace(/\s+/g, ' ').trim();
  try {
    await n.page.goto(n.url + 'rewards/');
    await n.page.waitForSelector('#wallet-chip');
    ok((await text(n.page, '#wallet-label')).trim() === 'Connect' && (await n.page.$$('#wallet-chip')).length === 1, 'rewardswallet: the header carries a Connect chip');
    await n.page.click('#wallet-chip');
    await n.page.waitForSelector('.bsheet .way', { timeout: 15000 });
    const ways = await n.page.$$eval('.bsheet .way', (w) => w.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
    ok(ways.some((x) => /Test wallet A/.test(x)) && ways.some((x) => /Test wallet B/.test(x)), `rewardswallet: with several wallets the chip opens a list to choose from (${ways.join(' | ')})`);
    await n.page.click('.bsheet .way:has-text("Test wallet A")');
    await until(n.page, () => document.querySelector('#q').value === '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' && /Your wallet is on this account/.test(document.querySelector('#wl')?.textContent || ''), null, 60000);
    ok(/2266/.test(await text(n.page, '#wallet-label')), `rewardswallet: connecting with nothing asked looks the wallet's own account up, and the chip shows it (${(await text(n.page, '#wallet-label')).trim()})`);
    await n.page.fill('#q', LISTED);
    await until(n.page, () => /Your wallet is on 0xf39f…2266\./.test(document.querySelector('#wl')?.textContent || ''), null, 60000);
    ok(!!(await n.page.$('#wl [data-mine]')) && !!(await n.page.$('#wl [data-switch]')), `rewardswallet: a result for another account says where the wallet is, with "Look up mine" and "Switch account" (${await line()})`);
    await n.page.click('#wl [data-switch]');
    await until(n.page, () => /Switch accounts in your wallet/.test(document.querySelector('#wmsg')?.textContent || ''), null, 15000);
    ok(true, 'rewardswallet: a wallet with no account chooser is told to switch in the wallet');
    await n.page.click('#wl [data-mine]');
    await until(n.page, () => document.querySelector('#q').value === '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' && /on this account/.test(document.querySelector('#wl')?.textContent || ''), null, 60000);
    ok(true, 'rewardswallet: "Look up mine" puts the wallet\'s account in the bar');
    await n.page.click('#wallet-chip');
    await n.page.waitForSelector('.bsheet [data-mine-sheet]', { timeout: 10000 });
    const sheet = (await text(n.page, '.bsheet')).replace(/\s+/g, ' ');
    ok(/Account/.test(sheet) && !!(await n.page.$('.bsheet [data-switch-sheet]')) && !!(await n.page.$('.bsheet [data-leave]')), `rewardswallet: the chip opens the account sheet, with look up, switch and disconnect (${sheet.slice(0, 140)})`);
    await n.page.click('.bsheet [data-leave]');
    await until(n.page, () => document.querySelector('#wallet-label')?.textContent.trim() === 'Connect' && !document.querySelector('#wl')?.textContent.trim(), null, 15000);
    ok(true, 'rewardswallet: disconnecting puts the chip back to Connect and clears the line');
    if (SHOTS) await n.page.screenshot({ path: join(SHOTS, 'weld-rewardswallet.png') });
    if (n.errors.length) { fails++; console.log('FAIL rewardswallet page errors: ' + n.errors.slice(0, 3).join(' | ')); }
  } finally { await n.browser.close(); }
});

// The "With TAC" line under the search: what TAC is for, each a quiet link, and each landing where it says.
await step('rewardsuses', async () => {
  const n = await openPage({ account: A0, viewport: { width: 1000, height: 900 } });
  try {
    await n.page.goto(n.url + 'rewards/');
    await n.page.waitForSelector('.uses');
    const links = await n.page.$$eval('.uses a', (a) => a.map((x) => `${x.firstChild.textContent}:${x.getAttribute('href')}`));
    ok(links.join(' ') === 'Trade:/trade/tac/ Farm:/swap/#earn Borrow:/vault/ Shield:/#tac Pay:/pay/#tac Bitcoin:/tac/', `rewardsuses: the line under the search names what TAC is for (${links.join(' ')})`);
    await until(n.page, () => /^\d[\d,]*%\+?$/.test(document.querySelector('.uses a[data-apr] .apr')?.textContent || ''), null, 60000);
    ok(Number((await text(n.page, '.uses a[data-apr] .apr')).replace(/\D/g, '')) > 0 && /APR now/.test(await n.page.getAttribute('.uses a[data-apr]', 'title')), `rewardsuses: the Farm link carries the farm's APR now (${await text(n.page, '.uses a[data-apr] .apr')})`);
    ok(await n.page.evaluate(() => { const b = document.querySelector('.bar').getBoundingClientRect(), u = document.querySelector('.uses').getBoundingClientRect(); return u.top >= b.bottom && u.top - b.bottom < 100; }), 'rewardsuses: and it sits right under the bar (below the chips for connecting or going back)');
    const tok = await n.page.$eval('#tok', (e) => ({ copy: e.querySelector('[data-copy]').dataset.copy, href: e.querySelector('a').href, full: e.querySelector('.full').textContent, target: e.querySelector('a').target }));
    ok(tok.copy === TAC && tok.full === TAC && tok.href === `https://etherscan.io/token/${TAC}` && tok.target === '_blank', `rewardsuses: the TAC token's address is on the page in full, to copy, and links to its token page on Etherscan (${tok.full})`);
    await n.page.click('#tok [data-copy]');
    await until(n.page, () => document.querySelector('#tok [data-copy]').textContent === 'Copied' && /Token address copied/.test(document.querySelector('#note').textContent), null, 10000);
    ok(true, 'rewardsuses: copying it says so');
    const land = async (path, check, what) => {
      await n.page.goto(n.url + path, { waitUntil: 'domcontentloaded' });
      await until(n.page, check, null, 60000).catch((e) => { throw new Error(`${what}: ${e.message.split('\n')[0]}`); });
      ok(true, `rewardsuses: ${what}`);
    };
    await land('trade/tac/', () => /trade/i.test(document.title) && !!document.querySelector('#route'), '/trade/tac/ is the trade page');
    await land('swap/#earn', () => !!document.querySelector('#p-earn') && !document.querySelector('#p-earn').hidden, '/swap/#earn opens the Earn tab (the Precision farm)');
    await land('vault/', () => /vault/i.test(document.title), '/vault/ is the borrow page');
    await land('#tac', () => document.querySelector('#sheet-tac')?.open === true, '/#tac opens the TAC sheet, where TAC is made private');
    await land('pay/#tac', () => /pay/i.test(document.title) && location.hash === '#tac', '/pay/#tac is the pay page on TAC');
    await land('tac/', () => /tac/i.test(document.title), '/tac/ is the Bitcoin-native shielded TAC page');
  } finally { await n.browser.close(); }
});

// Farming what was claimed, on the rewards page. The card is there only for the wallet's own account and only once it holds TAC; a claim opens it
// with the claimed TAC and the ETH that pairs with it already in, so one press farms it. With less ETH than that the pair is what the ETH covers
// (and the page says so), with none to spare the TAC goes in alone, and under the network fee the button says to add ETH.
await step('rewardsfarm', async () => {
  const LISTED = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20', E18 = 10n ** 18n, stakedOf = async (a) => BigInt(await rpc('eth_call', [{ to: FARM, data: '0x98807d84' + addrWord(a) }, 'latest']));
  const stubs = async (ctx) => {
    await ctx.route(/api\.tacit\.finance\/(points|claim)\/0x/, (route) => {
      const u = route.request().url(), a = (u.match(/0x[0-9a-fA-F]{40}/) || [''])[0].toLowerCase();
      if (/\/claim\//.test(u)) return json(route, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null });
      return json(route, { address: a, points: 0, deposit_count: 0, deposits: [] });
    });
    await ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, []));
    await ctx.route(/api\.tacit\.finance\/farm\/program/, (route) => json(route, JSON.parse(readFileSync(new URL('../tests/fixtures/farm-program-2026-10-14.json', import.meta.url), 'utf8'))));
  };
  const choose = (page) => page.waitForSelector('.bsheet .way', { timeout: 8000 }).then(() => page.click('.bsheet .way:has-text("Browser wallet")')).catch(() => {});
  const eth = (v) => rpc('anvil_setBalance', [LISTED, '0x' + BigInt(v).toString(16)]);
  const view = async (account, q) => { const n = await openPage({ account, viewport: { width: 1000, height: 900 } }); await stubs(n.ctx); await n.page.goto(n.url + 'rewards/?q=' + q); return n; };
  const hidden = (page) => page.evaluate(() => document.querySelector('#farm').hidden);
  // A page opened afresh has no wallet connected; the chip connects the browser's.
  const plug = async (page) => { choose(page); await page.click('#wallet-chip'); await until(page, () => /0x[0-9a-f]{4}/i.test(document.querySelector('#wallet-label')?.textContent || ''), null, 30000); };
  await rpc('anvil_impersonateAccount', [LISTED]);
  const snap = await rpc('evm_snapshot');
  // The farm spends the TAC it is approved for; the permit that otherwise stands in for the approval is signed by an account that has a key.
  const approve = () => rpc('eth_sendTransaction', [{ from: LISTED, to: TAC, data: '0x095ea7b3' + addrWord(FARM) + 'f'.repeat(64) }]);
  const claimed = async (n) => {
    await n.page.waitForSelector('[data-claim="airdrop"]', { timeout: 120000 });
    choose(n.page); await n.page.click('[data-claim="airdrop"]');
    await until(n.page, () => !!document.querySelector('#done .done a[href^="https://etherscan.io/tx/0x"]'), null, 180000);
  };
  // 1. With ETH to spare: a claim opens the card with the whole claim and its ETH, and one press farms it.
  {
    await eth(1000n * E18); await approve();
    const n = await view(LISTED, LISTED);
    try {
      await n.page.waitForSelector('[data-claim="airdrop"]', { timeout: 120000 });
      ok(await hidden(n.page), 'rewardsfarm: with no TAC in the wallet there is no farm card');
      await claimed(n);
      await until(n.page, () => !document.querySelector('#farm').hidden && document.querySelector('#farm').open && /Deposit/.test(document.querySelector('#fm-rcpt')?.textContent || '') && !document.querySelector('#fm-go').disabled, null, 180000);
      const got = await tacOf(LISTED), tacIn = Number(await n.page.inputValue('#fm-tacamt')), ethIn = Number(await n.page.inputValue('#fm-amt')), held = Number(got / 10n ** 14n) / 1e4;
      ok(Math.abs(tacIn - 216176.41) < 0.011 && ethIn > 0 && (await n.page.getAttribute('#fm-mode [data-fm="pair"]', 'aria-pressed')) === 'true', `rewardsfarm: a claim opens the farm card on ETH + TAC with the claimed TAC in (${tacIn} TAC with ${ethIn} ETH)`);
      ok(Math.abs(Number((await text(n.page, '#farm-s')).replace(/[^\d.]/g, '')) - held) < 0.011 && /Farm with ETH \+ TAC/.test(await text(n.page, '#fm-go')) && !(await text(n.page, '#farm-note')), `rewardsfarm: its summary names the TAC held, its one button says what it does, and there is nothing to warn of (${(await text(n.page, '#farm-s')).trim()})`);
      if (SHOTS) await n.page.screenshot({ path: join(SHOTS, 'weld-rewardsfarm.png'), fullPage: true });
      const sent = walletTxs.length;
      await n.page.click('#fm-go');
      await until(n.page, () => /Farming\./.test(document.querySelector('#fm-status')?.textContent || '') || !!document.querySelector('#fm-status .err'), null, 240000);
      const tx = walletTxs[walletTxs.length - 1], left = await tacOf(LISTED);
      ok(walletTxs.length === sent + 1 && String(tx.to).toLowerCase() === FARM.toLowerCase() && (await stakedOf(LISTED)) > 0n && left < 5n * E18, `rewardsfarm: one press farms the pair in one transaction (${(await text(n.page, '#fm-status')).slice(0, 60)}; ${Number(left / 10n ** 16n) / 100} TAC left)`);
      await until(n.page, () => /Your stake/.test(document.querySelector('#fm-pos')?.textContent || ''), null, 120000);
      ok(true, 'rewardsfarm: and the stake is shown under the form');
      // With no TAC left in the wallet the card stays for the stake (to claim from, or withdraw), and does not say there is nothing to farm.
      const rest = await tacOf(LISTED);
      await rpc('eth_sendTransaction', [{ from: LISTED, to: TAC, data: '0xa9059cbb' + addrWord('0x000000000000000000000000000000000000dEaD') + word(rest) }]);
      await n.page.reload();
      await until(n.page, () => !document.querySelector('#farm').hidden && /Your stake/.test(document.querySelector('#farm-s')?.textContent || ''), null, 120000);
      await n.page.click('#farm > summary');
      await until(n.page, () => /Your stake/.test(document.querySelector('#fm-pos')?.textContent || '') && !document.querySelector('#fm-pos').hidden, null, 120000);
      ok(!(await text(n.page, '#farm-note')) && (await tacOf(LISTED)) === 0n, 'rewardsfarm: farm it all and the card stays for the stake, with its claim and withdrawal and no "nothing to farm" note');
      const pf = await n.page.$$eval('#fm-prog .fm-pf', (a) => a.map((x) => `${x.getAttribute('href')} ${x.innerText.replace(/\s+/g, ' ').trim()}`));
      ok(pf.length === 3 && /^\/#farm\/private-0 tETH \/ TAC 554 TAC a day [\d,]+%/.test(pf[0]), `rewardsfarm: the private farms are listed in the card with their streams and APRs (${pf[0]})`);
      // A day on: claim what the stake earned, and it is filled in to farm again, with the ETH that pairs with it.
      await rpc('evm_increaseTime', [86400]); await rpc('evm_mine', []);
      const tac0 = await tacOf(LISTED);
      await n.page.click('#fm-claim');
      await until(n.page, () => /Claimed/.test(document.querySelector('#fm-pos-status')?.textContent || ''), null, 240000);
      const earned = (await tacOf(LISTED)) - tac0;
      await until(n.page, () => Number(document.querySelector('#fm-tacamt').value) > 0 && /Deposit/.test(document.querySelector('#fm-rcpt')?.textContent || '') && !document.querySelector('#fm-go').disabled, null, 180000);
      const filled = Number(await n.page.inputValue('#fm-tacamt')), rewarded = Number(earned / 10n ** 14n) / 1e4;
      ok(earned > 0n && Math.abs(filled - rewarded) < 0.011 && /filled in to farm it again/.test(await text(n.page, '#fm-pos-status')) && (await n.page.getAttribute('#fm-mode [data-fm="pair"]', 'aria-pressed')) === 'true', `rewardsfarm: a claim from the stake fills the rewards back in to farm again (${rewarded} TAC claimed, ${filled} in the form)`);
      if (n.errors.length) { fails++; console.log('FAIL rewardsfarm page errors: ' + n.errors.slice(0, 3).join(' | ')); }
    } finally { await n.browser.close(); }
    await rpc('evm_revert', [snap]);
  }
  // 2. With less ETH than the claim pairs with: the pair is what the ETH covers, and the page says so.
  const snap2 = await rpc('evm_snapshot');
  {
    await eth(5n * 10n ** 16n); await approve();
    const n = await view(LISTED, LISTED);
    try {
      await claimed(n);
      await until(n.page, () => !document.querySelector('#farm').hidden && document.querySelector('#farm').open && /Deposit/.test(document.querySelector('#fm-rcpt')?.textContent || ''), null, 180000);
      const ethIn = Number(await n.page.inputValue('#fm-amt')), tacIn = Number(await n.page.inputValue('#fm-tacamt')), note = (await text(n.page, '#farm-note')).replace(/\s+/g, ' ');
      ok(ethIn > 0.04 && ethIn <= 0.047 && tacIn < 216176 && /^Your ETH covers [\d,.]+ of the 216,176\.41 TAC\. All of it needs [\d,.]+ ETH\.$/.test(note) && !(await n.page.$eval('#fm-go', (b) => b.disabled)), `rewardsfarm: with 0.05 ETH the pair is what it covers, within the fee kept back, and the page says so (${ethIn} ETH, ${tacIn} TAC; ${note.slice(0, 90)})`);
      await n.page.fill('#fm-amt', '0.01');
      await until(n.page, () => !document.querySelector('#farm-note').textContent, null, 10000);
      ok(true, 'rewardsfarm: and the note goes once the amounts are changed');
    } finally { await n.browser.close(); }
    // 3. Back later with the TAC held: the card is closed with the amount named; with no spare ETH the TAC goes in alone; under the fee, ETH is asked for.
    await eth(2n * 10n ** 15n);
    let m = await view(LISTED, LISTED);
    try {
      await m.page.waitForSelector('#c-air .st', { timeout: 120000 }); await plug(m.page);
      const held = Number((await tacOf(LISTED)) / 10n ** 14n) / 1e4;
      await until(m.page, (h) => !document.querySelector('#farm').hidden && Math.abs(Number((document.querySelector('#farm-s')?.textContent || '').replace(/[^\d.]/g, '')) - h) < 0.011, held, 120000);
      ok(!(await m.page.evaluate(() => document.querySelector('#farm').open)), 'rewardsfarm: back on the page the card is there for the TAC held, closed until it is wanted');
      await m.page.click('#farm > summary');
      await until(m.page, () => /Farm with TAC/.test(document.querySelector('#fm-go')?.textContent || '') && /Earns about/.test(document.querySelector('#fm-rcpt')?.textContent || ''), null, 180000);
      // A claim this large moves the pool a lot when half of it is swapped, so the module asks for the loss to be accepted before the button works.
      const ack = await m.page.$('#fm-ack'), off = await m.page.$eval('#fm-go', (b) => b.disabled), rcpt = (await text(m.page, '#fm-rcpt')).replace(/\s+/g, ' ');
      ok(/no spare ETH/.test(await text(m.page, '#farm-note')) && (ack ? off && /Swap price impact\s*\d+%/.test(rcpt) : !off), `rewardsfarm: with no spare ETH the TAC goes in alone, the page says why, and its price impact is shown (${rcpt.slice(0, 100)})`);
    } finally { await m.browser.close(); }
    await eth(4n * 10n ** 14n);
    m = await view(LISTED, LISTED);
    try {
      await m.page.waitForSelector('#c-air .st', { timeout: 120000 }); await plug(m.page);
      await until(m.page, () => !document.querySelector('#farm').hidden, null, 120000);
      await m.page.click('#farm > summary');
      await until(m.page, () => /Add ETH for the network fee/.test(document.querySelector('#fm-go')?.textContent || ''), null, 180000);
      ok(await m.page.$eval('#fm-go', (b) => b.disabled), 'rewardsfarm: under the network fee the button asks for ETH and cannot be pressed');
    } finally { await m.browser.close(); }
    // 4. Another account's wallet looking at this one sees no farm: it would farm its own TAC, not this account's.
    await eth(E18);
    const o = await view(A0, LISTED);
    try {
      await o.page.waitForSelector('#c-air .st', { timeout: 120000 }); await plug(o.page);
      await until(o.page, () => /Your wallet is on 0xf39f/.test(document.querySelector('#wl')?.textContent || ''), null, 30000);
      await sleep(1500);
      ok(await hidden(o.page), 'rewardsfarm: a wallet on another account is offered no farm for this one');
    } finally { await o.browser.close(); }
  }
  await rpc('evm_revert', [snap2]);
});

// Sending the airdrop to another address from the rewards page, and the ways in to the page: the account's own claim goes to a recipient (an
// address; the zero address and TAC's own contract are refused), nothing is offered to farm there, and the lander line, /airdrop and the account
// sheet on another page lead to the rewards page.
await step('rewardsto', async () => {
  const LISTED = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20', DEST = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', E18 = 10n ** 18n;
  const choose = (page) => page.waitForSelector('.bsheet .way', { timeout: 8000 }).then(() => page.click('.bsheet .way:has-text("Browser wallet")')).catch(() => {});
  await rpc('anvil_impersonateAccount', [LISTED]); await rpc('anvil_setBalance', [LISTED, '0x' + (10n ** 18n).toString(16)]);
  const snap = await rpc('evm_snapshot');
  {
    const n = await openPage({ account: LISTED, viewport: { width: 1000, height: 900 } });
    await n.ctx.route(/api\.tacit\.finance\/(points|claim|leaderboard|farm)/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: /leaderboard/.test(route.request().url()) ? '[]' : /claim/.test(route.request().url()) ? '{"cumulativeAmount":"0","claimedWei":"0","unclaimedWei":"0","proof":null}' : '{"points":0,"deposit_count":0,"deposits":[]}' }));
    try {
      await n.page.goto(n.url + 'rewards/?q=' + LISTED);
      await n.page.waitForSelector('[data-claim="airdrop"]', { timeout: 120000 });
      ok(!!(await n.page.$('[data-to-show]')) && (await n.page.$eval('#to-f', (f) => f.hidden)), 'rewardsto: the claim offers to send it to another address, the form closed');
      await n.page.click('[data-to-show]');
      ok(!(await n.page.$eval('#to-f', (f) => f.hidden)) && (await n.page.evaluate(() => document.activeElement?.id)) === 'to-q', 'rewardsto: the form opens with its bar focused');
      const before = await tacOf(DEST), sent = walletTxs.length;
      for (const bad of ['', '0x0000000000000000000000000000000000000000', '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', '0x12']) {
        await n.page.fill('#to-q', bad); choose(n.page); await n.page.click('#to-f [data-claim]');
        await until(n.page, () => /Enter a 0x address|could not be recovered|bad checksum/.test(document.querySelector('#done')?.textContent || ''), null, 30000);
      }
      ok(walletTxs.length === sent, 'rewardsto: no recipient that is empty, the zero address, TAC itself or not an address sends anything');
      await n.page.fill('#to-q', DEST); choose(n.page); await n.page.click('#to-f [data-claim]');
      await until(n.page, () => !!document.querySelector('#done .done a[href^="https://etherscan.io/tx/0x"]'), null, 180000);
      const tx = walletTxs[walletTxs.length - 1], got = (await tacOf(DEST)) - before, done = (await text(n.page, '#done')).replace(/\s+/g, ' ');
      ok(walletTxs.length === sent + 1 && String(tx.to).toLowerCase() === '0x4b4cb98d0c836c2783ac46f0078b904dab533ae8' && String(tx.data).startsWith('0x4f54d47c') && got > 216000n * E18, `rewardsto: the allocation goes to the recipient by claimTo (${Number(got / 10n ** 16n) / 100} TAC; ${done.slice(0, 70)})`);
      await sleep(2500);
      ok(/to 0x7099…79c8/.test(done) && !(await n.page.$('[data-watch]')) && !(await n.page.evaluate(() => document.querySelector('#farm').open)), 'rewardsto: the page says where it went, and neither opens the farm nor offers add-to-wallet for TAC that is not the wallet\'s');
      if (n.errors.length) { fails++; console.log('FAIL rewardsto page errors: ' + n.errors.slice(0, 3).join(' | ')); }
    } finally { await n.browser.close(); }
    await rpc('evm_revert', [snap]);
  }
  // the ways in
  {
    const n = await openPage({ account: A0, viewport: { width: 1000, height: 900 } });
    try {
      await n.page.goto(n.url);
      await n.page.waitForSelector('#air-news', { timeout: 60000 });
      ok((await n.page.getAttribute('#air-news', 'href')) === '/rewards/', 'rewardsto: the lander\'s airdrop line is a link to the rewards page');
      await n.page.evaluate(() => { location.hash = '#airdrop'; });
      await until(n.page, () => document.querySelector('#sheet-tac')?.open === true && !document.querySelector('#air-more').hidden, null, 60000);
      ok((await n.page.getAttribute('#air-more a', 'href')) === '/rewards/', 'rewardsto: and the Airdrop tab of its TAC sheet points there too');
      await n.page.click('[data-tac-mode="buy"]');
      await until(n.page, () => document.querySelector('#air-more').hidden, null, 10000);
      ok(true, 'rewardsto: (only on that tab)');
      // The host serves the front page for a path that is not a file; this server does not, so it is asked to for /airdrop.
      await n.ctx.route(/\/airdrop(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(DAPP, 'index.html')) }));
      await n.page.goto(n.url + 'airdrop?x=1');
      await until(n.page, () => location.pathname === '/rewards/', null, 30000);
      ok(true, 'rewardsto: /airdrop is the rewards page');
      await n.page.goto(n.url + 'swap/');
      await n.page.waitForSelector('#wallet-chip', { timeout: 60000 });
      choose(n.page); await n.page.click('#wallet-chip');
      await until(n.page, () => /0x[0-9a-f]{4}/i.test(document.querySelector('#wallet-label')?.textContent || ''), null, 30000);
      await n.page.click('#wallet-chip');
      await n.page.waitForSelector('.bsheet a[href^="/rewards/"]', { timeout: 15000 });
      ok((await n.page.getAttribute('.bsheet a[href^="/rewards/"]', 'href')) === '/rewards/?q=' + A0.replace(/^0x/, '0x'), 'rewardsto: the wallet sheet on another page links to this account\'s airdrop and points');
      await n.page.goto(n.url + 'rewards/');
      await n.page.waitForSelector('#wallet-chip', { timeout: 60000 });
      await sleep(2000);                                                              // the wallet used on the swap page is found again once the page is idle
      if (!/0x[0-9a-f]{4}/i.test(await text(n.page, '#wallet-label'))) {
        choose(n.page); await n.page.click('#wallet-chip');
        await until(n.page, () => /0x[0-9a-f]{4}/i.test(document.querySelector('#wallet-label')?.textContent || ''), null, 30000);
        await until(n.page, () => !document.querySelector('.bsheet'), null, 30000);
      }
      await n.page.click('#wallet-chip');
      await n.page.waitForSelector('.bsheet [data-mine-sheet]', { timeout: 15000 });
      ok(!(await n.page.$('.bsheet a[href^="/rewards/"]')), 'rewardsto: and the rewards page\'s own sheet has no link to itself');
    } finally { await n.browser.close(); }
  }
});

// What the rewards page shows of points beyond the total: today's share of the day's pot (the most a point can earn is the rate cap), the days one
// by one (read only when opened), and the leaderboard's top ten with the account's own place when it is further down (a row looks that address up).
await step('rewardsfolds', async () => {
  const ME = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20', hex40 = (c) => '0x' + c.repeat(40);
  const board = Array.from({ length: 14 }, (_, i) => ({ address: i === 11 ? ME : hex40((i + 1).toString(16)), points: 100000 - i * 1000 }));
  let dayCalls = 0;
  const n = await openPage({ account: A0, viewport: { width: 1000, height: 900 } });
  await n.ctx.route(/api\.tacit\.finance\/(points|claim|leaderboard)/, (route) => {
    const u = route.request().url();
    if (/leaderboard\?day=today/.test(u)) return json(route, { day: 20743, programDay: 25, programDays: 90, program: { settleGraceSecs: 1800, dayBudgetWei: '1111111111111111111111', rateCap: [{ fromDay: 20729, maxWeiPerPoint: '30000000000000000' }], rates: { holding: 1000, wrap: 1250, evmpooldeposit: 1000, zswapeth: 1000, cbtcmint: 1000, cbtchold: 500, cusdmint: 2, pmbet: 1000 }, budgets: [{ fromDay: 20747, groups: [{ name: 'stay', activities: ['holding', 'cbtchold'], share: 0.25, maxWeiPerPoint: '20000000000000000' }, { name: 'use', activities: ['zswapeth', 'cusdmint'], share: 0.15, maxWeiPerPoint: '10000000000000000' }] }], weights: [{ fromDay: 20730, weights: { zswapeth: 2, cusdmint: 0 } }], addressDayCaps: [{ fromDay: 20741, caps: { wrap: '5' } }], categoryShareCaps: [{ fromDay: 20741, caps: { evmpooldeposit: 0.5 } }], holder: { tiers: [{ tac: 100, multiplier: 1.25 }, { tac: 1000, multiplier: 1.5 }] }, earlyBonus: { max: 5 } } });
    if (/leaderboard/.test(u)) return json(route, board);
    if (/\/claim\//.test(u)) return json(route, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null });
    if (/\/days$/.test(u)) { dayCalls++; return json(route, { days: [{ day: 20743, points: 40, settled: false }, { day: 20742, points: 33.458, settled: true, tacWei: '10746707713728415' }] }); }
    const a = (u.match(/0x[0-9a-fA-F]{40}/) || [''])[0].toLowerCase();
    return json(route, { address: a, points: a === ME ? 5000 : 0, deposit_count: 3, today: { points: 1000, totalPoints: 2000000, dayBudgetWei: '1000000000000000000000', tacWei: '3000000000000000000' }, deposits: [] });
  });
  try {
    await n.page.goto(n.url + 'rewards/?q=' + ME);
    await n.page.waitForSelector('#c-pts [data-days]', { timeout: 120000 });
    const read = (sel) => n.page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()), kv = await read('#c-pts .kv');
    ok(/Today 1,000 points · 0\.050% of the day · about 3 TAC/.test(kv), `rewardsfolds: today's share of the day's pot, in points and percent, and the TAC the service says it pays (not the share of the pot) (${kv.trim()})`);
    const clk = await read('#c-pts .clock');
    ok(/^Day 25 of 90 · today's points can be claimed after 00:30 UTC$/.test(clk), `rewardsfolds: the program's day and when today's points can be claimed (${clk})`);
    ok(dayCalls === 0 && !(await n.page.$eval('#c-pts [data-days]', (d) => d.open)), 'rewardsfolds: the days are not read until the fold is opened');
    await n.page.click('#c-pts [data-days] > summary');
    await n.page.waitForSelector('#c-pts .rows li', { timeout: 20000 });
    const days = await read('#c-pts .rows');
    ok(dayCalls === 1 && /Sat 17 Oct\s*\+40\.0\s*in progress/.test(days) && /Fri 16 Oct\s*\+33\.5\s*0\.0107 TAC/.test(days), `rewardsfolds: points by day, the settled day with its TAC and today as counting (${days.trim()})`);
    await n.page.click('#earn > summary');
    await n.page.waitForSelector('#earn-b .ways li', { timeout: 20000 });
    const ways = await n.page.$$eval('#earn-b .ways li', (a) => a.map((x) => `${x.querySelector('a').getAttribute('href')} ${x.innerText.replace(/\s+/g, ' ').trim()}`));
    ok(ways.length === 5 && /^\/#points Hold ETH in the private pools 1,000 points per ETH a day, proven on your device$/.test(ways[0]) && /^\/#private Wrap ETH into the Tacit pool 1,250 points per ETH · up to 5 ETH a day per address$/.test(ways[1]) && /^\/#device .* 1,000 points per ETH · together at most 50% of a day's 1,111 TAC$/.test(ways[2]) && /^\/swap\/ Buy TAC with ETH \(Precision pool\) 2,000 points per ETH · ×2$/.test(ways[3]) && !ways.some((w) => /Borrow cUSD/.test(w)) && /500 a day while it stays posted/.test(ways[4]), `rewardsfolds: Earn more lists each action with its rate, weight, limits and where to do it, the staying reward first, and leaves out one that is weighted to nothing (${ways.length}: ${ways[3]})`);
    const reserved = await read('#earn-b > p:first-of-type');
    ok(/^From Wed 21 Oct, part of each day's 1,111 TAC is set aside: 25% for holding ETH in the private pools and keeping bonds posted \(up to 0\.02 TAC a point\) and 15% for buying TAC and borrowing \(up to 0\.01 TAC a point\)\. A share that is not used goes back to everyone else\.$/.test(reserved), `rewardsfolds: the reserved shares, with their start day and what a point can earn (${reserved.slice(0, 60)}…)`);
    ok(/Holding 100 or 1,000 public TAC at the same address for a day multiplies that day's points by 1\.25× or 1\.5×\. Early activity counts up to 5×\./.test(await read('#earn-b > p:last-of-type')), 'rewardsfolds: and the holder boost and the early bonus');
    await n.page.click('#lb > summary');
    await n.page.waitForSelector('#lb-b .board li', { timeout: 20000 });
    const rows = await n.page.$$eval('#lb-b .board li', (a) => a.map((x) => `${x.className}:${x.innerText.replace(/\s+/g, ' ').trim()}`));
    ok(rows.length === 12 && /^:#1 0x1111…1111 100,000$/.test(rows[0]) && rows[10] === 'gap:⋯' && /^me:#12 0x1c0a…5a20 89,000$/.test(rows[11]), `rewardsfolds: the leaderboard's top ten, then this account's own place marked (${rows.slice(9).join(' | ')})`);
    await n.page.click('#lb-b .board li:first-child button');
    await until(n.page, () => document.querySelector('#q').value === '0x1111111111111111111111111111111111111111' && /0x1111…1111/.test(document.querySelector('.who')?.textContent || ''), null, 30000);
    ok(true, 'rewardsfolds: a row on the board looks that address up');
    await n.page.setViewportSize({ width: 390, height: 900 });
    ok(!(await n.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'rewardsfolds: no sideways scroll at phone width');
    if (n.errors.length) { fails++; console.log('FAIL rewardsfolds page errors: ' + n.errors.slice(0, 3).join(' | ')); }
  } finally { await n.browser.close(); }
});

// Any address can be looked up on the points sheet by someone with no wallet: a bad entry is told, a good one is read like the account's own
// (its points, ranks and what it can claim) and is never offered a Claim, since a claim pays the account that sends it.
await step('ptslookup', async () => {
  const today = Math.floor(Date.now() / 86400e3), X = '0x' + 'ab'.repeat(20), hex = (c) => '0x' + c.repeat(40);
  const n = await openPage({ account: A0, viewport: { width: 390, height: 900 } });
  const program = { startDay: today - 8, days: 90, dayBudgetWei: '1111111111111111111111', totalWei: '100000000000000000000000', rates: { zswapeth: 1000 }, weights: [{ fromDay: today - 1, weights: {} }] };
  await n.ctx.route(/api\.tacit\.finance\/(points|claim)\/0x/, (route) => {
    const u = route.request().url(), a = (u.match(/0x[0-9a-fA-F]{40}/) || [''])[0].toLowerCase(), mine = a === X;
    if (/\/claim\//.test(u)) return json(route, mine ? { cumulativeAmount: '8000000000000000000', claimedWei: '0', unclaimedWei: '8000000000000000000', proof: ['0x' + '11'.repeat(32)] } : { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null });
    if (/\/days$/.test(u)) return json(route, { address: a, startDay: today - 8, programDays: 90, today, lastSettledDay: today - 1, earnedWei: '8000000000000000000', days: [{ day: today - 1, points: 100, raw: 100, factor: 1, tacWei: '2000000000000000000', settled: true }] });
    return json(route, { address: a, points: mine ? 1234.5 : 0, deposit_count: mine ? 3 : 0, today: { points: mine ? 100 : 0, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', factor: 1, rawPoints: 100, kinds: 1, activeDays: 1 }, deposits: [] });
  });
  await n.ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, /day=today/.test(route.request().url())
    ? { day: today, programDay: 9, programDays: 90, program, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', taking: 2, rows: [{ address: hex('1'), points: 800 }, { address: X, points: 100 }] }
    : [{ address: hex('1'), points: 9e9 }, { address: X, points: 1234.5 }]));
  try {
    await n.page.goto(n.url + '#pts');
    await n.page.waitForSelector('#pl-look', { timeout: 60000 });
    ok(!!(await n.page.$('#pts-connect')), 'ptslookup: the box is there with no wallet connected');
    await n.page.fill('#pl-look', '0x12'); await n.page.click('#pl-look-f button');
    await until(n.page, () => /not an address/.test(document.querySelector('#pts-body')?.textContent || ''), null, 30000);
    ok((await n.page.getAttribute('#pl-look', 'aria-invalid')) === 'true' && !(await n.page.$('#pts-body [data-claim]')), 'ptslookup: something that is not an address is told, and marked on the field');
    await n.page.fill('#pl-look', ' ' + X.toUpperCase().replace('0X', '0x') + ' '); await n.page.click('#pl-look-f button');
    await until(n.page, () => /Looked up/.test(document.querySelector('#pts-body')?.textContent || ''), null, 60000);
    const t = (await text(n.page, '#pts-body')).replace(/\s+/g, ' ');
    ok(/1,235\s*points · Looked up 0xabab/.test(t) && /rank\s*#2/.test(t) && /#2 today/.test(t), `ptslookup: a pasted address (spaces and capitals as pasted) is read: its points and its place on both boards (${t.slice(t.indexOf('Look up'), t.indexOf('Look up') + 200)})`);
    ok(/To claim\s*8 TAC/.test(t) && /Connect this address to claim it/.test(t) && !(await n.page.$('#pts-body [data-claim]')), 'ptslookup: what it can claim is told, with no Claim button');
    ok(!/Hold [\d,]+ TAC here/.test(t) && !!(await n.page.$('#pts-connect')), 'ptslookup: the signed-in account’s nudges are not said of it, and the connect prompt stays');
    ok(!(await n.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'ptslookup: no sideways scroll at phone width');
    if (SHOTS) await n.page.screenshot({ path: join(SHOTS, 'weld-ptslookup.png'), fullPage: false });
    if (n.errors.length) { fails++; console.log('FAIL ptslookup page errors: ' + n.errors.slice(0, 3).join(' | ')); }
  } finally { await n.browser.close(); }
});
// Reserved budgets on the points sheet: the Terms say each group's share of the day's pot and its ceiling (and when it starts), and an address's TAC
// for the day so far is the figure the service gives, not its share of the pot.
await step('ptsbudgets', async () => {
  const today = Math.floor(Date.now() / 86400e3), X = '0x' + 'ab'.repeat(20), hex = (c) => '0x' + c.repeat(40);
  const n = await openPage({ account: A0, viewport: { width: 1000, height: 900 } });
  const program = { startDay: today - 8, days: 90, dayBudgetWei: '1111111111111111111111', totalWei: '100000000000000000000000', rates: { zswapeth: 1000, holding: 1000 }, weights: [{ fromDay: today - 1, weights: {} }],
    budgets: [{ fromDay: today + 3, groups: [{ name: 'stay', activities: ['holding', 'cbtchold'], share: 0.25, maxWeiPerPoint: '20000000000000000' }, { name: 'use', activities: ['zswapeth', 'cusdmint'], share: 0.15, maxWeiPerPoint: '10000000000000000' }] }] };
  await n.ctx.route(/api\.tacit\.finance\/(points|claim)\/0x/, (route) => {
    const u = route.request().url(), a = (u.match(/0x[0-9a-fA-F]{40}/) || [''])[0].toLowerCase(), mine = a === X;
    if (/\/claim\//.test(u)) return json(route, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null });
    if (/\/days$/.test(u)) return json(route, { address: a, startDay: today - 8, programDays: 90, today, lastSettledDay: today - 1, earnedWei: '0', days: [] });
    return json(route, { address: a, points: mine ? 1234.5 : 0, deposit_count: mine ? 3 : 0, today: { points: mine ? 100 : 0, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', tacWei: mine ? '7000000000000000000' : '0', factor: 1, rawPoints: 100, kinds: 1, activeDays: 1 }, deposits: [] });
  });
  await n.ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, /day=today/.test(route.request().url())
    ? { day: today, programDay: 9, programDays: 90, program, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', taking: 2, rows: [{ address: hex('1'), points: 800, tacWei: '900000000000000000000' }, { address: X, points: 100, tacWei: '7000000000000000000' }] }
    : [{ address: hex('1'), points: 9e9 }, { address: X, points: 1234.5 }]));
  try {
    await n.page.goto(n.url + '#pts');
    await n.page.waitForSelector('#pl-look', { timeout: 60000 });
    await n.page.fill('#pl-look', X); await n.page.click('#pl-look-f button');
    await until(n.page, () => /Looked up/.test(document.querySelector('#pts-body')?.textContent || ''), null, 60000);
    const t = (await text(n.page, '#pts-body')).replace(/\s+/g, ' ');
    ok(/Today\s*100 points · [\d.]+% · about 7 TAC/.test(t), `ptsbudgets: today's TAC is the service's own figure, not the share of the pot (${(t.match(/Today\s*100 points[^A-Z]*TAC/) || [''])[0]})`);
    await n.page.click('#pts-body details.ptlog > summary:has-text("Terms")');
    const terms = (await text(n.page, '#pts-body details.ptlog')).replace(/\s+/g, ' ');
    const when = new Date((today + 3) * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    ok(new RegExp(`Reserved\\s*From ${when}: 25% of a day’s 1,111 TAC for holding ETH in the private pools and keeping bonds posted \\(up to 0\\.02 TAC per point\\) and 15% of a day’s 1,111 TAC for buying TAC and borrowing \\(up to 0\\.01 TAC per point\\)\\. A share that is not used goes back to everyone else\\.`).test(terms), `ptsbudgets: the Terms say each group's share, its ceiling and when it starts (${(terms.match(/Reserved.{0,330}/) || [''])[0]})`);
    if (n.errors.length) { fails++; console.log('FAIL ptsbudgets page errors: ' + n.errors.slice(0, 3).join(' | ')); }
  } finally { await n.browser.close(); }
});
// The points sheet from a stubbed service: activity across chains in time order (Base's larger block numbers do not put
// an older Base deposit first), the holder boost of the newest, the rank, what was claimed, and today's countdown; the day's
// pot, the all-time and today's boards, the gap to the next rank, what changed since an earlier day, and the points-per-day
// bars; and, without anyone connected, the same public board with a way to find an address in it.
await step('ptsview', async () => {
  const t0 = Math.floor(Date.now() / 1000), today = Math.floor(t0 / 86400);
  const seen = JSON.stringify({ [A0.toLowerCase()]: { cur: { d: today - 3, p: 1000, k: 5 } } });
  const r = await openPage({ account: A0, init: { fn: (s) => { if (!localStorage.getItem('tacit-weld-pts-seen-v1')) localStorage.setItem('tacit-weld-pts-seen-v1', s); }, arg: seen } });
  const dep = (h, chain, block, ago, activity, pts, boost) => ({ tx_hash: '0x' + h.repeat(64), block_number: block, block_time: t0 - ago, amount_wei: '100000000000000000', points: pts, activity, tac_boost: boost, chain_id: chain, pp_boosted: false });
  const hex = (c) => '0x' + c.repeat(40);
  const pointsBody = (count) => ({ address: A0.toLowerCase(), points: 1234.5, deposit_count: count,
    today: { points: 100, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', factor: 1.25, rawPoints: 80, kinds: 2, activeDays: 3 },
    deposits: [dep('b', 8453, 52000000, 7200, 'evmpooldeposit', 90, 1), dep('a', 1, 26090000, 60, 'wrap', 125, 1.5), dep('c', 1, 26080000, 90000, 'zswapeth', 100, 1), { ...dep('d', 1, 26070000, 200000, 'cbtchold', 80, 1), amount_wei: '0' }, dep('e', 1, 26060000, 300000, 'cbtcmint', 10000, 1)] });
  // Each day of the program, as the service gives it: today an estimate, a settled day with its TAC, and a day that carries points only (its TAC is null).
  const daysBody = { address: A0.toLowerCase(), startDay: today - 8, programDays: 90, today, lastSettledDay: today - 1, earnedWei: '8000000000000000000', days: [
    { day: today, points: 215, raw: 172, factor: 1.25, tacWei: '4500000000000000000', settled: false }, { day: Math.floor((t0 - 200000) / 86400), points: 80, raw: 80, tacWei: '1000000000000000000', settled: true }, { day: today - 1, points: 100, tacWei: '2000000000000000000', settled: true }, { day: today - 5, points: 40, tacWei: null, settled: true }] };
  await r.ctx.route(/api\.tacit\.finance\/points\/0x/, (route) => json(route, /\/days$/.test(route.request().url()) ? daysBody : pointsBody(5)));
  await r.ctx.route(/api\.tacit\.finance\/claim\/0x/, (route) => json(route, { cumulativeAmount: '8000000000000000000', claimedWei: '5000000000000000000', unclaimedWei: '3000000000000000000', proof: null }));
  const dShort = (d) => new Date(d * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  // Terms that differ from the page's own, so a pass shows they are read and not echoed: another ceiling that lifts later, a dearer wrap, no cUSD row, other holder tiers.
  const program = { startDay: today - 8, days: 90, lastDay: today + 81, totalWei: '100000000000000000000000', dayBudgetWei: '1111111111111111111111',
    rateCap: [{ fromDay: today - 2, maxWeiPerPoint: '20000000000000000' }, { fromDay: today + 20, maxWeiPerPoint: null }], settleGraceSecs: 1800,
    earlyBonus: { max: 3, halfLife: 100 }, tethWrapBoost: 1.25, holder: { tiers: [{ tac: 50, multiplier: 1.1 }, { tac: 500, multiplier: 1.3 }], windowHours: 24 },
    rates: { wrap: 1500, evmpooldeposit: 1000, zswapeth: 1000, cbtcmint: 1000, cbtchold: 500 }, cbtcHoldFromDay: today + 1,
    // A weight in force, a multiplier for the week that starts tomorrow, and a bond rule that does too.
    weights: [{ fromDay: today - 1, weights: { cbtcmint: 3 } }], addressDayCaps: [{ fromDay: today + 1, caps: { evmpooldeposit: '5' } }], categoryShareCaps: [{ fromDay: today + 1, caps: { evmpooldeposit: 0.5 } }], engagement: [{ fromDay: today + 1, kindStep: 0.25, returnStep: 0.25, maxKinds: 2, minPoints: 25 }], bondHoldFromDay: today + 1,
    kinds: { wrap: 'private', cbtcmint: 'borrow' } };
  await r.ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, /day=today/.test(route.request().url())
    ? { day: today, programDay: 9, programDays: 90, program, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', taking: 2, rows: [{ address: A0.toLowerCase(), points: 100 }, { address: hex('2'), points: 50 }] }
    : [{ address: hex('1'), points: 9e9 }, { address: A0.toLowerCase(), points: 1234.5 }]));
  await r.page.goto(r.url + '#pts');
  await r.page.click('#pts-connect');
  await until(r.page, () => !!document.querySelector('#pts-body .pt .ptl, #pts-body .pt .ptd'), null, 60000);
  await r.page.click('#pts-body .ptlog summary');
  await shot(r.page, 'ptsview');
  const v = await r.page.evaluate(() => ({ body: document.querySelector('#pts-body').textContent.replace(/\s+/g, ' '),
    items: [...document.querySelectorAll('#pts-body .pt .ptl li:not(.day)')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    days: [...document.querySelectorAll('#pts-body .pt .ptl li.day')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    bars: document.querySelectorAll('#pts-body .ptd-b').length,
    links: [...document.querySelectorAll('#pts-body .ptl a')].map((a) => a.href) }));
  ok(/^Wrapped ETH/.test(v.items[0] || '') && /^Deposited ETH on Base/.test(v.items[1] || '') && /^Swapped ETH/.test(v.items[2] || ''), `ptsview: recent points in time order across chains (${v.items.join(' | ')})`);
  ok(v.days.length >= 2 && /^Today\s*\+215\s*×1\.25\s*about 4\.5 TAC$/.test(v.days[0]) && /^Yesterday\s*\+100\s*2 TAC$/.test(v.days[1]), `ptsview: the activity is grouped under each day's total and what it paid (${v.days.join(' | ')})`);
  ok(/Holder boost at last activity\s*1\.5×/.test(v.body), 'ptsview: the holder boost is the newest activity\'s');
  ok(/rank\s*#2/.test(v.body) && /#1 today/.test(v.body) && /Claimed so far\s*5 TAC/.test(v.body) && /10% · about 111\.11 TAC/.test(v.body) && /closes in \d/.test(v.body), `ptsview: rank, claimed, today's share and the countdown (${v.body.slice(0, 500)})`);
  ok(/Earned from finished days\s*8 TAC/.test(v.body) && /To reach #1\s*8,999,998,766 points/.test(v.body), `ptsview: settled TAC and the gap to the rank above (${v.body.slice(0, 700)})`);
  ok(/Since \d+ \w+\s*\+235 points · up 3 places/.test(v.body), `ptsview: the change since an earlier day this browser saw (${v.body.slice(0, 700)})`);
  ok(/Today’s pot\s*1,111 TAC · day 9 of 90/.test(v.body) && /Points so far today\s*1,000 · 2 taking part/.test(v.body) && /each 1,000 points earn\s*1,111\.1 TAC/.test(v.body), `ptsview: the day's pot, points and rate (${v.body.slice(0, 500)})`);
  ok(v.bars >= 2, `ptsview: points per day are drawn as bars (${v.bars})`);
  const lastD = dShort(today + 81), nextD = dShort(today + 20);
  ok(new RegExp(`Every day through ${lastD} \\(UTC\\), up to 1,111 TAC is split by that day’s points, at most 0\\.02 TAC per point, no limit from ${nextD}\\.`).test(v.body),
    `ptsview: the lede states the days, the pot and the limit per point with its next change as the service gives them (${v.body.slice(0, 260)})`);
  ok(/1,500 points per ETH/.test(v.body) && /1,000 per ETH, on Ethereum, Base or Robinhood Chain/.test(v.body) && /1,000 per wstETH/.test(v.body) && !/Borrow cUSD/.test(v.body),
    'ptsview: each way of earning pays what the service says, and one it does not list is not offered');
  ok(/Early activity counts up to 3×\. Holding 50 or 500 public TAC at the same address through the past day multiplies its points by 1\.1 or 1\.3\./.test(v.body),
    `ptsview: the early bonus and the holder tiers are the service's (${v.body.slice(-330)})`);
  ok(/Hold 50 public TAC here through a day and what it does next earns 1\.1×/.test(v.body), 'ptsview: the next holder tier is read from the same tiers');
  ok(/1,000 per wstETH once cBTC is minted against it \(from \d+ \w+\) · ×3(?! from)/.test(v.body), 'ptsview: a weight in force shows on its way of earning');
  ok(/up to 5 ETH a day per address from \d+ \w+/.test(v.body) && /Per address\s*ETH-pool deposit counts up to 5 ETH a day, all chains together from \d+ \w+/.test(v.body), `ptsview: a daily limit per address shows on its way of earning and in the terms (${v.body.slice(0, 300)})`);
  ok(/together up to 50% of a day's 1,111 TAC from \d+ \w+/.test(v.body) && /Share limit\s*ETH-pool deposit points together take at most 50% of a day’s 1,111 TAC; the rest is split as before \(from \d+ \w+\)/.test(v.body), `ptsview: a share limit shows on its way of earning and in the terms (${v.body.slice(0, 300)})`);
  ok(new RegExp(`1,000 per wstETH once cBTC is minted against it \\(from ${dShort(today + 1)}\\) · ×3; 500 a day while a bond on a Bitcoin lock stays posted from ${dShort(today + 1)}`).test(v.body), 'ptsview: the bond\'s mint condition, its daily credit and the day they start show on its way of earning');
  ok(v.days.some((d) => /\+0\s*not counted/.test(d)), `ptsview: a day whose listed points were not counted (a released bond) says so instead of adding them up (${v.days.join(' | ')})`);
  ok(/Kept a cBTC bond posted/.test(v.body) && !v.links.some((h) => h.includes('d'.repeat(64))), 'ptsview: a day\'s bond credit is listed as activity and links to no transaction');
  ok(/This week\s*×1\.25 · 2 kinds of activity · 3 days/.test(v.body), `ptsview: an address whose points were multiplied for the week is told so (${v.body.slice(500, 900)})`);
  await r.page.click('#pts-body summary:has-text("Terms")');
  await r.page.evaluate(() => document.querySelector('#pts-body details:has(> summary)').closest('#pts-body').lastElementChild.scrollIntoView({ block: 'end' }));
  await shot(r.page, 'ptsview-terms');
  const terms = await r.page.$eval('#pts-body details:has(> summary:has-text("Terms"))', (d) => d.textContent.replace(/\s+/g, ' '));
  ok(new RegExp(`Runs\\s*${dShort(today - 8)} to ${lastD} \\(UTC\\), 90 days`).test(terms) && /Each day’s pot\s*up to 1,111 TAC, of 100,000 in all/.test(terms)
    && new RegExp(`Limit\\s*0\\.02 TAC per point, no limit from ${nextD}`).test(terms)
    && /Weights\s*cBTC bond ×3(?! from)/.test(terms)
    && new RegExp(`Each week\\s*25% more for each other kind of activity in the past 7 days \\(up to 50%; a kind counts once it has earned 25 points that week\\), and 25% more for activity on more than one day, from ${dShort(today + 1)}`).test(terms)
    && new RegExp(`Bonds\\s*a cBTC bond counts if cBTC has been minted against it and it is still posted when its day settles, shortly after the day ends, from ${dShort(today + 1)}; a bond on a Bitcoin lock earns a flat 500 points per wstETH for each further day it stays posted, credited when the day settles and counted as activity for the week, from ${dShort(today + 1)}`).test(terms)
    && /Counting\s*each activity at its weight, times the week’s multiplier\. A day’s pot is split by these counted points; the all-time total is points as scored/.test(terms) && /Points go to\s*the address that sent the transaction/.test(terms) && /Settled\s*each day, shortly after it ends/.test(terms) && /Claim\s*any time once a day is settled/.test(terms),
    `ptsview: the terms list the days, the pot, the limit, who is paid and when (${terms.slice(0, 300)})`);
  await r.page.click('.ptd-b:last-child');
  const said = (await r.page.textContent('.ptd-r')).trim();
  ok(/^Today · 215 points · about 4\.5 TAC$/.test(said), `ptsview: pressing a bar names its day, its points and its TAC (${said})`);
  const bars = await r.page.$$eval('.ptd-b', (b) => b.map((x) => x.dataset.ptd));
  ok(bars.some((x) => /^\w{3} \d+ \w+ · 40 points$/.test(x)) && bars.some((x) => /^Yesterday · 100 points · 2 TAC$/.test(x)), `ptsview: a day the service cannot show as paid carries points only (${bars.slice(-6).join(' | ')})`);
  const board = await r.page.$$eval('#pts-body ol.lb:not(details ol) li', (l) => l.map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
  ok(board.length === 2 && /^1\s*0x1111…1111/.test(board[0]) && /^2\s*0xf39f…2266 · you/.test(board[1]) && /2 taking part/.test(v.body), `ptsview: the leaderboard marks this address (${board.join(' | ')})`);
  await r.page.click('[data-plv="day"]');
  const day = await r.page.$$eval('#pts-body ol.lb:not(details ol) li', (l) => l.map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
  await r.page.evaluate(() => document.querySelector('#pts-body .seg.sub').scrollIntoView({ block: 'start' }));
  await shot(r.page, 'ptsview-board');
  ok(day.length === 2 && /^1\s*0xf39f…2266 · you\s*100\s*111\.11 TAC/.test(day[0]) && /^2\s*0x2222…2222\s*50\s*55\.56 TAC/.test(day[1]), `ptsview: today's board ranks the day's points with each share of the pot (${day.join(' | ')})`);
  ok(v.links.some((h) => h.startsWith('https://basescan.org/tx/0x' + 'b'.repeat(64))) && v.links.some((h) => h.startsWith('https://etherscan.io/tx/0x' + 'a'.repeat(64))), 'ptsview: each activity links to its own chain\'s explorer');
  ok(!(await r.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'ptsview: no sideways scroll');
  if (r.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
  // A history longer than the 100 activities the service lists still draws its bars from the days; without the route it does not draw them, and says what it lists.
  for (const route of [true, false]) {
    const l = await openPage({ account: A0 });
    await l.ctx.route(/api\.tacit\.finance\/points\/0x/, (rt) => (/\/days$/.test(rt.request().url()) ? (route ? json(rt, daysBody) : rt.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"not found"}' })) : json(rt, pointsBody(250))));
    await l.ctx.route(/api\.tacit\.finance\/claim\/0x/, (rt) => json(rt, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null }));
    await l.ctx.route(/api\.tacit\.finance\/leaderboard/, (rt) => json(rt, [{ address: A0.toLowerCase(), points: 1234.5 }]));
    await l.page.goto(l.url + '#pts');
    await l.page.click('#pts-connect');
    await until(l.page, () => !!document.querySelector('#pts-body .pt .ptlog'), null, 60000);
    await l.page.click('#pts-body .ptlog summary');
    const n250 = await l.page.evaluate(() => ({ bars: document.querySelectorAll('#pts-body .ptd-b').length, body: document.querySelector('#pts-body').textContent.replace(/\s+/g, ' ') }));
    ok(route ? n250.bars >= 2 : n250.bars === 0 && /The latest 5 of 250 are listed/.test(n250.body), `ptsview: ${route ? 'a history past the 100 listed still draws its days' : 'without the days route, a history past the 100 listed draws no bars and says so'} (${n250.bars} bars)`);
    if (l.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + l.errors.slice(0, 3).join(' | ')); }
    await l.browser.close();
  }
  // Terms the page cannot read leave its own in place; a pot below the nominal one says it is at the limit per point.
  {
    const l = await openPage({ account: A0 });
    await l.ctx.route(/api\.tacit\.finance\/points\/0x/, (rt) => json(rt, { address: A0.toLowerCase(), points: 10, deposit_count: 1, today: { points: 10, totalPoints: 100, dayBudgetWei: '500000000000000000000' }, deposits: [] }));
    await l.ctx.route(/api\.tacit\.finance\/claim\/0x/, (rt) => json(rt, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null }));
    await l.ctx.route(/api\.tacit\.finance\/leaderboard/, (rt) => json(rt, /day=today/.test(rt.request().url())
      ? { day: today, programDay: 9, programDays: 90, program: { startDay: 'soon', days: -1, dayBudgetWei: 'a lot', rates: 7 }, totalPoints: 100, dayBudgetWei: '500000000000000000000', taking: 1, rows: [{ address: A0.toLowerCase(), points: 10 }] }
      : [{ address: A0.toLowerCase(), points: 10 }]));
    await l.page.goto(l.url + '#pts');
    await l.page.click('#pts-connect');
    await until(l.page, () => !!document.querySelector('#pts-body .pulse'), null, 60000);
    const d = await l.page.evaluate(() => document.querySelector('#pts-body').textContent.replace(/\s+/g, ' '));
    const capped = today >= Math.floor(Date.UTC(2026, 9, 3) / 864e5);
    ok(new RegExp(`Every day through 21 Dec \\(UTC\\), up to 1,111 TAC is split by that day’s points, at most 0\\.03 TAC per point${capped ? '' : ' from 3 Oct'}\\.`).test(d) && /1,250 points per ETH/.test(d) && /Borrow cUSD/.test(d) && /Holding 100, 1,000 or 10,000 public TAC/.test(d),
      `ptsview: terms the page cannot read leave its own (${d.slice(0, 240)})`);
    ok(/Today’s pot\s*500 TAC · day 9 of 90 at the limit per point/.test(d), `ptsview: a pot below the nominal one says it is at the limit per point (${d.slice(0, 300)})`);
    if (l.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + l.errors.slice(0, 3).join(' | ')); }
    await l.browser.close();
  }
  // A bond that stops scoring when posted: until the day it changes it still pays, then only the daily credit does, and Terms says so.
  {
    const z = await openPage({ account: A0 });
    const zeroProgram = { startDay: today - 8, days: 90, totalWei: '100000000000000000000000', dayBudgetWei: '1111111111111111111111', rateCap: [],
      weights: [{ fromDay: today + 1, weights: { cbtcmint: 0 } }], engagement: [], bondHoldFromDay: today + 1, cbtcHoldFromDay: today + 1,
      rates: { wrap: 1250, evmpooldeposit: 1000, zswapeth: 1000, cbtcmint: 1000, cbtchold: 500 } };
    await z.ctx.route(/api\.tacit\.finance\/points\/0x/, (rt) => json(rt, { address: A0.toLowerCase(), points: 0, deposit_count: 0, today: { points: 0, totalPoints: 100, dayBudgetWei: '1111111111111111111111' }, deposits: [] }));
    await z.ctx.route(/api\.tacit\.finance\/claim\/0x/, (rt) => json(rt, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null }));
    await z.ctx.route(/api\.tacit\.finance\/leaderboard/, (rt) => json(rt, /day=today/.test(rt.request().url())
      ? { day: today, programDay: 9, programDays: 90, program: zeroProgram, totalPoints: 100, dayBudgetWei: '1111111111111111111111', taking: 1, rows: [{ address: A0.toLowerCase(), points: 10 }] }
      : [{ address: A0.toLowerCase(), points: 10 }]));
    await z.page.goto(z.url + '#pts');
    await z.page.click('#pts-connect');
    await until(z.page, () => !!document.querySelector('#pts-body .pulse'), null, 60000);
    await z.page.click('#pts-body summary:has-text("Terms")');
    const zt = { body: await z.page.$eval('#pts-body', (e) => e.textContent.replace(/\s+/g, ' ')), terms: await z.page.$eval('#pts-body details:has(> summary:has-text("Terms"))', (d) => d.textContent.replace(/\s+/g, ' ')) };
    ok(new RegExp(`1,000 per wstETH until ${dShort(today)}; then 500 a day while a bond on a Bitcoin lock stays posted`).test(zt.body), `ptsview: until the day posting stops scoring it still pays, then only the daily credit does (${zt.body.slice(zt.body.indexOf('Post a bond'), zt.body.indexOf('Post a bond') + 200)})`);
    ok(new RegExp(`Weights\\s*cBTC bond not counted from ${dShort(today + 1)}`).test(zt.terms) && !/cBTC has been minted against it/.test(zt.terms) && /a flat 500 points per wstETH for each further day it stays posted/.test(zt.terms),
      `ptsview: Terms says posting a bond is not counted, drops the rule that no longer matters, and states the daily credit (${zt.terms.slice(0, 400)})`);
    if (z.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + z.errors.slice(0, 3).join(' | ')); }
    await z.browser.close();
  }
  // Nobody connected: the pot and the board are public. A service without the day's board is told by its array: no Today switch.
  const n = await openPage({ account: A0, viewport: { width: 390, height: 900 } });
  const many = Array.from({ length: 12 }, (_, i) => ({ address: '0x' + (i + 1).toString(16).repeat(40).slice(0, 40), points: 1000 - i * 10 }));
  await n.ctx.route(/api\.tacit\.finance\/points\/0x/, (route) => json(route, { address: hex('0'), points: 0, deposit_count: 0, today: { points: 0, totalPoints: 500, dayBudgetWei: '1111111111111111111111' }, deposits: [] }));
  await n.ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, many));
  await n.page.goto(n.url + '#pts');
  await until(n.page, () => !!document.querySelector('#pts-body ol.lb'), null, 60000);
  await n.page.click('#pts-body .ptlog summary');
  await n.page.fill('#pl-q', '0x3333');
  await n.page.evaluate(() => document.querySelector('#pts-body .lbl:has(+ ol.lb)')?.scrollIntoView({ block: 'start' }));
  await shot(n.page, 'ptsview-phone');
  const f = await n.page.evaluate(() => ({ body: document.querySelector('#pts-body').textContent.replace(/\s+/g, ' '), gate: !!document.querySelector('#pts-connect'), toggle: !!document.querySelector('[data-plv]'),
    shown: [...document.querySelectorAll('#pl-all li')].filter((li) => !li.hidden).map((li) => li.dataset.a), top: document.querySelectorAll('#pts-body ol.lb:not(details ol) li').length }));
  ok(f.gate && f.top === 5 && !f.toggle && /Today’s pot\s*1,111 TAC/.test(f.body) && /12 taking part/.test(f.body), `ptsview: the pot and the top five show without a wallet, with no Today switch while the service lacks it (${f.body.slice(0, 300)})`);
  ok(f.shown.length === 1 && f.shown[0].startsWith('0x3333'), `ptsview: typing in the whole board narrows it to the matching address (${f.shown.join(',')})`);
  ok(!(await n.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'ptsview: no sideways scroll at phone width');
  if (n.errors.length) { fails++; console.log('FAIL ptsview page errors: ' + n.errors.slice(0, 3).join(' | ')); }
  await n.browser.close();
});

await step('retention', async () => {
  // The points sheet's Retention section: shown only while the points service has the holding reward on, with what this browser
  // sent for the account and a plain account of what the service learns; the button counts the reader's holdings only once they
  // press it, and until then nothing is fetched or sent for them. Nothing at all while the reward is off.
  const t0 = Math.floor(Date.now() / 1000), today = Math.floor(t0 / 86400);
  const log = JSON.stringify([
    { epoch: today - 1, chainId: 8453, tag: '1', bucketWei: '1000000000000000000', points: 1000, credited: true, status: 200, error: null, at: Date.now() },
    { epoch: today - 2, chainId: 1, tag: '2', bucketWei: '300000000000000000', points: 300, credited: true, status: 200, error: null, at: Date.now() - 864e5 },
    { epoch: today - 3, chainId: 1, tag: '3', bucketWei: '100000000000000000', points: 0, credited: false, status: 422, error: 'the proof does not verify', at: Date.now() - 2 * 864e5 },
    { epoch: today - 4, chainId: 1, tag: '4', points: 5 }]);                                       // a damaged row is skipped, not fatal
  const holdingBody = (on) => (on ? { enabled: true, rate: 1000, buckets: ['100000000000000000', 'x', '10000000000000000', '1000000000000000000'], assets: {}, epochs: [], vkSha256: 'ab'.repeat(32) } : { enabled: false });
  const open = async ({ on, key = null, consent = false }) => {
    const r = await openPage({ account: A0, key, init: { fn: (a) => { if (!localStorage.getItem(a.k)) localStorage.setItem(a.k, a.v); if (a.c) localStorage.setItem('tacit-holding-consent-v1', '1'); }, arg: { k: 'tacit-holding-log:' + A0.toLowerCase(), v: log, c: consent } } });
    await r.ctx.route(/api\.tacit\.finance\/points\/0x/, (route) => json(route, /\/days$/.test(route.request().url())
      ? { address: A0.toLowerCase(), startDay: today - 8, programDays: 90, today, lastSettledDay: today - 1, earnedWei: '0', days: [] }
      : { address: A0.toLowerCase(), points: 10, deposit_count: 0, today: { points: 0, totalPoints: 1000, dayBudgetWei: '1111111111111111111111' }, deposits: [] }));
    await r.ctx.route(/api\.tacit\.finance\/claim\/0x/, (route) => json(route, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null }));
    await r.ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, /day=today/.test(route.request().url())
      ? { day: today, programDay: 9, programDays: 90, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', taking: 1, rows: [{ address: A0.toLowerCase(), points: 10 }] }
      : [{ address: A0.toLowerCase(), points: 10 }]));
    const asked = [];
    await r.ctx.route(/tacit-points\.onrender\.com\//, (route) => { asked.push(new URL(route.request().url()).pathname + ' ' + route.request().method()); return json(route, /\/holding$/.test(route.request().url()) ? holdingBody(on) : {}); });
    if (key) {                                                      // the key is opened by signing in from the pool sheet, then the points sheet is opened in the same page
      await r.page.goto(r.url + '#device');
      if (await r.page.$('#eth-dev [data-in="eth"]')) await r.page.click('#eth-dev [data-in="eth"]');
      await r.page.waitForSelector('[data-dev="send"]', { timeout: 120000 });
      await r.page.evaluate(() => { location.hash = '#pts'; });
    } else {
      await r.page.goto(r.url + '#pts');
      await r.page.click('#pts-connect').catch(() => {});
    }
    await until(r.page, () => !!document.querySelector('#pts-body .pt'), null, 60000);
    return { r, asked };
  };
  const read = (r) => r.page.evaluate(() => ({ body: document.querySelector('#pts-body').textContent.replace(/\s+/g, ' '), btn: document.querySelector('#hold-now')?.textContent.trim() || null, off: !!document.querySelector('#hold-off'), rows: document.querySelectorAll('#pts-body .ptl li').length, wide: document.documentElement.scrollWidth > innerWidth }));

  // On, with only a wallet connected: what it is, what is shared, what was sent; no button, and a way to get one.
  { const { r } = await open({ on: true });
    await until(r.page, () => document.querySelectorAll('#pts-body .ptl li').length >= 3, null, 30000);
    const v = await read(r);
    await shot(r.page, 'retention');
    ok(/Retention/.test(v.body) && /1,000 points per ETH/.test(v.body) && /Sizes: 0\.01, 0\.1 or 1 ETH/.test(v.body), `retention: the section states the rate and the sizes in order, a malformed size dropped (${v.body.slice(0, 400)})`);
    ok(/learns which of your accounts holds how many private notes of which sizes each day/.test(v.body) && /31 MB/.test(v.body), 'retention: it says what the service learns and what is downloaded');
    ok(/1 ETH held\s*Base · \d+ \w+\s*\+1,000/.test(v.body) && /0\.3 ETH held\s*Ethereum · \d+ \w+\s*\+300/.test(v.body), 'retention: each day proven is listed with its chain, size and points');
    ok(/Not counted: the proof does not verify/.test(v.body) && !/NaN|undefined|null/.test(v.body.slice(v.body.indexOf('Retention'), v.body.indexOf('Retention') + 900)), 'retention: a refused proof says so, and a damaged row is skipped without a trace');
    ok(v.btn === null && /Open your Tacit key to count what it holds/.test(v.body), 'retention: with no Tacit key there is nothing to press, and it says why');
    ok(!v.wide, 'retention: no sideways scroll');
    if (r.errors.length) { fails++; console.log('FAIL retention page errors: ' + r.errors.slice(0, 3).join(' | ')); }
    await r.browser.close(); }

  // On, with a Tacit key: counting is the reader's choice, and nothing is sent for them until they make it.
  { const { r, asked } = await open({ on: true, key: K0 });
    await until(r.page, () => !!document.querySelector('#hold-now'), null, 30000).catch(async (e) => { console.log('     key page says: ' + (await read(r)).body.slice(0, 700) + ' | asked: ' + asked.join(', ')); throw e; });
    await new Promise((res) => setTimeout(res, 2500));
    const v = await read(r);
    ok(v.btn === 'Count my private ETH' && !v.off, `retention: before the reader agrees the button asks (${v.btn})`);
    ok(asked.every((x) => /^\/holding GET$/.test(x)), `retention: before that the page only reads the service's terms (${asked.join(', ')})`);
    await r.browser.close(); }
  { const { r } = await open({ on: true, key: K0, consent: true });
    await until(r.page, () => !!document.querySelector('#hold-now'), null, 30000);
    const v = await read(r);
    ok(v.btn === 'Prove what I hold now' && v.off && /does it by itself once a day/.test(v.body), `retention: once agreed it says it runs by itself, and can be turned off (${v.btn})`);
    await r.page.click('#hold-off');
    await until(r.page, () => document.querySelector('#hold-now')?.textContent.trim() === 'Count my private ETH', null, 15000);
    ok(true, 'retention: turning it off puts the question back');
    await r.browser.close(); }

  // Off: nothing.
  { const { r } = await open({ on: false });
    await new Promise((res) => setTimeout(res, 1500));
    const v = await read(r);
    ok(!/Retention/.test(v.body) && v.btn === null, 'retention: nothing is shown while the reward is off');
    await r.browser.close(); }
});
// Relayed jobs reach the page as tacit:job events; here they are dispatched the way the relay client dispatches them, and
// /confidential/status answers from `served`, so a reload can find settled a job that had failed. Notification records
// what would be shown instead of showing it.
const NOTIFY_STUB = () => {
  window.__notes = [];
  window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); }
    constructor(title, o = {}) { window.__notes.push({ title, body: o.body || '', tag: o.tag || '' }); } close() {} };
};
const hideTab = (p, on) => p.evaluate((h) => {
  for (const [k, v] of [['hidden', h], ['visibilityState', h ? 'hidden' : 'visible']]) Object.defineProperty(document, k, { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}, on);
const actRows = (p) => p.evaluate(() => [...document.querySelectorAll('#act-body .actr')].map((li) => ({ id: li.dataset.act, text: li.textContent.replace(/\s+/g, ' ').trim(),
  now: li.querySelector('.stp .now')?.textContent || '', bad: li.querySelector('.stp .bad')?.textContent || '', links: [...li.querySelectorAll('.actr-f a')].map((a) => a.href) })));
const openActivity = async (p) => { await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())); await p.click('#act'); await p.waitForSelector('#sheet-act[open]'); };
const serveStatus = (ctx, served) => ctx.route(/\/confidential\/status\?id=/, (route) => {
  const id = new URL(route.request().url()).searchParams.get('id'), b = served[id];
  return b ? json(route, { jobId: id, mode: 'settle', txHash: null, error: null, createdAt: Date.now(), ...b })
    : route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"unknown job"}' });
});
const pasteKey = async (p, hex) => {
  await p.evaluate(() => { location.hash = ''; location.hash = '#wallet'; });
  await p.click('#wallet-body [data-in="paste"]');
  await p.fill('#ws-hex', hex);
  await p.click('#wallet-body [data-in="key"]');
  await until(p, () => !!document.querySelector('#wallet-dot.on'));
};
await step('activity', async () => {
  const served = {}, H = (b) => '0x' + b.repeat(32);
  const r = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 900 }, init: { fn: NOTIFY_STUB } });
  await serveStatus(r.ctx, served);
  const fire = (d) => r.page.evaluate((x) => dispatchEvent(new CustomEvent('tacit:job', { detail: { txHash: null, error: null, at: Date.now(), ...x } })), d);
  const toastHas = (re) => until(r.page, (s) => new RegExp(s).test(document.querySelector('#toast-container')?.textContent || ''), re.source, 15000).then(() => true, () => false);
  const row = async (id) => (await actRows(r.page)).find((x) => x.id === id) || { text: '', links: [], now: '', bad: '' };
  let seed = null;
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#hx-body .hx-h');
    ok(await r.page.$eval('#act', (b) => b.hidden), 'activity: no Activity button before anything has happened');
    await fire({ jobId: 'j-wrap', type: 'wrap', status: 'pending' });
    await until(r.page, () => !document.querySelector('#act').hidden && document.querySelector('#act-n').textContent === '1', null, 15000);
    ok(await toastHas(/Make private: queued for the relay/), 'activity: a queued job shows in the header with a count, and is toasted');
    await openActivity(r.page);
    ok((await row('job:j-wrap')).now === 'Queued', `activity: its row is at Queued (${(await row('job:j-wrap')).text.slice(0, 50)})`);
    await fire({ jobId: 'j-wrap', type: 'wrap', status: 'proving' });
    await until(r.page, () => document.querySelector('[data-act="job:j-wrap"] .stp .now')?.textContent === 'Proving', null, 15000);
    ok(true, 'activity: then at Proving');
    await fire({ jobId: 'j-wrap', type: 'wrap', status: 'settled', txHash: H('a1') });
    await until(r.page, () => /Done in/.test(document.querySelector('[data-act="job:j-wrap"]')?.textContent || ''), null, 15000);
    const done = await row('job:j-wrap');
    ok(done.links.includes(`https://etherscan.io/tx/${H('a1')}`) && await r.page.$eval('#act-n', (n) => n.hidden), `activity: done, linked to its transaction, nothing left in flight (${done.text.slice(0, 60)})`);
    ok(await toastHas(/Make private: done\./), 'activity: done is toasted');
    // A failure reads as the relay wrote it, with the transaction it names linked.
    await fire({ jobId: 'j-send', type: 'stealthlock', status: 'pending' });
    await fire({ jobId: 'j-send', type: 'stealthlock', status: 'failed', error: `this note was already spent in ${H('b2')}; if that was this same request, it went through` });
    await until(r.page, () => document.querySelector('[data-act="job:j-send"] .stp .bad')?.textContent === 'Failed', null, 15000);
    const failed = await row('job:j-send');
    ok(/This note was already spent in 0xb2b2/.test(failed.text) && failed.links.includes(`https://etherscan.io/tx/${H('b2')}`), `activity: a failure reads as the relay wrote it (${failed.text.slice(0, 80)})`);
    ok(await toastHas(/Send privately did not go through: This note was already spent/), 'activity: the failure is toasted with its reason');
    ok(!/Nothing was spent/.test(failed.text) && !(await r.page.$('[data-act="job:j-send"] [data-act-again]')), 'activity: a failure whose note was spent is not called safe, and offers no Try again');
    // A relay failure before the chain (here the deadline passed while it waited): its words, that nothing was spent, and a way to do it again.
    await fire({ jobId: 'j-exp', type: 'unwrap', status: 'failed', error: 'settle reverted: Execution reverted for an unknown reason. (0x203d82d8)' });
    await until(r.page, () => document.querySelector('[data-act="job:j-exp"] .stp .bad')?.textContent === 'Failed', null, 15000);
    const exp = await row('job:j-exp');
    ok(/Its deadline passed before it landed/.test(exp.text) && /Nothing was spent/.test(exp.text) && !!(await r.page.$('[data-act="job:j-exp"] [data-act-again]')),
      `activity: a job that failed before the chain says nothing was spent and offers to do it again (${exp.text.slice(0, 160)})`);
    await fire({ jobId: 'j-exp2', type: 'unwrap', status: 'failed', error: 'expired: it waited in the queue past its deadline, so it was not sent and nothing was spent; send it again' });
    await until(r.page, () => document.querySelector('[data-act="job:j-exp2"] .stp .bad')?.textContent === 'Failed', null, 15000);
    const exp2 = await row('job:j-exp2');
    ok(/waited in the relay’s queue past its deadline/.test(exp2.text) && /Nothing was spent/.test(exp2.text) && (exp2.text.match(/Nothing was spent/g) || []).length === 1, `activity: an expired job says so once, in words (${exp2.text.slice(0, 160)})`);
    await r.page.click('[data-act="job:j-exp"] [data-act-again]');
    await until(r.page, () => !document.querySelector('[data-act="job:j-exp"] [data-act-again]')?.disabled, null, 30000).catch(() => {});
    ok(true, 'activity: Try again reads the balance again without an error');
    // A system notification only while the tab is out of sight.
    await r.page.click('#act-notify');
    await until(r.page, () => localStorage.getItem('tacit-lite-notify-v1') === 'true', null, 15000);
    const n0 = await r.page.evaluate(() => window.__notes.length);
    await fire({ jobId: 'j-seen', type: 'transfer', status: 'pending' });
    await fire({ jobId: 'j-seen', type: 'transfer', status: 'settled', txHash: H('c3') });
    await sleep(500);
    const n1 = await r.page.evaluate(() => window.__notes.length);
    await hideTab(r.page, true);
    await fire({ jobId: 'j-away', type: 'unwrap', status: 'pending' });
    await fire({ jobId: 'j-away', type: 'unwrap', status: 'settled', txHash: H('d4') });
    await sleep(500);
    const notes = await r.page.evaluate(() => window.__notes);
    await hideTab(r.page, false);
    ok(n1 === n0 && notes.length === n0 + 1 && notes.at(-1).title === 'Withdraw' && /Done/.test(notes.at(-1).body),
      `activity: a system notification goes out only while the tab is hidden (${n0} → ${n1} → ${notes.length}: ${notes.at(-1)?.title} · ${notes.at(-1)?.body})`);
    // A transaction the page sends is followed to its receipt: ETH from the connected wallet to a pasted key's Tacit account.
    await pasteKey(r.page, 'ac71'.padEnd(64, '6'));
    await toWallet(r.page);
    await r.page.waitForSelector('[data-pay="wallet"]');
    await r.page.click('[data-pay="wallet"]');
    await until(r.page, () => document.querySelector('[data-pay="wallet"]')?.classList.contains('main'));
    await r.page.waitForSelector('#ac-go');
    await r.page.fill('#ac-mv', '0.001');
    await r.page.click('#ac-go');
    await until(r.page, () => /Added\.|err/.test(document.querySelector('#ac-status')?.innerHTML || ''), null, 120000);
    await openActivity(r.page);
    await until(r.page, () => [...document.querySelectorAll('#act-body .actr')].some((li) => /Add 0\.001 ETH/.test(li.textContent) && /Confirmed in/.test(li.textContent)), null, 60000).catch(() => {});
    const add = (await actRows(r.page)).find((x) => /Add 0\.001 ETH/.test(x.text)) || { text: '', links: [] };
    ok(/Confirmed in/.test(add.text) && add.links.some((l) => /^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/.test(l)), `activity: a transaction sent from the page is followed to its receipt (${add.text.slice(0, 70)})`);
    // Before a reload: a job left proving, one failed within six hours (above), and one that failed longer ago.
    await fire({ jobId: 'j-mint', type: 'cbtcmint', status: 'pending' });
    await fire({ jobId: 'j-mint', type: 'cbtcmint', status: 'proving' });
    await sleep(600);                                                         // the list is written shortly after each change
    seed = await r.page.evaluate(() => localStorage.getItem('tacit-lite-activity-v1'));
    await r.page.evaluate(() => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k)), t = Date.now();
      s.items.push({ id: 'job:j-old', kind: 'job', type: 'unwrap', label: 'Withdraw', status: 'failed', err: 'settle reverted: stale root', at: t - 8 * 3600e3, up: t - 7 * 3600e3, end: t - 7 * 3600e3 });
      localStorage.setItem(k, JSON.stringify(s));
    });
    Object.assign(served, { 'j-send': { type: 'stealthlock', status: 'settled', txHash: H('e5') }, 'j-mint': { type: 'cbtcmint', status: 'settled', txHash: H('f6') }, 'j-old': { type: 'unwrap', status: 'settled', txHash: H('a7') } });
    await r.page.reload();
    await r.page.waitForSelector('#hx-body .hx-h');
    ok(await toastHas(/Send privately went through after all/), 'activity: after a reload, a job that failed in the last six hours is asked about again, and found settled');
    await openActivity(r.page);
    await until(r.page, () => /Done in/.test(document.querySelector('[data-act="job:j-mint"]')?.textContent || ''), null, 30000).catch(() => {});
    const [send2, mint2, old2] = [await row('job:j-send'), await row('job:j-mint'), await row('job:j-old')];
    ok(send2.bad === '' && /Went through after all/.test(send2.text) && send2.links.includes(`https://etherscan.io/tx/${H('e5')}`), `activity: it now reads done, with the settle's transaction (${send2.text.slice(0, 70)})`);
    ok(/Done in/.test(mint2.text) && mint2.links.includes(`https://etherscan.io/tx/${H('f6')}`), `activity: a job still proving at the reload is followed until it settles (${mint2.text.slice(0, 60)})`);
    ok(old2.bad === 'Failed', `activity: a failure older than six hours is left as it was (${old2.text.slice(0, 40)})`);
    ok((await actRows(r.page)).some((x) => /Add 0\.001 ETH/.test(x.text) && /Confirmed/.test(x.text)), 'activity: the list, and each outcome, survives the reload');
    await shot(r.page, 'activity-phone');
    // A job still in line after a minute says it keeps its place. The relay's heartbeat says why it is holding settles;
    // the page does not repeat that, and a job it cannot finish itself (a transfer) offers nothing more.
    await r.ctx.route(/\/confidential\/relay$/, (route) => json(route, { state: 'held', proving: true, settling: false, board: false, ageSeconds: 20 }));
    await r.ctx.route(/\/prover-health\?/, (route) => json(route, { services: { settle: { healthy: true, age_seconds: 20,
      note: 'settle: settle wallet holds 0.0010 ETH, under the 0.0031 ETH a settle can cost at today’s gas — proving only jobs a page settles itself; the rest wait until it is topped up' } } }));
    served['j-wait'] = { type: 'transfer', status: 'pending' };
    await sleep(600);
    await r.page.evaluate(() => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k)), t = Date.now();
      s.items.unshift({ id: 'job:j-wait', kind: 'job', type: 'transfer', label: 'Private transfer', status: 'pending', at: t - 90e3, up: t - 90e3 });
      localStorage.setItem(k, JSON.stringify(s));
    });
    await r.page.reload();
    await r.page.waitForSelector('#hx-body .hx-h');
    await openActivity(r.page);
    const waitOk = await until(r.page, () => /In line\. It keeps its place/.test(document.querySelector('[data-act="job:j-wait"]')?.textContent || ''), null, 20000).then(() => true, () => false);
    const wait = await row('job:j-wait');
    ok(waitOk && wait.now === 'Queued' && !/gas|top/i.test(wait.text) && !/from your/.test(wait.text), `activity: a job in line past a minute says it keeps its place, and nothing about the relay's wallet (${wait.text.slice(0, 110)})`);
    served['j-wait'] = { type: 'transfer', status: 'settled', txHash: H('b8') };
    await until(r.page, () => /Done in/.test(document.querySelector('[data-act="job:j-wait"]')?.textContent || ''), null, 30000).catch(() => {});
    ok(/Done in/.test((await row('job:j-wait')).text), 'activity: and it reads done once the relay settles it');
    // A request that expires says by when and does not promise it goes through on its own; a failed card made before entries kept
    // their sheet is still sent back to the one its label names.
    served['j-by'] = { type: 'unwrap', status: 'pending' };
    served['j-leg'] = { type: 'unwrap', status: 'failed', error: 'settle reverted: Execution reverted for an unknown reason.' };
    await sleep(600);
    await r.page.evaluate(() => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k)), t = Date.now();
      s.items.unshift({ id: 'job:j-by', kind: 'job', type: 'unwrap', label: 'Make 1,000 TAC public', status: 'pending', at: t - 90e3, up: t - 90e3, by: t + 40 * 60e3 });
      s.items.unshift({ id: 'job:j-leg', kind: 'job', type: 'unwrap', label: 'Make 1,000 TAC public', status: 'failed', err: 'settle reverted: Execution reverted for an unknown reason.', at: t - 3 * 3600e3, up: t - 2 * 3600e3, end: t - 2 * 3600e3 });
      localStorage.setItem(k, JSON.stringify(s));
    });
    await r.page.reload();
    await r.page.waitForSelector('#hx-body .hx-h');
    await openActivity(r.page);
    const byOk = await until(r.page, () => /It has until \d{1,2}:\d{2}/.test(document.querySelector('[data-act="job:j-by"]')?.textContent || ''), null, 20000).then(() => true, () => false);
    const by = await row('job:j-by');
    ok(byOk && /In line\./.test(by.text) && /nothing is spent/.test(by.text) && !/goes through on its own|keeps its place/.test(by.text) && !/gas|top/i.test(by.text),
      `activity: an unwrap in line says by when it expires, that nothing is spent, and does not promise it goes through on its own (${by.text.slice(0, 190)})`);
    const leg = await r.page.$eval('[data-act="job:j-leg"] [data-act-again]', (b) => [b.dataset.actAgain, b.textContent.trim()]).catch(() => null);
    ok(!!leg && leg[0] === 'tac' && leg[1] === 'Try again', `activity: a failed Make public made before entries kept their sheet offers Try again on the TAC sheet (${JSON.stringify(leg)})`);
    // The list is this browser's: with another key open, an entry the first key made says so; one made with no key does not.
    // A pasted key is not kept across the reloads above, so a key is locked first only if one is open.
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#wallet'; });
    await r.page.waitForSelector('#w-lock, #wallet-body [data-in="paste"]');
    if (await r.page.$('#w-lock')) { await r.page.click('#w-lock'); await until(r.page, () => !document.querySelector('#wallet-dot.on')); }
    await pasteKey(r.page, 'bd82'.padEnd(64, '7'));
    await openActivity(r.page);
    ok(/Made with another Tacit key/.test((await row('job:j-mint')).text) && !/another Tacit key/.test((await row('job:j-old')).text),
      `activity: an entry another key made says so (${(await row('job:j-mint')).text.slice(-60)})`);
    // At most twenty entries are kept, newest first.
    for (let i = 0; i < 22; i++) await fire({ jobId: `j-n${i}`, type: 'transfer', status: 'settled', txHash: H('ab') });
    await sleep(600);
    const kept = await r.page.evaluate(() => JSON.parse(localStorage.getItem('tacit-lite-activity-v1')).items.map((x) => x.id));
    ok(kept.length === 20 && kept[0] === 'job:j-n21', `activity: the list keeps the newest twenty (${kept.length}, newest ${kept[0]})`);
    if (r.errors.length) { fails++; console.log('FAIL activity page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
  // The same list in the other widths and schemes, with one job still proving.
  if (SHOTS && seed) {
    const live = JSON.parse(seed);
    live.items.unshift({ id: 'job:j-live', kind: 'job', type: 'sendunwrap', label: 'Withdraw 0.05 ETH', status: 'proving', prov: true, at: Date.now() - 42e3, up: Date.now() - 20e3 });
    for (const [tag, viewport, colorScheme] of [['phone-dark', { width: 390, height: 900 }, 'dark'], ['desk', { width: 1280, height: 900 }, 'light'], ['desk-dark', { width: 1280, height: 900 }, 'dark']]) {
      const v = await openPage({ account: A0, key: K0, viewport, colorScheme, init: { fn: (s) => localStorage.setItem('tacit-lite-activity-v1', s), arg: JSON.stringify(live) } });
      await serveStatus(v.ctx, { 'j-live': { status: 'proving' }, 'j-mint': { status: 'settled', txHash: H('f6') } });
      await v.page.goto(v.url);
      await v.page.waitForSelector('#hx-body .hx-h');
      await shot(v.page, `activity-home-${tag}`);
      await openActivity(v.page);
      await sleep(800);
      await shot(v.page, `activity-${tag}`);
      await v.browser.close();
    }
  }
});

// Two relayed actions at once, each its own receipt. The page's pool module is the real one, with three cETH notes added
// to what the key's scan finds and its relayed calls stood in for: each names its job to the caller (as the relay
// client does), announces it, and waits for the test to let the relay finish it. A send needing a split goes back to
// the relay on its own, a withdrawal starts meanwhile on another note, and neither reaches for the other's notes.
await step('receipts', async () => {
  const served = {};
  const r = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 900 } });
  await serveStatus(r.ctx, served);
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const ETH = String(ux.assetByTicker.cETH.assetId).toLowerCase();
      let seq = 0;
      const note = (value) => { const i = ++seq; return { asset: ETH, value: String(value), leaf: '0x' + (0xabc000 + i).toString(16).padStart(64, '0'), leafIndex: 800000 + i, cx: '0x' + String(i).padStart(64, '0'), cy: '0x01', owner: '0x02', root: '0x' + '1'.padStart(64, '0'), path: [] }; };
      const TAC = String(ux.assetByTicker.cTAC.assetId).toLowerCase(), tacNote = (value) => ({ ...note(value), asset: TAC });
      const S = window.__rx = { notes: [note(30000000n), note(20000000n), note(5000000n), tacNote(500000000n), tacNote(300000000n)], calls: [], gates: {}, spent: new Set() };
      ux.balance = async (priv) => {
        const b = await balance(priv), add = S.notes.filter((n) => !S.spent.has(n.leaf));
        b.notes = [...b.notes, ...add];
        for (const n of add) {
          const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] };
          g.notes = [...(g.notes || []), n]; g.value = g.notes.reduce((a, x) => a + BigInt(x.value), 0n);
        }
        return b;
      };
      ux.quoteOpFee = async () => '100000';
      const fire = (d) => dispatchEvent(new CustomEvent('tacit:job', { detail: { txHash: null, error: null, at: Date.now(), ...d } }));
      const job = async (type, waitOpts, spend, make) => {
        const jobId = 'rx-' + type + '-' + (spend[0]?.leaf || '').slice(-6);
        S.calls.push({ jobId, type, spend: spend.map((n) => n.leaf) });
        waitOpts?.onJob?.(jobId, type);
        fire({ jobId, type, status: 'pending' });
        const out = await new Promise((res) => { S.gates[jobId] = res; });
        if (out === 'fail') { fire({ jobId, type, status: 'failed', error: 'the pool refused it in this check' }); throw new Error('settle failed: the pool refused it in this check'); }
        fire({ jobId, type, status: 'proving' });
        for (const n of spend) S.spent.add(n.leaf);
        for (const v of make) S.notes.push(note(v));
        const txHash = '0x' + String(S.calls.length).padStart(64, 'e');
        fire({ jobId, type, status: 'settled', txHash });
        return { jobId, status: 'settled', txHash };
      };
      ux.transfer = ({ notes, amount, fee, waitOpts }) => job('transfer', waitOpts, notes, [BigInt(amount), notes.reduce((a, n) => a + BigInt(n.value), 0n) - BigInt(amount) - BigInt(fee)].filter((v) => v > 0n));
      ux.stealthSend = async ({ notes, amount, waitOpts }) => {
        if (notes.length !== 1 || BigInt(notes[0].value) !== BigInt(amount)) throw new Error('stealthSend in this check takes one note of the exact amount');
        return { ...(await job('stealthlock', waitOpts, notes, [])), memoCheck: { ok: true } };
      };
      ux.sendUnwrap = async ({ note: n, amount, waitOpts }) => job('sendunwrap', waitOpts, [n], [BigInt(n.value) - BigInt(amount)].filter((v) => v > 0n));
      ux.unwrap = async ({ note: n, waitOpts }) => job('unwrap', waitOpts, [n], []);
      return ux;
    }` }));
  const rx = () => r.page.evaluate(() => ({ calls: window.__rx?.calls || [], notes: (window.__rx?.notes || []).map((n) => [n.leaf, n.value]) }));
  const open = (id, out = 'ok') => r.page.evaluate(([i, o]) => window.__rx.gates[i](o), [id, out]);
  const toastHas = (re, ms = 20000) => until(r.page, (s) => new RegExp(s).test(document.querySelector('#toast-container')?.textContent || ''), re.source, ms).then(() => true, () => false);
  const row = async (re) => (await actRows(r.page)).find((x) => re.test(x.text)) || { text: '', links: [], now: '', bad: '', id: '' };
  const sub = async (m) => { await r.page.click(`[data-v1="${m}"]`); await until(r.page, (x) => document.querySelector(`[data-v1="${x}"]`)?.getAttribute('aria-selected') === 'true', m); };
  const toV1 = async () => { await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())); await r.page.evaluate(() => { location.hash = ''; location.hash = '#private'; }); await r.page.waitForSelector('#sheet-eth[open]'); };
  const REC = tacit1('d1'.padEnd(64, '7'));
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#hx-body .hx-h');
    await pasteKey(r.page, 'e1'.padEnd(64, '5'));
    await toV1();
    await sub('send');
    await until(r.page, () => /Private 0\.55 tETH/.test(document.querySelector('#s-max')?.textContent || ''), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | form: ${(await text(r.page, '#v1-form')).replace(/\s+/g, ' ').slice(0, 200)} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(true, 'receipts: three private notes, 0.55 tETH, to spend');

    // A: 0.1 privately. No note is exactly that, so the relay first splits the 0.2 note; the sheet is handed back then.
    await r.page.fill('#s-to', REC);
    await r.page.fill('#s-amt', '0.1');
    await until(r.page, () => /They get about/.test(document.querySelector('#s-rcpt')?.textContent || '') && !document.querySelector('#s-go').disabled, null, 60000);
    await r.page.click('#s-go');
    await until(r.page, () => /Sent to the relay/.test(document.querySelector('#v1-status')?.textContent || ''), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    const a0 = await rx();
    ok(a0.calls.length === 1 && a0.calls[0].type === 'transfer' && a0.calls[0].spend[0] === a0.notes[1][0], `receipts: the send splits the 0.2 note first (${JSON.stringify(a0.calls)})`);
    ok(await r.page.$eval('#s-amt', (i) => i.value === '') && await r.page.$eval('#s-go', (b) => b.disabled), 'receipts: the sheet comes back with an empty form as soon as the relay has the split');
    ok(/Private 0\.35 tETH · 0\.2 tETH in use/.test(await text(r.page, '#s-max')), `receipts: the note it spends is shown as in use (${await text(r.page, '#s-max')})`);
    await openActivity(r.page);
    const opA = await row(/Send 0\.1 tETH privately/);
    ok(opA.id.startsWith('op:') && /Split a note/.test(opA.text) && opA.now === 'Split a note', `receipts: one receipt for the send, at its split step (${opA.text.slice(0, 120)})`);
    ok((await actRows(r.page)).length === 1, 'receipts: the split is a step of the send, not a receipt of its own');

    // B, meanwhile: withdraw 0.25. The 0.3 note covers it without a split; it is not the note the send is splitting.
    await toV1();
    await sub('out');
    await r.page.fill('#o-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#o-amt', '0.25');
    await until(r.page, () => /Arrives/.test(document.querySelector('#o-rcpt')?.textContent || '') && !document.querySelector('#o-go').disabled, null, 60000);
    await r.page.click('#o-go');
    await until(r.page, () => /Withdraw 0\.25 ETH[^]*with the relay/.test(document.querySelector('#v1-status')?.textContent || ''), null, 60000);
    const b0 = await rx();
    ok(b0.calls.length === 2 && b0.calls[1].type === 'sendunwrap' && b0.calls[1].spend[0] === b0.notes[0][0], `receipts: the withdrawal starts at once, on the 0.3 note (${JSON.stringify(b0.calls[1])})`);
    // C: what is left free (0.05) cannot cover 0.1, and the form says so.
    await r.page.fill('#o-amt', '0.1');
    await until(r.page, () => /More than your private balance/.test(document.querySelector('#o-rcpt')?.textContent || ''), null, 30000);
    ok(await r.page.$eval('#o-go', (b) => b.disabled) && /Private 0\.05 tETH · 0\.5 tETH in use/.test(await text(r.page, '#o-max')), `receipts: notes two actions are spending are not offered to a third (${await text(r.page, '#o-max')})`);

    // The withdrawal has now been in line for a while (the offer comes after 90 seconds): the dashboard offers it from the
    // Tacit account, in plain words that say nothing of the relay's wallet, and so does its receipt in Activity.
    const nudged = await until(r.page, () => /Withdraw 0\.25 ETH to .* has been in line for a few minutes\. You can send it now from your Tacit account, with no relay fee\./.test(document.querySelector('#dash-due')?.textContent || ''), null, 150000).then(() => true, () => false);
    ok(nudged, `receipts: a withdrawal in line a few minutes is offered from the Tacit account on the dashboard (${(await text(r.page, '#dash-due')).replace(/\s+/g, ' ').slice(0, 140)})`);
    await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); });
    await r.page.click('#act'); await r.page.waitForSelector('#sheet-act[open]');
    const offer = await until(r.page, () => /Send it from your Tacit account\s+instead/.test(document.querySelector('#act-body')?.textContent || ''), null, 30000).then(() => true, () => false);
    ok(offer && !/gas|top/i.test((await text(r.page, '#act-body')).replace(/network fee|no relay fee|pays the network/gi, '')), 'receipts: and so is its receipt in Activity, with no word about the relay running short');
    await r.page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); });
    await r.page.evaluate(() => { location.hash = '#private'; });

    // The split settles: the send takes the new 0.1 note and queues its lock, with no one pressing anything.
    await open(a0.calls[0].jobId);
    await until(r.page, () => (window.__rx?.calls || []).length === 3, null, 90000).catch(() => {});
    const a1 = await rx(), made = a1.notes.find(([, v]) => v === '10000000');
    ok(a1.calls[2]?.type === 'stealthlock' && made && a1.calls[2].spend[0] === made[0], `receipts: after the split, the send locks the new 0.1 note on its own (${JSON.stringify(a1.calls[2] || null)})`);
    await openActivity(r.page);
    await until(r.page, () => /Queued/.test([...document.querySelectorAll('#act-body .actr')].find((li) => /Send 0\.1/.test(li.textContent))?.querySelector('.stp .now')?.textContent || ''), null, 30000).catch(() => {});
    const opA2 = await row(/Send 0\.1 tETH privately/);
    ok(opA2.now === 'Queued' && /Split a note/.test(opA2.text), `receipts: its receipt shows the split done and the send queued (${opA2.text.slice(0, 120)})`);

    // Outcomes: the send settles (toasted, one receipt, linked); the withdrawal fails (toasted with its reason).
    await open(a1.calls[2].jobId);
    ok(await toastHas(/Send 0\.1 tETH privately to [^:]+: done/), 'receipts: the send is toasted done');
    await open(b0.calls[1].jobId, 'fail');
    ok(await toastHas(/Withdraw 0\.25 ETH[^]*did not go through/), 'receipts: the failed withdrawal is toasted with its reason');
    await openActivity(r.page);
    await sleep(500);
    const [sA, sB] = [await row(/Send 0\.1 tETH privately/), await row(/Withdraw 0\.25 ETH/)];
    ok(/Done in/.test(sA.text) && sA.links.some((l) => /etherscan\.io\/tx\/0x0*3e/.test(l) || /etherscan\.io\/tx\//.test(l)), `receipts: the send's receipt reads done, with its transaction (${sA.text.slice(0, 90)})`);
    ok(sB.bad === 'Failed' && /refused it in this check/.test(sB.text), `receipts: the withdrawal's receipt reads failed, with the relay's reason (${sB.text.slice(0, 90)})`);
    // The failed withdrawal's note is free again once a scan shows it unspent.
    await toV1();
    await sub('out');
    await until(r.page, () => /Private 0\.(4|3)\d* tETH/.test(document.querySelector('#o-max')?.textContent || '') && !/in use/.test(document.querySelector('#o-max')?.textContent || ''), null, 60000).catch(() => {});
    ok(!/in use/.test(await text(r.page, '#o-max')), `receipts: nothing is held once both are over (${await text(r.page, '#o-max')})`);

    // D: a send of the 0.05 note exactly, and the page reloaded while the relay still has it: its receipt carries on.
    await sub('send');
    await r.page.fill('#s-to', REC);
    await r.page.fill('#s-amt', '0.05');
    await until(r.page, () => /They get about/.test(document.querySelector('#s-rcpt')?.textContent || '') && !document.querySelector('#s-go').disabled, null, 60000);
    await r.page.click('#s-go');
    await until(r.page, () => (window.__rx?.calls || []).length === 4, null, 60000);
    const d0 = await rx();
    ok(d0.calls[3].type === 'stealthlock', 'receipts: a note of the exact amount is locked with no split');
    await sleep(600);
    served[d0.calls[3].jobId] = { type: 'stealthlock', status: 'proving' };
    await r.page.reload();
    await r.page.waitForSelector('#hx-body .hx-h');
    await openActivity(r.page);
    const dRow = await row(/Send 0\.05 tETH privately/);
    ok(dRow.id.startsWith('op:') && !/Done/.test(dRow.bad) && ['Queued', 'Proving'].includes(dRow.now), `receipts: after a reload the receipt is still there, in progress (${dRow.text.slice(0, 90)})`);
    served[d0.calls[3].jobId] = { type: 'stealthlock', status: 'settled', txHash: '0x' + 'd'.repeat(64) };
    await until(r.page, () => /Done in/.test([...document.querySelectorAll('#act-body .actr')].find((li) => /Send 0\.05/.test(li.textContent))?.textContent || ''), null, 60000).catch(() => {});
    ok(/Done in/.test((await row(/Send 0\.05 tETH privately/)).text), 'receipts: and it reads done once the relay settles it');
    await shot(r.page, 'receipts-phone');

    // E: private TAC made public, one relayed unwrap per note, each its own receipt. Both notes are taken when pressed,
    // so the offer goes away at once, and the second is queued after the first settles, with nothing pressed.
    await pasteKey(r.page, 'e1'.padEnd(64, '5'));                             // a pasted key does not outlive a reload
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-pub', { timeout: 240000 });
    ok(/8(\.0+)? TAC is in private notes/.test(await text(r.page, '#tac-bal')), `receipts: 8 private TAC is offered to make public (${(await text(r.page, '#tac-bal')).replace(/\s+/g, ' ').slice(-120)})`);
    const before = (await rx()).calls.length;
    await r.page.click('#tac-pub');
    await until(r.page, () => /each goes on by itself/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#tac-bal-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    const e0 = await rx(), first = e0.calls.at(-1);
    ok(e0.calls.length === before + 1 && first.type === 'unwrap' && !(await r.page.$('#tac-pub')), 'receipts: the first unwrap is queued, the sheet is handed back, and the notes are no longer offered');
    // The first fails; the second still goes to the relay on its own.
    await open(first.jobId, 'fail');
    ok(await toastHas(/Make 5 TAC public did not go through/), 'receipts: the failed unwrap is toasted');
    await until(r.page, (n) => (window.__rx?.calls || []).length === n, before + 2, 60000).catch(() => {});
    const e1 = await rx(), second = e1.calls.at(-1);
    ok(e1.calls.length === before + 2 && second.type === 'unwrap' && second.spend[0] !== first.spend[0], 'receipts: the second note goes to the relay on its own after the first failed');
    await open(second.jobId);
    // The failed note is offered again once a scan shows it unspent; sent again, it is the same job, a new attempt.
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await until(r.page, () => /5(\.0+)? TAC is in private notes/.test(document.querySelector('#tac-bal')?.textContent || ''), null, 60000).catch(() => {});
    ok(/5(\.0+)? TAC is in private notes/.test(await text(r.page, '#tac-bal')), `receipts: the note whose unwrap failed is offered again (${(await text(r.page, '#tac-bal')).replace(/\s+/g, ' ').slice(-110)})`);
    await r.page.click('#tac-pub');
    await until(r.page, (n) => (window.__rx?.calls || []).length === n, before + 3, 60000).catch(() => {});
    const e2 = await rx(), again = e2.calls.at(-1);
    ok(again?.jobId === first.jobId, `receipts: sent again, it is the same job at the relay (${again?.jobId} = ${first.jobId})`);
    await open(again.jobId);
    ok(await toastHas(/Make 5 TAC public: done/), 'receipts: the new attempt is toasted done');
    await openActivity(r.page);
    await sleep(500);
    const outs = (await actRows(r.page)).filter((x) => /Make \d TAC public/.test(x.text));
    const five = outs.filter((x) => /Make 5 TAC public/.test(x.text));
    ok(outs.length === 3 && five.some((x) => x.bad === 'Failed') && five.some((x) => /Done in/.test(x.text)) && outs.some((x) => /Make 3 TAC public/.test(x.text) && /Done in/.test(x.text)),
      `receipts: each attempt keeps its own receipt: the failed one, the retry done, the other note done (${outs.map((x) => x.text.slice(0, 36)).join(' | ')})`);
    if (r.errors.length) { fails++; console.log('FAIL receipts page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The stats page reads the chains, two explorers and the relay's status. Logs and the explorers' transaction lists answer
// here from fixtures (a known set of deposits, settles, attestations, bonds, loans, claims and device-pool moves); the
// contract reads come from the fork. Every figure the fixtures decide is checked, then how little each later visit asks:
// nothing within a quarter hour, only what is new on a fresh read, and nothing at all when the API has a shared reading.
await step('stats', async () => {
  const lc = (x) => String(x || '').toLowerCase();
  const w = (v) => (BigInt(v) < 0n ? (1n << 256n) + BigInt(v) : BigInt(v)).toString(16).padStart(64, '0');
  const h = (n) => '0x' + n.toString(16);
  const T = Math.floor(Date.now() / 1000) - 3 * 86400;
  const TOPIC = {
    wrap: '0xf5d1711d21af6f42622ab6237626933cefc42cc9f0663d81b7c4c7bc5ce99e44', leaves: '0x7783fb256f5b4e1d4d8b79583488756286326ae15d9997d4098ce5432ed2708b',
    spent: '0x576d91547505afce99e7ebe2baf1a0948b5915598105a55f40ba72fea86e875e', asset: '0x2dcb7e1d588ab99cccaa0e9a2f69798e1e9ca87a30856228f895c2f6b34a905b',
    posted: '0x0c008a699968f2a24063b7eb14d9239b2430c502fda280245345c78cbc47b7c1', cdpMinted: '0x232c7d098ca44092999087e6ee530a2171f95f9ecb1caa363f6dcf448fb7dd57',
    cdpClosed: '0xc0ede5b75ee32986e50a2a39fa32dbf5e8eff1c91a46cd127591edebd91b4db9', claimed: '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026',
    transact: '0xdf0ed29e998ac2f2ff0f0516cb9c1b95af189e00d55af3764b95bdd2a835e53a', transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  };
  const TACTOKEN = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
  const POOLA = '0x000000000ed1eabd231be41d93b719056f7febfc', ENGINE = '0x000000003f608bddf0ca45934003ffb9dbdf70db', AIR = '0x4b4cb98d0c836c2783ac46f0078b904dab533ae8';
  const EVMP = '0x000000c2a20657ce25f2ba99737933d031afbee9', TIP = '0x000000d218b03db5837943b0b05dea2965ae956e', ROUTER = '0x000000005da3e3b73726af3c774deeb9472d4992';
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TACID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', USDC = '0x' + 'c5'.repeat(32), USDT = '0x' + 'c6'.repeat(32);
  const tx = (c) => '0x' + c.repeat(64 / c.length);
  let li = 0;
  const log = (address, topics, data, txh, t, block = 26000000 + li) => ({ address, topics, data: '0x' + data, blockNumber: h(block), timeStamp: h(t), blockTimestamp: h(t), transactionHash: txh, logIndex: h(li++) });
  const str = (s) => { const b = Buffer.from(s); return w(b.length) + b.toString('hex').padEnd(64, '0'); };
  // Real locks, read from the fork's pool and engine: one since unlocked on Bitcoin, one still locked (both minted on), and
  // one bonded in the fixtures only, which the pool never recorded.
  const OUTPOINTS = ['0x552c481efffbf72bf5b510bdf4ba49a0f2b41490e1b6cd5c8ac404ca6739eb74', '0xd43d367f46953e71789582054fb46e22ae428008b544eeadc11eebe10db6d7f1', '0x' + 'b1'.repeat(32)];
  const W1 = '0x' + '1a'.repeat(20), W2 = '0x' + '2b'.repeat(20), CL1 = '0x' + '3c'.repeat(20), CL2 = '0x' + '4d'.repeat(20);
  const poolLogs = [
    log(POOLA, [TOPIC.asset, USDC, '0x' + '00'.repeat(12) + 'a0'.repeat(20)], w(1) + w(0x80) + w(0xc0) + w(6) + str('USD Coin') + str('USDC'), tx('e0'), T),
    log(POOLA, [TOPIC.wrap, tx('d1'), CETH], w(10n ** 18n), tx('a1'), T),
    log(POOLA, [TOPIC.wrap, tx('d2'), CETH], w(5n * 10n ** 17n), tx('a2'), T + 86400),
    log(POOLA, [TOPIC.wrap, tx('d3'), TACID], w(100n * 10n ** 18n), tx('a3'), T + 86400),
    log(POOLA, [TOPIC.wrap, tx('d4'), USDC], w(2500000), tx('a4'), T + 86400),
    // Registered with no symbol: the page names it from its token (the real USDT contract on the fork).
    log(POOLA, [TOPIC.asset, USDT, '0x' + '00'.repeat(12) + 'dac17f958d2ee523a2206206994597c13d831ec7'], w(1) + w(0x80) + w(0xc0) + w(6) + str('Tether') + str(''), tx('e1'), T),
    log(POOLA, [TOPIC.wrap, tx('d5'), USDT], w(4630000), tx('a5'), T + 86400),
    log(POOLA, [TOPIC.leaves, w(150)], w(0x40) + w(0xa0) + w(2) + tx('f1').slice(2) + tx('f2').slice(2) + w(0), tx('b1'), T + 86400),
    log(POOLA, [TOPIC.spent], w(0x20) + w(1) + tx('91').slice(2), tx('b1'), T + 86400),
    log(POOLA, [TOPIC.leaves, w(152)], w(0x40) + w(0x80) + w(1) + tx('f3').slice(2) + w(0), tx('b2'), T + 2 * 86400),
    log(POOLA, [TOPIC.spent], w(0x20) + w(2) + tx('92').slice(2) + tx('93').slice(2), tx('b3'), T + 2 * 86400),
  ];
  const engineLogs = [
    ...OUTPOINTS.map((o, i) => log(ENGINE, [TOPIC.posted, o, '0x' + '00'.repeat(12) + '5e'.repeat(20)], w(10n ** 15n), tx('7' + i), T)),
    log(ENGINE, [TOPIC.cdpMinted, tx('81')], w(200000000) + w(0), tx('82'), T), log(ENGINE, [TOPIC.cdpMinted, tx('83')], w(150000000) + w(0), tx('84'), T + 86400),
    log(ENGINE, [TOPIC.cdpClosed, tx('85')], w(100000000), tx('86'), T + 2 * 86400),
  ];
  const addr32 = (a) => '0x' + '00'.repeat(12) + a.slice(2);
  const airLogs = [[CL1, 10], [CL1, 20], [CL2, 30]].map(([a, v], i) => log(AIR, [TOPIC.claimed, w(i), addr32(a)], w(BigInt(v) * 10n ** 18n), tx('c' + i), T));
  const transact = (v, i, t, fee = 0n, block) => log(EVMP, [TOPIC.transact, tx('e' + i), tx('e' + (i + 5))], [w(0), w(0), w(0), w(0), w(0), w(v), w(0), w(fee), w(0x140), w(0x160), w(0), w(0)].join(''), tx('9' + i), t, block);
  const devLogs = [transact(3n * 10n ** 17n, 1, T), transact(-(10n ** 17n), 2, T + 86400, 10n ** 16n)];
  const rhLogs = [transact(2n * 10n ** 17n, 3, T, 0n, 74000000)];
  // The TAC ERC-20's mints (Transfer from the zero address): two accounts, three mints, 75 TAC.
  const tacLogs = [[CL1, 40], [CL1, 10], [CL2, 25]].map(([a, v], i) => log(TACTOKEN, [TOPIC.transfer, '0x' + '00'.repeat(32), addr32(a)], w(BigInt(v) * 10n ** 18n), tx('d' + i), T));
  const MAIN = [...poolLogs, ...engineLogs, ...airLogs, ...devLogs, ...tacLogs];
  const BASE_HEAD = 51961580, RH_HEAD = 74100000;
  const inRange = (ls, q) => ls.filter((l) => [].concat(q.address).map(lc).includes(lc(l.address))
    && Number(BigInt(l.blockNumber)) >= Number(BigInt(q.fromBlock)) && (q.toBlock === 'latest' || Number(BigInt(l.blockNumber)) <= Number(BigInt(q.toBlock))));
  const TXS = {
    [POOLA]: [
      { hash: tx('a2'), from: W2, to: POOLA, blockNumber: '26000001', timeStamp: String(T + 86400), isError: '0', methodId: '0x8be3ad21', value: '500000000000000000' },
      { hash: tx('c1'), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: POOLA, blockNumber: '26000002', timeStamp: String(T + 86400), isError: '0', methodId: '0x0b36171c', value: '0' },
      { hash: tx('c2'), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: POOLA, blockNumber: '26000003', timeStamp: String(T + 2 * 86400), isError: '0', methodId: '0x0b36171c', value: '0' },
      { hash: tx('c3'), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: POOLA, blockNumber: '26000004', timeStamp: String(T + 2 * 86400), isError: '1', methodId: '0x0b36171c', value: '0' },
    ],
  };
  // A deposit through the router, its delegatecall frame (which moves nothing), ETH in from a public swap (no deposit), and
  // one withdrawal out.
  const INTERNAL = [
    { transactionHash: tx('a1'), index: '0', from: ROUTER, to: POOLA, value: '1000000000000000000', callType: 'call', isError: '0', timeStamp: String(T), blockNumber: '26000000' },
    { transactionHash: tx('a1'), index: '1', from: POOLA, to: '0x141e653de94438258fdab245896c189f56522554', value: '1000000000000000000', callType: 'delegatecall', isError: '0', timeStamp: String(T), blockNumber: '26000000' },
    { transactionHash: tx('a6'), index: '0', from: '0x00000000e36c7ec997cc59dcda9e03673b448119', to: POOLA, value: '300000000000000000', callType: 'call', isError: '0', timeStamp: String(T + 86400), blockNumber: '26000002' },
    { transactionHash: tx('b2'), index: '1', from: POOLA, to: W1, value: '200000000000000000', callType: 'call', isError: '0', timeStamp: String(T + 2 * 86400), blockNumber: '26000005' },
  ];
  // The engine's outstanding debt, pinned for the scenario to match the fixtures' loans (2 + 1.5 borrowed, 1 repaid).
  const CUSD_SLOT = '0x' + word(19), cusdWas = await rpc('eth_getStorageAt', [ENGINE, CUSD_SLOT, 'latest']);
  await rpc('anvil_setStorageAt', [ENGINE, CUSD_SLOT, '0x' + word(250000000)]);
  const r = await openPage({ account: A0, key: K0, viewport: { width: 1280, height: 1100 } });
  const hits = [], logReads = [];
  // Who sent each deposit comes from the chain in one batch, and the logs from one request: the fixtures answer both
  // here, and every other read goes on to the fork.
  const SENDERS = { [tx('a1')]: W1, [tx('a2')]: W2 };
  for (const host of RPC_HOSTS) await r.ctx.route(`https://${host}/**`, (route) => {
    const b = JSON.parse(route.request().postData() || 'null');
    if (b && !Array.isArray(b) && b.method === 'eth_getLogs') { logReads.push(host); return json(route, { jsonrpc: '2.0', id: b.id, result: inRange(MAIN, b.params[0]) }); }
    if (!Array.isArray(b) || !b.length || !b.every((x) => x.method === 'eth_getTransactionByHash')) return route.fallback();
    return json(route, b.map((x) => ({ jsonrpc: '2.0', id: x.id, result: SENDERS[x.params[0]] ? { hash: x.params[0], from: SENDERS[x.params[0]] } : null })));
  });
  // Both explorers answer from the same fixtures, each list from the block asked for.
  await r.ctx.route(/^https:\/\/((eth|base)\.blockscout\.com\/api|api\.routescan\.io\/v2\/network\/mainnet\/evm\/(1|8453)\/etherscan\/api)\?/, (route) => {
    const u = new URL(route.request().url()), q = u.searchParams, a = lc(q.get('address')), base = /base\.|\/8453\//.test(u.hostname + u.pathname);
    hits.push(u.hostname + u.pathname + u.search);
    const from = Number(q.get('startblock') || q.get('fromBlock') || 0);
    let result = [];
    if (q.get('module') === 'logs') result = base ? [] : inRange(MAIN, { address: a, fromBlock: h(from), toBlock: 'latest' });
    else if (!base) result = (q.get('action') === 'txlist' ? TXS[a] || [] : a === POOLA ? INTERNAL : []).filter((t) => Number(t.blockNumber) >= from);
    return json(route, { status: result.length ? '1' : '0', message: result.length ? 'OK' : 'No records found', result });
  });
  // Base's nodes serve short ranges only, as they do live (the first read of its device pool goes to an explorer).
  await r.ctx.route(/^https:\/\/(mainnet\.base\.org|base-rpc\.publicnode\.com|rpc\.mainnet\.chain\.robinhood\.com)\/?/, (route) => {
    const b = JSON.parse(route.request().postData() || '{}'), url = route.request().url(), base = /base/.test(url);
    const reply = (result) => json(route, { jsonrpc: '2.0', id: b.id, result });
    if (b.method === 'eth_blockNumber') return reply(h(base ? BASE_HEAD : RH_HEAD));
    if (b.method === 'eth_getBalance') return reply(base ? h(5n * 10n ** 17n) : h(2n * 10n ** 17n));
    if (b.method !== 'eth_getLogs') return reply('0x0');
    const q = b.params[0], span = Number(BigInt(q.toBlock)) - Number(BigInt(q.fromBlock)) + 1;
    if (base && span > 2000) return json(route, { jsonrpc: '2.0', id: b.id, error: { code: -32000, message: /publicnode/.test(url) ? 'Archive requests require a personal token' : 'eth_getLogs is limited to a 2,000 range' } });
    return reply(base ? [] : inRange(rhLogs, q));
  });
  let snapshot = null;
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/stats/, (route) => (snapshot ? route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: snapshot }) : route.fulfill({ status: 404, body: '' })));
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/reflection\/status/, (route) => json(route, { attestedHeight: 969159, tipHeight: 969159, foldedCrossoutCount: 5, consumedCount: 2, bridgeBurns: 27, bridgeMinted: 24, liveNotes: 1234 }));
  // The picture of the two chains reads its own small feed: counters now, a day of event times.
  const FLOW = flowFeed();
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/flow/, (route) => json(route, FLOW));
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/leaderboard/, (route) => json(route, [{ address: W1, points: 10 }, { address: W2, points: 20 }]));
  await r.ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/api\/blocks\/tip\/height/, (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '969200' }));
  // A card as "key | value | context".
  const card = async (k) => (await r.page.$$eval('.card', (cs) => cs.map((c) => ['.k', '.v', '.m'].map((x) => c.querySelector(x).textContent.replace(/\s+/g, ' ').trim()).join(' | ')))).find((t) => t.startsWith(k + ' |')) || '';
  try {
    await r.page.goto(r.url + 'weld/stats/');
    await until(r.page, () => /^As of /.test(document.querySelector('#asof')?.textContent || '') && !/updating/.test(document.querySelector('#asof')?.textContent || ''), null, 120000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | asof: ${await text(r.page, '#asof')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(!/some figures/.test(await text(r.page, '#asof')), `stats: every part read (${await text(r.page, '#asof')})`);
    const s = await card('Made private');
    ok(/^Made private \| 2ETH \| 4 deposits/.test(s), `stats: ETH made private is the Tacit pool's ETH wraps and the device pools' deposits together (1.5 + 0.3 + 0.2) (${s})`);
    ok(/^Wallets \| 2 \|/.test(await card('Wallets')), `stats: wallets are the senders of those wraps, however they reached the pool (${await card('Wallets')})`);
    ok(/^Withdrawn \| 0\.31ETH/.test(await card('Withdrawn')), `stats: withdrawn is what the pool paid out plus the device pools' withdrawals (0.2 + 0.11), whatever else came in (${await card('Withdrawn')})`);
    ok(await r.page.$eval('#f-eth', (f) => !f.hidden), 'stats: the ETH-over-time chart is drawn');
    const st = await card('Settles');
    ok(/^Settles \| 3 \| .*3 spent/.test(st), `stats: settles are the transactions that inserted or spent notes (${st})`);
    ok(/2 attestations/.test(await card('Proven to')), `stats: only successful attestations count (${await card('Proven to')})`);
    const cu = await card('cUSD borrowed');
    ok(/^cUSD borrowed \| 3\.5cUSD \| 2\.5 open on 1 loan · 1 repaid/.test(cu), `stats: cUSD borrowed, repaid and still out (${cu})`);
    const ad = await card('Airdrop claimed');
    ok(/^Airdrop claimed \| 60TAC \| 2 wallets/.test(ad), `stats: airdrop claims summed, claimers counted once (${ad})`);
    ok(/^TAC made private \| 100TAC \| 1 deposit/.test(await card('TAC made private')), `stats: TAC made private (${await card('TAC made private')})`);
    // The way back out sits beside it: present as a card (its history may still be being read, then it says so).
    ok(/^TAC made public \| 75TAC \| 3 mints · 2 accounts/.test(await card('TAC made public')), `stats: TAC made public counts the token's mints to accounts, from its Transfer logs (${await card('TAC made public')})`);
    await r.page.locator('#g-tac').scrollIntoViewIfNeeded(); await shot(r.page, 'stats-tac-desk');
    await r.page.setViewportSize({ width: 390, height: 900 }); await r.page.locator('#g-tac').scrollIntoViewIfNeeded(); await shot(r.page, 'stats-tac-phone');
    await r.page.setViewportSize({ width: 1280, height: 1100 });
    // The picture between the chains: mounted from its own feed, its counters the feed's, drawn (not blank) and the day replayable.
    await r.page.locator('#f-flow').scrollIntoViewIfNeeded(); await sleep(2500);
    const fl = { ...(await flowLook(r.page, '#c-flow')), hidden: await r.page.$eval('#f-flow', (f) => f.hidden) };
    ok(fl.has && !fl.hidden && fl.drawn > 200, `stats: the picture between the chains is on the page and drawn (${fl.has}, ${fl.drawn} pixels)`);
    ok(/proven to block 969,159/.test(fl.foot) && /41 behind Bitcoin/.test(fl.foot) && /3 proofs · 2 settles/.test(fl.foot), `stats: its counters are the feed's (${fl.foot})`);
    ok(/UTC · \d+ h ago|now/.test(fl.clock) && /3 proofs of Bitcoin landed on Ethereum/.test(fl.sr), `stats: it plays the last day first and says in words what it shows (${fl.clock} | ${fl.sr})`);
    await shot(r.page, 'stats-flow-desk');
    await r.page.click('#c-flow [data-flm=live]'); await sleep(300);
    ok(!/reconnecting/.test(await text(r.page, '#c-flow .fl-clock')) && (await r.page.$eval('#c-flow [data-flm=live]', (b) => b.getAttribute('aria-selected'))) === 'true', 'stats: Live can be chosen, and keeps quiet while it reads');
    await r.page.setViewportSize({ width: 390, height: 900 }); await r.page.locator('#f-flow').scrollIntoViewIfNeeded(); await sleep(600); await shot(r.page, 'stats-flow-phone');
    await r.page.setViewportSize({ width: 1280, height: 1100 });
    ok(/USDC 2\.5/.test(await card('Others made private')) && /USDT 4\.63/.test(await card('Others made private')), `stats: other assets are named from the pool's registry, or their token (${await card('Others made private')})`);
    ok(await r.page.evaluate(() => [...document.querySelectorAll('.card .m a')].some((a) => /etherscan\.io\/token\/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279#balances$/.test(a.href))), 'stats: TAC links to its ERC-20 holders on Etherscan');
    const pa = await card('Participants'), pp = await card('Points'), ta = await card('TAC allocated');
    ok(/^Participants \| 2 \|/.test(pa) && /^Points \| 30 \|/.test(pp) && /^TAC allocated \| [\d,]+TAC/.test(ta), `stats: points participants and totals from the leaderboard, TAC allocated from the distributor (${pa} | ${pp} | ${ta})`);
    const ac = await card('Cross-chain');
    ok(/\(5 folded\)/.test(ac) && /\d+ spent on Ethereum/.test(ac) && /24 bridged in \(3 more recorded, not minted yet\)/.test(ac), `stats: moves out to Bitcoin with the reflection's folded count, Bitcoin notes spent on Ethereum, and the bridges in that have minted, with the recorded ones still waiting named beside them (${ac})`);
    const nums = { toBtc: Number((ac.match(/(\d+) to Bitcoin/) || [])[1]), spent: Number((ac.match(/(\d+) spent on Ethereum/) || [])[1]), total: Number(((ac.match(/^Cross-chain \| ([\d,]+)/) || [])[1] || '').replace(/,/g, '')) };
    ok(Number.isFinite(nums.total) && nums.total === nums.toBtc + nums.spent + 24, `stats: the total counts all three kinds of move, the bridges in as the ones that arrived (${ac})`);
    const bl = await card('BTC locked'), bh = await card('Bonds');
    const cm = await card('cBTC minted');
    ok(/^BTC locked \| 0\.000007BTC \| 1 lock · 1 unlocked$/.test(bl) && /^cBTC minted \| 0\.000027cBTC \| 2 mints/.test(cm) && /on 2 locks$/.test(bh),
      `stats: BTC locked leaves out a lock since spent, cBTC minted counts every mint, bonds count the locks that hold one (${bl} | ${cm} | ${bh})`);
    const rows = await r.page.$$eval('#c-dev tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
    const row = Object.fromEntries(rows.map((c) => [c[0].replace(/ ↗$/, '').replace(/ device pool$/, ''), c]));
    ok(row.Ethereum?.[2] === '0.3 (1)' && row.Ethereum?.[3] === '0.11 (1)' && row.Ethereum?.[4] === '2' && row.Base?.[1] === '0.5' && row.Base?.[2] === '0 (0)'
      && row.Robinhood?.[1] === '0.2' && row.Robinhood?.[2] === '0.2 (1)', `stats: device pools per chain, deposits and withdrawals (with the relayer's fee) from their Transact events (${JSON.stringify(rows)})`);
    await shot(r.page, 'stats-desk');
    await r.page.setViewportSize({ width: 390, height: 900 });
    await r.page.emulateMedia({ colorScheme: 'dark' });
    await sleep(300);
    ok(await r.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'stats: nothing runs off the side of a phone screen');
    await shot(r.page, 'stats-phone-dark');
    await r.page.setViewportSize({ width: 1280, height: 1100 });
    await r.page.emulateMedia({ colorScheme: 'light' });
    const n = hits.length, nLogs = logReads.length;
    ok(n <= 3 && hits.every((q) => /txlist|base\.blockscout|\/8453\//.test(q)), `stats: a first reading asks the explorers only for the pool's two transaction lists and Base's first log read (${hits.join(' | ')})`);
    ok(new Set(hits.filter((q) => !/base|8453/.test(q)).map((q) => q.split('/')[0])).size === 2, 'stats: the two lists go to the two explorers in turn');
    // The pool's contracts together in one request, and the TAC token's mints alone (filtered at the node) in a second: asking for the
    // whole token in the first would pull every TAC transfer.
    ok(nLogs === 2, `stats: every Ethereum log in two requests, the pool's contracts together and the TAC token's mints alone (${nLogs})`);
    const settled = () => until(r.page, () => /^As of /.test(document.querySelector('#asof')?.textContent || '') && !/updating/.test(document.querySelector('#asof')?.textContent || ''), null, 60000).catch(() => {});
    await r.page.reload();
    await settled();
    ok(hits.length === n && logReads.length === nLogs && /^Made private \| 2ETH/.test(await card('Made private')), `stats: a second visit within the quarter hour shows the last reading and reads nothing (${hits.length - n} explorer, ${logReads.length - nLogs} log reads)`);
    await r.page.goto(r.url + 'weld/stats/?fresh');
    await settled();
    const fresh = hits.slice(n);
    ok(fresh.length === 2 && fresh.every((q) => Number(new URLSearchParams(q.split('?')[1]).get('startblock')) > 0) && /^Made private \| 2ETH \| 4 deposits/.test(await card('Made private')),
      `stats: a fresh reading reads on from what the last one kept, asking the explorers only for what is new (${fresh.join(' | ')})`);
    // The API's shared reading, when there is one, is all a visit needs.
    const kept = fromJsonText(await r.page.evaluate(() => localStorage.getItem('tacit-weld-stats-v3')));
    kept.at = Date.now(); kept.eth.inWei = { $n: String(9n * 10n ** 18n) }; delete kept.partial;
    snapshot = JSON.stringify(kept);
    await r.page.evaluate(() => localStorage.clear());
    const before = [hits.length, logReads.length];
    await r.page.goto(r.url + 'weld/stats/');
    await settled();
    // The shared reading puts the Tacit pool at 9 ETH; the device pools' 0.5 sit beside it, as they do in every reading.
    ok(/^Made private \| 9\.5ETH/.test(await card('Made private')) && hits.length === before[0] && logReads.length === before[1],
      `stats: with the API's shared reading the page shows it and reads nothing itself (${await card('Made private')} · ${hits.length - before[0]} explorer, ${logReads.length - before[1]} log reads)`);
    if (r.errors.length) { fails++; console.log('FAIL stats page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); await rpc('anvil_setStorageAt', [ENGINE, CUSD_SLOT, '0x' + word(cusdWas)]); }
});

// The dashboard paints what the page has read. A wallet holding 5 TAC, whose last visit here saw 2, reads +3.
await step('dash', async () => {
  const W = '0xd45b000000000000000000000000000000000d45', id = `tacit-lite-dash-v1:|${W}`, t0 = Date.now() - 2 * 86400e3;
  if ((await tacOf(W)) !== 5n * 10n ** 18n) await fundTac(W, 5n * 10n ** 18n - (await tacOf(W)));
  const seed = JSON.stringify({ at: t0, v: { tac: { v: String(2n * 10n ** 18n), at: t0 } } });
  const wide = (p) => p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  for (const [tag, viewport, colorScheme] of [['phone', { width: 390, height: 1000 }, 'light'], ['phone-dark', { width: 390, height: 1000 }, 'dark'], ['desk', { width: 1280, height: 1000 }, 'light'], ['desk-dark', { width: 1280, height: 1000 }, 'dark']]) {
    const r = await openPage({ account: W, viewport, colorScheme, init: { fn: ([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, arg: [id, seed] } });
    await r.ctx.route('https://api.tacit.finance/points/**', async (route) => { await sleep(3000); await route.continue(); });     // placeholders stay a moment
    try {
      await r.page.goto(r.url);
      await r.page.waitForSelector('#hx-body .hx-h');
      if (tag === 'phone') { const w = await wide(r.page); ok(w.sw <= w.iw, `dash: the first paint at 390px has no sideways scroll (${w.sw} ≤ ${w.iw})`); }
      await shot(r.page, `first-paint-${tag}`);
      await go(r.page, '#buy');
      await r.page.click('#buy-connect');
      await until(r.page, () => !document.querySelector('#dash').hidden, null, 30000);
      await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
      const early = await r.page.evaluate(() => document.querySelectorAll('#dash .sk').length);
      if (tag === 'phone') await shot(r.page, 'dash-loading-phone');
      await until(r.page, () => /^5( TAC)?$/.test(document.querySelector('[data-dash-open="tac"] .di-v')?.textContent.trim() || ''), null, 60000);
      await until(r.page, () => !document.querySelector('#dash .sk'), null, 60000).catch(() => {});
      const tac = await r.page.$eval('[data-dash-open="tac"]', (b) => b.textContent.replace(/\s+/g, ' ').trim()), since = await text(r.page, '#dash-since');
      if (tag === 'phone') {
        ok(early > 0, `dash: a connected wallet's dashboard shows placeholders first (${early})`);
        ok(/\+3 · /.test(tac) && /since/.test(since), `dash: 5 TAC now, against 2 at the last visit, reads +3 (${tac} | ${since})`);
        ok(!!(await r.page.$('[data-dash-open="pts"]')) && !(await r.page.$('#dash .sk')), 'dash: then every placeholder gives way to a value');
        const w = await wide(r.page);
        ok(w.sw <= w.iw, `dash: still no sideways scroll at 390px with it showing (${w.sw})`);
      }
      await shot(r.page, `dash-${tag}`);
      if (r.errors.length) { fails++; console.log(`FAIL dash ${tag} page errors: ` + r.errors.slice(0, 3).join(' | ')); }
    } finally { await r.browser.close(); }
  }
  // An opened key: its private tETH, TAC and points, tETH a placeholder while its notes are read, each opening its sheet.
  const k = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 1000 } });
  try {
    await k.page.goto(k.url);
    await pasteKey(k.page, 'da5b'.padEnd(64, '8'));
    await k.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await until(k.page, () => !document.querySelector('#dash').hidden, null, 30000);
    const cells = await k.page.$$eval('#dash .di', (b) => b.map((x) => x.dataset.dashOpen));
    ok(['private', 'tac', 'pts'].every((c) => cells.includes(c)) && !!(await k.page.$('#dash [data-dash-open="private"] .sk')), `dash: an opened key shows tETH, TAC and points, tETH as a placeholder while its notes are read (${cells.join(', ')})`);
    await shot(k.page, 'dash-key-phone');
    await k.page.click('#dash [data-dash-open="private"]');
    await k.page.waitForSelector('#sheet-eth[open]', { timeout: 15000 });
    ok(true, 'dash: an item opens its sheet');
    if (k.errors.length) { fails++; console.log('FAIL dash key page errors: ' + k.errors.slice(0, 3).join(' | ')); }
  } finally { await k.browser.close(); }
});

// A 20 TAC deposit made the way tacit.finance makes one (a router wrap with a TAC permit, from the key's Tacit account),
// whose settle never landed: weld finds it from the key, offers Finish on the TAC sheet and on the dashboard, and the
// settle it submits is the wrap rebuilt under TAC's own asset id and scale.
await step('tacdeposit', async () => {
  const hex = 'dec0de'.padEnd(64, '4'), acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 17n).toString(16)]);
  await fundTac(acct, 20n * 10n ** 18n);
  const r = await openPage({ account: A0, key: K0 });
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#hx-body .hx-h');
    const dep = await r.page.evaluate(async (h) => {
      const d = await import('/vendor/tacit-deps.min.js'), cd = await import('/confidential-deployments.js');
      cd.setActiveNetwork('mainnet');
      const { makeConfidentialPoolUx } = await import('/confidential-pool-ux.js');
      const ux = makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' });
      const w = await ux.routerWrap({ walletPriv: d.hexToBytes(h), amountWei: (20n * 10n ** 18n).toString(), ticker: 'TAC', index: 0 });
      return { txHash: w.txHash, asset: w.wrapOp.asset, value: String(w.wrapOp.value) };
    }, hex);
    const landed = await chainUntil(async () => (await rpc('eth_getTransactionReceipt', [dep.txHash]))?.status === '0x1', 60000);
    ok(landed && dep.value === '2000000000', `tacdeposit: a 20 TAC deposit lands on the fork (${String(dep.txHash).slice(0, 12)}…, ${dep.value} units of ${dep.asset.slice(0, 10)}…)`);
    await pasteKey(r.page, hex);
    await go(r.page, '#tac');
    await r.page.waitForSelector('#tac-finish', { timeout: 1200000 });                  // once the key's notes are read
    const call = (await text(r.page, '#tac-bal .callout')).replace(/\s+/g, ' ').trim();
    ok(/^20 TAC is waiting to become private\./.test(call), `tacdeposit: the TAC sheet offers to finish it, counted once (${call})`);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await until(r.page, () => /20 TAC is waiting/.test(document.querySelector('#dash-due')?.textContent || ''), null, 30000).catch(() => {});
    ok(/20 TAC is waiting to become private/.test(await text(r.page, '#dash-due')), 'tacdeposit: so does the dashboard');
    await shot(r.page, 'tacdeposit-dash');
    const n0 = submits.length;
    await r.page.click('#dash-due [data-dash-do="tac"]');                               // opens the TAC sheet and presses its Finish
    await until(r.page, () => /stubbed|err/i.test(document.querySelector('#tac-bal-status')?.innerHTML || ''), null, 120000).catch(() => {});
    ok(/Finishing a 20 TAC deposit did not go through: Stubbed in the fork check/.test(await text(r.page, '#tac-bal-status')), `tacdeposit: the sheet's line sums up the Finish once its settle has ended (${await text(r.page, '#tac-bal-status')})`);
    const subs = submits.slice(n0).filter((s) => s.type === 'wrap');
    ok(subs.length === 1 && String(subs[0].op?.asset).toLowerCase() === dep.asset.toLowerCase() && String(subs[0].op?.value) === dep.value,
      `tacdeposit: Finish submits one wrap, rebuilt under TAC's asset and scale (${subs.length} submitted, value ${subs[0]?.op?.value})`);
    await openActivity(r.page);
    ok(/Finish a 20 TAC deposit/.test(await text(r.page, '#act-body')), 'tacdeposit: the settle shows in Activity');
    if (r.errors.length) { fails++; console.log('FAIL tacdeposit page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The page's pool module with private notes added to the balance and, if given, the farm positions the key holds: what a
// private farm's card shows once a key has something in it. Harvest and unbond are recorded, not proved.
const FARM_CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', FARM_CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const FARM_WTAC_ASSET = '0x1097c9e552ae4fce2a8c416b93403953fa445a5f2cdae8ced36d9a78cfe40832', FARM_LP0 = '0x17c56713a7e4a5d679a71def3ff9fa186f1556ef757b0ee6b7a3ed8c9249ef99';
// With `chain`, the farm steps keep state, as the chain does: a harvest turns the reward into a wTAC note, and the position goes on
// earning (more than the dust a plain unbond allows, as a farm that streams every second does by the time a harvest settles);
// an unbond refuses over that dust unless told to give it up, then turns the position into a liquidity note; taking that
// out gives both assets; redeeming spends a wTAC note. Each call is recorded in window.__farmCalls.
// The relay refusing what carries no fee, as it does when its day's free settles are used up: harvest, unbond and the reward unwrap fail
// until the page hands the settle to the paying account (a selfSettle), and then they run as the chain stub would.
const refuseStub = () => `
    const refused = () => window.__farmQueue ? new Error('settle timed out after 900s') : Object.assign(new Error('relay 429: free relayed settles for today are used up (300/300) — attach a fee above the floor, or prove-mode and settle it yourself'), { code: 'free_budget' });   // or, with __farmQueue, a wait that ran out in the relay's queue
    for (const k of ['farmHarvest', 'farmUnbond', 'farmRedeem']) {
      const real = ux[k];
      ux[k] = async (a) => {
        if (!a.selfSettle) { window.__farmCalls.push('refused:' + k); throw refused(); }
        window.__farmCalls.push('self:' + k);
        return real({ ...a, selfSettle: undefined });
      };
    }
    ux.sendUnwrap = async (a) => {                                       // the self-sent unwrap of a reward note
      if (!a.selfSettle) { window.__farmCalls.push('refused:sendUnwrap'); throw refused(); }
      window.__farmCalls.push('self:unwrap:' + a.note.value);
      add.splice(add.findIndex((x) => x.cx === a.note.cx), 1);
      return { txHash: '0x' + 'ee'.repeat(32) };
    };`;
const chainStub = () => `
    const DUST = 100000n, REWARD = ${JSON.stringify(FARM_WTAC_ASSET)}, CETH = ${JSON.stringify(FARM_CETH)}, CTAC = ${JSON.stringify(FARM_CTAC)};
    const find = (leaf) => positions.find((x) => x.receiptLeaf === leaf), slow = () => new Promise((r) => setTimeout(r, 700));
    ux.farmHarvest = async ({ position }) => {
      await slow();
      const p = find(position.receiptLeaf), units = BigInt(p.pendingUnits);
      window.__farmCalls.push('harvest:' + position.receiptLeaf);
      if (units <= 0n) throw new Error('farm-harvest: nothing to claim beyond the relay fee yet');
      add.push(note(REWARD, units));
      p.pendingUnits = String(DUST * 20n); p.pendingTac = '0.02';
      return {};
    };
    ux.farmUnbond = async ({ position, forfeitPending }) => {
      await slow();
      const p = find(position.receiptLeaf);
      window.__farmCalls.push('unbond:' + position.receiptLeaf + ':' + (forfeitPending ? 'forfeit' : 'keep'));
      if (!forfeitPending && BigInt(p.pendingUnits) > DUST) throw new Error('farm-unbond: ' + p.pendingUnits + ' reward units are still pending and would be forfeited; harvest first, or pass forfeitPending: true');
      positions.splice(positions.indexOf(p), 1);
      add.push(note(p.lpAsset, BigInt(p.shares)));
      return {};
    };
    ux.lpRemove = async ({ shareNote }) => {
      await slow();
      window.__farmCalls.push('remove:' + shareNote.value);
      add.splice(add.findIndex((n) => n.cx === shareNote.cx), 1);
      add.push(note(CETH, BigInt(shareNote.value) / 10n), note(CTAC, BigInt(shareNote.value) * 3n));
      return {};
    };
    ux.farmRedeem = async ({ note: n }) => {
      await slow();
      window.__farmCalls.push('redeem:' + n.value);
      add.splice(add.findIndex((x) => x.cx === n.cx), 1);
      return { unwrap: {}, next: [] };
    };`;
// A swap's route and the split before it, recorded in window.__swapCalls and applied to the notes. The real pools are read for the
// quote. window.__swapRefuse makes the relay refuse a relayed route, as it does when its free settles are used up.
const swapStub = () => `
    window.__swapCalls = [];
    window.__swapQueue = 0;                                             // how many relayed steps wait out the relay's queue (then run the next ones)
    window.__poolMoves = false;                                         // true: the pool's reserves take the swap in, as the real pool's do
    const reserves = ux.poolReserves;
    ux.poolReserves = async (id) => {
      const r = await reserves(id), m = window.__moved;
      if (!r || !window.__poolMoves || !m) return r;
      const has = (x) => BigInt(r.assetA) === BigInt(x) || BigInt(r.assetB) === BigInt(x);
      if (!has(m.asset) || !has(m.next)) return r;
      const inIsA = BigInt(r.assetA) === BigInt(m.asset);
      return { ...r, reserveA: inIsA ? r.reserveA + m.y : r.reserveA - m.out, reserveB: inIsA ? r.reserveB - m.out : r.reserveB + m.y };
    };
    const wait = () => new Promise((r) => setTimeout(r, 400));
    const queued = (selfSettle) => { if (window.__swapQueue > 0 && !selfSettle) { window.__swapQueue--; throw new Error('settle timed out after 900s'); } };
    ux.route = async (a) => {
      const q = await ux.quoteRoute({ asset0: a.inNote.asset, amountIn: a.amountIn, path: a.path, fee: a.fee });
      window.__swapCalls.push({ amountIn: String(a.amountIn), noteValue: String(a.inNote.value), fee: String(a.fee), minOut: String(a.minOut), out: String(q.amountOut), path: a.path.map((h) => h.feeBps + ':' + h.assetNext), self: !!a.selfSettle });
      if (window.__swapRefuse && !a.selfSettle) throw new Error('fee below the current floor');
      queued(a.selfSettle);
      await wait();
      window.__moved = { next: a.path[0].assetNext, asset: a.inNote.asset, y: BigInt(a.amountIn) - BigInt(a.fee), out: BigInt(q.amountOut) };
      add.splice(add.findIndex((n) => n.cx === a.inNote.cx), 1);
      add.push(note(q.assetFinal, q.amountOut));
      return { txHash: '0x' + 'ab'.repeat(32) };
    };
    ux.lpBond = async (a) => { window.__join = { controller: a.controller, a: a.aNote.value, b: a.bNote.value, aAsset: a.aNote.asset, bAsset: a.bNote.asset, feeBps: a.feeBps, selfSettle: typeof a.selfSettle }; return { txHash: null, dShares: 1n }; };
    ux.transfer = async ({ notes, amount, selfSettle }) => {
      window.__swapCalls.push({ split: String(amount), self: !!selfSettle });
      queued(selfSettle);
      await wait();
      for (const n of notes) add.splice(add.findIndex((x) => x.cx === n.cx), 1);
      const total = notes.reduce((t, n) => t + BigInt(n.value), 0n);
      add.push(note(notes[0].asset, amount));
      if (total > amount) add.push(note(notes[0].asset, total - amount));
      return {};
    };`;
// `held`: a harvest goes to the real relay client (no proof is built here), whose job the stub relay holds open (openNext).
const heldStub = () => `
    ux.farmHarvest = async (a) => {
      window.__farmCalls.push((a.selfSettle ? 'self' : 'relayed') + ':farmHarvest');
      if (a.selfSettle) throw new Error('proved a second time');
      return ux.relay.settle({ type: 'farmharvest', op: { stub: 'held' }, memos: [] }, a.waitOpts);
    };`;
const stubFarmUx = (page, { notes = [], positions = null, chain = false, swap = false, refuse = false, held = false, fees = null, reserves = null }) => page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
  import * as real from '/confidential-pool-ux.js?stub=real';
  export * from '/confidential-pool-ux.js?stub=real';
  export function makeConfidentialPoolUx(o) {
    const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
    let seq = 0;
    const note = (asset, value) => { seq++; return { asset: asset[0] === '@' ? String(ux.assetByTicker[asset.slice(1)].assetId).toLowerCase() : asset, value: String(value), leafIndex: 910000 + seq, cx: '0x' + seq.toString(16).padStart(64, 'a'), cy: '0x01', owner: '0x02', root: '0x03', path: [] }; };
    const add = ${JSON.stringify(notes.map(([a, v]) => [a, String(v)]))}.map(([a, v]) => note(a, BigInt(v)));      // the chain adds and removes notes here
    window.__farmCalls = [];
    // The notes this stub adds are what the chain would add: a settle that inserts leaves, so the pool's count grows with each look.
    let leafSeq = 0;
    ux.poolLeafCount = async () => 900000 + (++leafSeq);
    ux.balance = async (priv) => {
      const b = await balance(priv);
      b.notes = [...b.notes, ...add];
      for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
      ${positions ? 'b.farmPositions = positions.map((p) => ({ ...p }));' : ''}       // the page takes positions from the scan when it carries them
      return b;
    };
    ${fees ? `ux.quoteOpFee = async (tk, k) => BigInt(${JSON.stringify(fees)}[k] ?? 0);` : ''}       // fixed relay fees, so notes can be made to a plan
    ${reserves ? `const rv = ux.poolReserves, OV = ${JSON.stringify(reserves)}; ux.poolReserves = async (id) => { const r = await rv(id), o = OV[String(id).toLowerCase()]; return o && r ? { ...r, reserveA: BigInt(o.reserveA), reserveB: BigInt(o.reserveB) } : r; };` : ''}       // a pool whose price is set here
    ${swap ? swapStub() : ''}
    ${positions ? `const positions = ${JSON.stringify(positions)}; ux.farmPositions = async () => positions.map((p) => ({ ...p }));
    ${chain ? chainStub() : `ux.farmHarvest = async ({ position }) => { window.__farmCalls.push('harvest:' + position.receiptLeaf); return {}; };
    ux.farmUnbond = async ({ position }) => { window.__farmCalls.push('unbond:' + position.receiptLeaf); return {}; };`}` : ''}
    ${refuse ? refuseStub() : ''}
    ${held ? heldStub() : ''}
    return ux;
  }` }));
const farmPos = (n, shares, units, tac) => ({ pid: 0, pair: 'TAC/cETH', lpAsset: FARM_LP0, shares: String(shares), receiptLeaf: '0x' + String(n).repeat(64), receiptIndex: n, unlockAt: 0, pendingUnits: String(units), pendingTac: tac });
// Opens a key by its pasted hex, funds its Tacit account for gas and returns the page.
async function openFarmKey(hex, stub, viewport, setup) {
  const r = await openPage({ account: A0, key: K0, viewport });
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 18n).toString(16)]);
  await stubFarmUx(r.page, stub);
  if (setup) await setup(r.page);
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="paste"]'); await r.page.fill('#ws-hex', hex); await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  return r;
}

// The relay refuses what carries no fee (its day's free settles are used up): a harvest, an unbond and a reward's unwrap each offer to
// be sent from the paying account instead, which proves nothing is stuck behind the relay's budget; the offer runs the same call with
// the settle handed over.
await step('farmself', async () => {
  const r = await openFarmKey('5e1f'.padEnd(64, '6'), { notes: [], positions: [farmPos(7, 150000000, 1234560000, '12.3456'), farmPos(9, 20000000, 0, '0')], chain: true, refuse: true });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('[data-harvest="0"]', { timeout: 300000 });
    await p.click('[data-harvest="0"]');
    await p.waitForSelector('#sf-act-0 [data-selfdo]', { timeout: 120000 });
    ok(/free relayed settles|used up|free settles/i.test(await text(p, '#sf-act-0')) && /Send it from/.test(await text(p, '#sf-act-0')), 'farmself: a harvest the relay refuses offers to send it from the paying account');
    await p.click('#sf-act-0 [data-selfdo]');
    await until(p, () => /Harvested to a wTAC note/.test(document.querySelector('#sf-act-0')?.textContent || ''), null, 240000);
    let calls = await p.evaluate(() => window.__farmCalls);
    ok(calls.includes('refused:farmHarvest') && calls.includes('self:farmHarvest') && calls.includes(`harvest:0x${'7'.repeat(64)}`), `farmself: the offer runs the same harvest with the settle handed over (${calls.join(', ')})`);
    // the position with nothing pending: unbond is refused the same way
    await p.waitForSelector('[data-unbond]:not([disabled])', { state: 'attached', timeout: 120000 });
    await p.evaluate(() => document.querySelectorAll('.lockmore').forEach((d) => { d.open = true; }));
    const idx = await p.$$eval('[data-unbond]', (b) => b.findIndex((x) => !x.disabled));
    await p.click(`[data-unbond="${idx}"]`);
    await p.waitForSelector('#sf-act-0 [data-selfdo]', { timeout: 120000 });
    await p.click('#sf-act-0 [data-selfdo]');
    await until(p, () => /Unbonded/.test(document.querySelector('#sf-act-0')?.textContent || ''), null, 240000);
    calls = await p.evaluate(() => window.__farmCalls);
    ok(calls.includes('refused:farmUnbond') && calls.includes('self:farmUnbond') && calls.some((c) => c.startsWith('unbond:')), 'farmself: an unbond the relay refuses is offered and sent from the paying account too');
    // a harvested reward note is unwrapped by the relay for a fee; refused, it is offered as a send from the paying account (no relay fee)
    await p.waitForSelector('#fn-turn, #fn-redeem', { timeout: 300000 });
    await p.click('#fn-turn, #fn-redeem');
    await p.waitForSelector('#fn-status [data-selfdo]', { timeout: 300000 });
    ok(/no relay fee/.test(await text(p, '#fn-status')) || /Send it from/.test(await text(p, '#fn-status')), 'farmself: a reward note the relay refuses to unwrap is offered as a send from the paying account');
    await p.click('#fn-status [data-selfdo]');
    await until(p, () => (window.__farmCalls || []).some((c) => c.startsWith('self:unwrap:')), null, 240000);
    ok((await p.evaluate(() => window.__farmCalls)).some((c) => /^self:unwrap:\d+$/.test(c)), 'farmself: and the unwrap goes out with the settle handed over, whole note, no relay fee');
    if (r.errors.length) { fails++; console.log('FAIL farmself page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// Claim rewards takes only what is worth turning into TAC: a reward the relay's unwrap fee would eat (or that costs more in network
// fee than it holds) is left to grow rather than harvested into a note that cannot be redeemed for what it holds, and the line says so.
await step('farmworth', async () => {
  const r = await openFarmKey('5e1f'.padEnd(64, '7'), { notes: [], positions: [farmPos(7, 150000000, 1234560000, '12.3456'), farmPos(8, 20000000, 150000000, '1.5')], chain: true });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('#fn-redeem', { timeout: 300000 });
    ok(/at least 2 TAC/.test(await text(p, '#farm-notes')), 'farmworth: Claim rewards says what the relay charges to unwrap a note');
    await p.click('#fn-redeem');
    await until(p, () => /Your rewards are TAC|wTAC is not visible yet|not yet worth/.test(document.querySelector('#fn-status')?.textContent || ''), null, 240000);
    const calls = await p.evaluate(() => window.__farmCalls);
    ok(calls.filter((c) => c.startsWith('harvest:')).join() === `harvest:0x${'7'.repeat(64)}`, `farmworth: only the position worth turning into TAC is harvested (${calls.join(', ')})`);
    await p.waitForSelector('#fn-left', { timeout: 120000 });
    ok(/1 earned reward is not yet worth turning into TAC/.test(await text(p, '#fn-left')) && /keeps growing/.test(await text(p, '#fn-left')), 'farmworth: and the one left says why, and that it keeps growing');
    if (r.errors.length) { fails++; console.log('FAIL farmworth page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// A private farm's card with a key that holds positions: the position leads and the farm's facts close the card, each
// position is named, unbond waits for a harvest while a real reward is unharvested, what is waiting (harvested rewards,
// liquidity not bonded) sits above the farms, and what a harvest or unbond leaves points at its next step.
await step('farmpos', async () => {
  const r = await openFarmKey('b05e'.padEnd(64, '6'), { notes: [[FARM_WTAC_ASSET, 1234560000n], [FARM_LP0, 50000000n]], positions: [farmPos(7, 150000000, 1234560000, '12.3456'), farmPos(8, 20000000, 50000, '0.0005')] });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('.farm.open[data-farm="pid0"] [data-unbond]', { state: 'attached', timeout: 240000 });
    const card = (await text(p, '#farm-pid0')).replace(/\s+/g, ' ');
    ok(/Position 1/.test(card) && /Position 2/.test(card), 'farmpos: with two positions in one pool, each is named');
    ok(card.indexOf('Your position') < card.indexOf('In the pool') && /The farm/.test(card), 'farmpos: the positions lead the card and the farm\'s facts close it');
    ok(/Earned\s*12\.3456 TAC (\(≈ [\d.,]+ ETH\)|\(< 0\.00001 ETH\))?/.test(card) && /Earning\s*about [\d,.]+ TAC a day/.test(card), 'farmpos: earned reads in ETH too, and what it earns a day has its own row');
    const un = await p.$$eval('[data-unbond]', (b) => b.map((x) => x.disabled));
    ok(un[0] === true && un[1] === false, `farmpos: unbond waits for a harvest while a real reward is unharvested, and not for dust (${un})`);
    ok(/Harvest first: unbonding now would give up the 12\.3456 TAC/.test(card), 'farmpos: and says why');
    await until(p, () => /Harvested rewards/.test(document.querySelector('#farm-notes')?.textContent || ''), null, 300000);   // the notes scan is slow on a cold fork
    ok(await p.evaluate(() => { const n = document.querySelector('#farm-notes'), l = document.querySelector('#farm-list'); return !!(n.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) && /Harvested rewards/.test(n.textContent) && /not bonded/.test(n.textContent); }),
      'farmpos: harvested rewards and unbonded liquidity wait above the farms');
    ok(/Private pool/.test(await text(p, '[data-farm="pid0"] > button')) && !/Tacit pool/.test(await text(p, '#farm-list')), 'farmpos: the rows say Private pool');
    const rows = (await text(p, '#farm-list')).replace(/\s+/g, ' ');
    ok(/tETH \/ TAC/.test(rows) && !/TAC \/ tETH/.test(rows) && (rows.match(/Private pool · [\d.,]+ ETH deep|Private pool · under 0\.01 ETH deep/g) || []).length >= 3, 'farmpos: pools read tETH first, and each says how deep it is');
    ok(/In the farms\s*≈ [\d.]+ ETH · 2 positions/.test(await text(p, '#farm-notes')) && /Earning\s*about [\d.,]+ TAC a day/.test(await text(p, '#farm-notes')) && /Rewards\s*24\.69 TAC · 12\.35 harvested/.test((await text(p, '#farm-notes')).replace(/\s+/g, ' ')),
      'farmpos: a summary leads the sheet: what is in the farms, what it earns a day, and the rewards waiting in all');
    ok(/Worth\s*≈ [\d.]+ ETH · [\d.<>a-z% ]+ of the farm/.test(card), 'farmpos: each position says what it is worth and its share of the farm');
    await p.click('[data-harvest="0"]');
    await p.waitForSelector('#sf-act-0 [data-fn-go="redeem"]', { timeout: 60000 });
    ok(await p.evaluate(() => { const a = document.querySelector('#sf-act-0'), u = document.querySelector('[data-unbond="1"]'); return !!(u.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'farmpos: a harvest reports under the positions, not below the join form');
    await p.click('#sf-act-0 [data-fn-go="redeem"]');
    await until(p, () => ['fn-turn', 'fn-redeem'].includes(document.activeElement?.id), null, 10000);
    ok((await p.evaluate(() => window.__farmCalls)).some((c) => c.startsWith('harvest:')), 'farmpos: a harvest says where to turn it into TAC, and the link takes you to that button');
    if (r.errors.length) { fails++; console.log('FAIL farmpos page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// A private farm with a key that holds tETH but no TAC: the form opens on tETH alone; both sides says where TAC is made (going
// there leaves a way back to this farm, and taking it returns to the same card) or to farm with tETH alone.
// What the key holds, where it is used: the card's amount line says the balance of what it takes and Max fills it, the coin picker says what each
// choice holds (a choice with none is quieter), and Your Tacit and the header say what it is all worth, and how much of it is private.
await step('hxbal', async () => {
  const r = await openFarmKey('ba1a'.padEnd(64, '6'), { notes: [[FARM_CETH, 10000000n], [FARM_CTAC, 50000000000n]] });
  const p = r.page;
  try {
    await p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
    await p.click('[data-hxm="swap"]'); await p.selectOption('#hx-from', 'eth');
    await until(p, () => /0\.1 tETH · Max/.test(document.querySelector('#hx-bal')?.textContent || ''), null, 300000);
    await p.click('#hx-max');
    ok(await p.$eval('#hx-amt', (e) => e.value) === '0.1', 'hxbal: the amount line says 0.1 tETH held, and Max fills 0.1');
    await p.click('[data-pk="hx-from"]'); await p.waitForSelector('.hx-pk-r');
    const rows = await p.$$eval('.hx-pk-r', (b) => b.map((x) => `${x.dataset.v}:${x.querySelector('em')?.textContent || ''}:${x.classList.contains('zero')}`));
    ok(rows.includes('eth:0.1:false') && rows.includes('tac:500:false') && rows.includes('cusd:0:true'), `hxbal: the picker says what each choice holds, and a choice with none is quieter (${rows.join(' ')})`);
    await p.keyboard.press('Escape');
    await until(p, () => /≈ \$[\d,.]+/.test(document.querySelector('#dash-worth')?.textContent || ''), null, 300000);
    const worth = (await text(p, '#dash-worth')).replace(/\s+/g, ' ');
    ok(/private/.test(worth) && !(await p.$eval('#hold-tot', (b) => b.hidden)), `hxbal: Your Tacit and the header say what it is all worth, and how much is private (${worth})`);
    await p.click('#hold-tot'); await sleep(900);
    ok(await p.evaluate(() => { const b = document.querySelector('#dash').getBoundingClientRect(); return b.top < innerHeight && b.bottom > 0; }), 'hxbal: the header total takes you to Your Tacit');
    if (r.errors.length) { fails++; console.log('FAIL hxbal page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

await step('hxteth', async () => {
  const r = await openFarmKey('7e7e'.padEnd(64, '6'), { notes: [[FARM_CETH, 15000000n], [FARM_CETH, 10000000n]] });
  const p = r.page, line = async () => (await text(p, '#hx-q')).replace(/\s+/g, ' ').trim();
  const lander = () => p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  try {
    await lander();
    await p.click('[data-hxm="private"]');
    await until(p, () => /You hold 0\.25 tETH privately/.test(document.querySelector('#hx-have')?.textContent || ''), null, 300000);
    ok(await p.$$eval('#hx-have [data-hxin]', (b) => b.map((x) => x.dataset.hxin).join()) === 'send:eth,swap:eth:tac,shield:eth:wallet', 'hxteth: Shield says the tETH held, with Send, Swap and Back to ETH a press away');
    await p.click('[data-hxin="shield:eth:wallet"]');
    ok(await p.$eval('#hx-from', (e) => e.value) === 'eth' && (await p.evaluate(() => document.activeElement?.id)) === 'hx-amt', 'hxteth: Back to ETH sets the card to taking tETH out, with the keyboard in the amount');
    await p.fill('#hx-amt', '0.1');
    await until(p, () => /^Relay fee [\d.]+ ETH, out of it\. To your wallet or any address you name next\.$/.test((document.querySelector('#hx-q')?.textContent || '').trim()), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${await line()}`); });
    const fee = Number((await line()).match(/Relay fee ([\d.]+) ETH/)[1]), out = Number(await text(p, '#hx-out'));
    ok(fee > 0 && Math.abs(out - (0.1 - fee)) < 1e-9, `hxteth: 0.1 tETH back to ETH pays out 0.1 less the relay fee (${out} = 0.1 - ${fee})`);
    await p.click('#hx-max');
    await until(p, () => /to combine notes first/.test(document.querySelector('#hx-q')?.textContent || ''), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${await line()}`); });
    const combine = Number((await line()).match(/and ([\d.]+) tETH from your balance to combine notes/)[1]), max = Number(await p.inputValue('#hx-amt'));
    ok(combine > 0 && Math.abs(max + combine - 0.25) < 1e-9, `hxteth: Max over two notes keeps the relay fee that combines them (${max} + ${combine} = 0.25)`);
    await p.click('#hx-go');
    await until(p, (v) => document.querySelector('#sheet-eth[open] #o-amt')?.value === v, String(max), 120000);
    ok(true, 'hxteth: Turn tETH into ETH opens the Withdraw form with that amount');
    await lander();
    await p.click('[data-hxm="send"]');
    await p.fill('#hx-amt', '0.1');
    await until(p, () => /^They get about [\d.]+ tETH: their claim's relay fee comes out of it\. Nobody sees how much or to whom\.$/.test((document.querySelector('#hx-q')?.textContent || '').trim()), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${await line()}`); });
    ok(/0\.25 tETH · Max/.test(await text(p, '#hx-bal')), `hxteth: Send says what the recipient gets (a 0.1 note is held, so nothing is cut), with the balance and Max (${await line()})`);
    await p.fill('#hx-rcpt', 'name.wei');
    await p.click('#hx-go');
    await until(p, () => document.querySelector('#sheet-eth[open] #s-amt')?.value === '0.1' && document.querySelector('#s-to')?.value === 'name.wei', null, 120000);
    ok(true, 'hxteth: Send privately opens the Send form with the amount and the recipient');
    if (r.errors.length) { fails++; console.log('FAIL hxteth page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The card's Send for each asset it offers: a key holding private tETH, TAC, cUSD and cBTC quotes each in its own ticker with its balance and Max, and the press
// opens the form that sends it (tETH its Send tab, TAC and cUSD/cBTC their own) with the amount and the recipient; TAC and BTC on Bitcoin carry both into Pay's link;
// a key holding only cUSD opens on it, and a chosen asset it has none of says so and offers the way to get some; a #card=send link fills the card.
await step('hxsend', async () => {
  const CUSD = '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d', CBTC = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
  const fees = { transfer: 100000, stealthclaim: 100000, sendunwrap: 100000 };                 // fixed relay fees: no cold DEX reads
  const to = tacit1('abc'.padEnd(64, '9'));
  const lander = (p) => p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  const r = await openFarmKey('7d7d'.padEnd(64, '5'), { notes: [[FARM_CETH, 25000000n], ['@cTAC', 5000000000n], [CUSD, 2500000000n], [CBTC, 50000000n]], fees });
  const p = r.page, urls = [];
  p.on('framenavigated', (f) => { if (f === p.mainFrame()) urls.push(f.url()); });
  const line = async () => (await text(p, '#hx-q')).replace(/\s+/g, ' ').trim();
  const dbg = (m) => { if (process.env.DEBUG_STEP) console.log('     ·', m); };
  const pick = async (k, bal) => {
    dbg(`pick ${k}`);
    await lander(p);
    await p.click('[data-hxm="send"]');
    await p.selectOption('#hx-sa', k);
    await until(p, (re) => new RegExp(re).test(document.querySelector('#hx-bal')?.textContent || ''), bal, 300000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | bal: ${await text(p, '#hx-bal')} | have: ${await text(p, '#hx-have')} | q: ${await line()}`); });
    dbg(`picked ${k}`);
  };
  const quote = async (amt, ticker) => {
    await p.fill('#hx-rcpt', to);
    await p.fill('#hx-amt', amt);
    await until(p, (t) => new RegExp(`^They get about [\\d.]+ ${t}: their claim's relay fee comes out of it(, and [\\d.]+ ${t} from your balance (splits a note|combines notes) first)?\\. Nobody sees how much or to whom\\.$`).test((document.querySelector('#hx-q')?.textContent || '').trim()), ticker, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${await line()}`); });
  };
  try {
    await lander(p);
    await p.click('[data-hxm="send"]');
    await until(p, () => /0\.25 tETH · Max/.test(document.querySelector('#hx-bal')?.textContent || ''), null, 300000);
    ok(await p.$eval('#hx-sa', (e) => e.value) === 'eth', 'hxsend: a key holding tETH opens Send on it');
    // Each private holding on Your Tacit has a Send of its own, and it sets the card to that asset.
    await until(p, () => document.querySelectorAll('#dash-g .di-send').length >= 4, null, 300000);
    const sends = await p.$$eval('#dash-g .di-send', (b) => b.map((x) => x.dataset.hx).sort().join());
    ok(sends === 'send:cbtc,send:cusd,send:eth,send:tac', `hxsend: Your Tacit offers Send on tETH, TAC, cUSD and cBTC and nowhere it holds none (${sends})`);
    if (SHOTS) {
      await p.locator('#dash').screenshot({ path: join(SHOTS, 'weld-hxsend-dash.png') });
      await p.setViewportSize({ width: 390, height: 900 });
      await p.locator('#dash').screenshot({ path: join(SHOTS, 'weld-hxsend-dash-phone.png') });
      await p.setViewportSize({ width: 1280, height: 900 });
    }
    await p.click('#dash-g .di-send[data-hx="send:cusd"]');
    await until(p, () => document.querySelector('[data-hxm="send"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('#hx-sa')?.value === 'cusd', null, 60000);
    ok(true, 'hxsend: a holding\'s Send sets the card to Send on that asset');
    await lander(p);
    await p.click('[data-hxm="send"]');
    await p.selectOption('#hx-sa', 'eth');
    await until(p, () => /0\.25 tETH · Max/.test(document.querySelector('#hx-bal')?.textContent || ''), null, 120000);
    const rows = await p.$$eval('#hx-sa option', (o) => o.map((x) => x.value).join());
    ok(rows === 'eth,tac,cusd,cbtc,tacb,btc', `hxsend: Send offers tETH, TAC, cUSD and cBTC on Ethereum and TAC and BTC on Bitcoin (${rows})`);
    for (const [k, bal, amt, ticker, sheet, amtId, toId] of [['cusd', '^25 cUSD · Max', '15', 'cUSD', 'borrow', 'cs-amt', 'cs-to'], ['tac', '^50 TAC · Max', '20', 'TAC', 'tac', 'ts-amt', 'ts-to'], ['cbtc', '^0\\.5 cBTC · Max', '0.2', 'cBTC', 'borrow', 'cs-amt', 'cs-to']]) {
      await pick(k, bal);
      await quote(amt, ticker);
      ok(true, `hxsend: ${ticker} is quoted in its own ticker with its balance and Max (${await line()})`);
      await p.click('#hx-go');
      await until(p, ([s, a, t, v, w]) => document.querySelector(`#sheet-${s}[open] #${a}`)?.value === v && document.querySelector(`#${t}`)?.value === w, [sheet, amtId, toId, amt, to], 120000)
        .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | form: ${await p.evaluate(() => [...document.querySelectorAll('dialog[open]')].map((d) => d.id).join())}`); });
      ok(true, `hxsend: ${ticker}'s button opens its form with the amount and the recipient`);
    }
    // Recipients a send was started to are offered again under an empty field, and an address paid in the public token is not one of them.
    await lander(p);
    await p.click('[data-hxm="send"]');
    await p.fill('#hx-rcpt', '');
    await until(p, () => document.querySelectorAll('#hx-recent [data-hxto]').length >= 1, null, 60000);
    ok((await p.$$eval('#hx-recent [data-hxto]', (b) => b.map((x) => x.dataset.hxto))).join() === to, 'hxsend: the recipients a send was started to are offered again under the empty field, once each');
    await p.click('#hx-recent [data-hxto]');
    ok(await p.inputValue('#hx-rcpt') === to && await p.$eval('#hx-recent', (e) => e.hidden), 'hxsend: choosing one fills the field and the list steps aside');
    ok((await p.getAttribute('#hx-rcpt', 'placeholder')) === 'tacit1…, name.wei or 0x…', 'hxsend: the placeholder says an Ethereum address will do');
    // An Ethereum address is paid in the public token: tETH through the Withdraw form, cUSD through its form's address route; the wrong kind of address for an asset is said, and the button waits.
    const eth0 = '0x' + 'ab'.repeat(20), btc0 = 'bc1q' + 'a'.repeat(38);
    await pick('eth', '^0\\.25 tETH · Max');
    await p.fill('#hx-rcpt', eth0);
    await until(p, () => /^A public payment: the address and the amount can be seen\.$/.test((document.querySelector('#hx-q')?.textContent || '').trim()), null, 60000);
    ok(true, 'hxsend: an Ethereum address with no amount yet says the payment is public');
    await p.fill('#hx-amt', '0.1');
    await until(p, () => /^They get [\d.]+ ETH at that address: the relay fee of [\d.]+ tETH comes out of it\.$/.test((document.querySelector('#hx-q')?.textContent || '').trim()), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${await line()}`); });
    ok(await text(p, '#hx-go') === 'Send to the address', `hxsend: tETH to an Ethereum address says it arrives as ETH there (${await line()})`);
    await p.click('#hx-go');
    await until(p, ([x, v]) => document.querySelector('#sheet-eth[open] #o-to')?.value === x && document.querySelector('#o-amt')?.value === v, [eth0, '0.1'], 120000);
    ok(true, 'hxsend: its button opens Withdraw with the address and the amount');
    await pick('eth', '^0\\.25 tETH · Max');
    await p.fill('#hx-rcpt', '0x' + '0'.repeat(40)); await p.fill('#hx-amt', '0.1');
    await until(p, () => document.querySelector('#hx-q')?.classList.contains('warn') && !/^They get/.test(document.querySelector('#hx-q')?.textContent || '') && !/^A public payment/.test(document.querySelector('#hx-q')?.textContent || ''), null, 60000);
    ok(await p.$eval('#hx-go', (b) => b.disabled), `hxsend: the zero address is refused in the card, as the forms refuse it (${await line()})`);
    await pick('cusd', '^25 cUSD · Max');
    await p.fill('#hx-rcpt', eth0); await p.fill('#hx-amt', '15');
    await until(p, () => /^They get [\d.]+ tacUSD at that address/.test((document.querySelector('#hx-q')?.textContent || '').trim()), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${await line()}`); });
    await p.click('#hx-go');
    await until(p, ([x, v]) => document.querySelector('#sheet-borrow[open] #cs-to')?.value === x && document.querySelector('#cs-amt')?.value === v, [eth0, '15'], 120000);
    ok(true, 'hxsend: cUSD to an Ethereum address arrives as tacUSD and opens its form with the address');
    await lander(p);
    await p.click('[data-hxm="send"]');
    await p.selectOption('#hx-sa', 'cusd');
    await p.fill('#hx-rcpt', btc0);
    await until(p, () => /^That is a Bitcoin address\. To pay it, choose BTC\.$/.test((document.querySelector('#hx-q')?.textContent || '').trim()), null, 60000);
    ok(await p.$eval('#hx-go', (b) => b.disabled), 'hxsend: a Bitcoin address typed for cUSD is said, and the button waits');
    await p.selectOption('#hx-sa', 'tacb');
    await p.fill('#hx-rcpt', eth0);
    await until(p, () => /^That is an Ethereum address\./.test((document.querySelector('#hx-q')?.textContent || '').trim()), null, 60000);
    ok(await p.$eval('#hx-go', (b) => b.disabled), 'hxsend: an Ethereum address typed for TAC on Bitcoin is said, and the button waits');
    await p.selectOption('#hx-sa', 'btc');
    await p.fill('#hx-rcpt', btc0);
    await until(p, () => /^A plain Bitcoin payment: public on chain\.$/.test((document.querySelector('#hx-q')?.textContent || '').trim()) && !document.querySelector('#hx-go').disabled, null, 60000);
    ok(true, 'hxsend: a bc1 address is fine for BTC, and said to be a plain, public payment');
    await p.fill('#hx-rcpt', to);
    await until(p, () => /^A silent payment/.test((document.querySelector('#hx-q')?.textContent || '').trim()), null, 60000);
    ok(true, 'hxsend: a tacit1 address for BTC is a silent payment');
    await lander(p);
    await p.click('[data-hxm="send"]');
    await p.selectOption('#hx-sa', 'tacb');
    await p.fill('#hx-rcpt', to); await p.fill('#hx-amt', '3');
    ok(await text(p, '#hx-go') === 'Continue in Pay' && /^Inside the shielded pool on Bitcoin/.test(await line()), `hxsend: TAC on Bitcoin goes on to Pay (${await text(p, '#hx-go')}: ${await line()})`);
    await p.click('#hx-go');
    await until(p, () => /\/pay\//.test(location.pathname), null, 60000);
    ok(urls.some((u) => u.endsWith(`/pay/#tac&to=${encodeURIComponent(to)}&amount=3`)), `hxsend: Pay's link carries the recipient and the amount (${urls.at(-1)})`);
    if (r.errors.length) { fails++; console.log('FAIL hxsend page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
  // A key with cUSD alone: Send opens on it, tETH says there is none and says how to get some, and the button waits.
  const r2 = await openFarmKey('7d7e'.padEnd(64, '5'), { notes: [[CUSD, 2500000000n]], fees });
  const q = r2.page;
  try {
    await lander(q);
    await q.click('[data-hxm="send"]');
    await until(q, () => document.querySelector('#hx-sa')?.value === 'cusd' && /25 cUSD · Max/.test(document.querySelector('#hx-bal')?.textContent || ''), null, 300000);
    ok(true, 'hxsend: a key holding only cUSD opens Send on cUSD');
    await q.selectOption('#hx-sa', 'eth');
    await until(q, () => /No private tETH yet/.test(document.querySelector('#hx-have')?.textContent || ''), null, 60000);
    ok(await q.$eval('#hx-go', (b) => b.disabled) && (await q.$$eval('#hx-have [data-hxin]', (b) => b.map((x) => x.dataset.hxin).join())) === 'shield:ether:defi', 'hxsend: with no tETH the button waits and the line offers making ETH private');
    await q.selectOption('#hx-sa', 'cbtc');
    await until(q, () => /No private cBTC yet/.test(document.querySelector('#hx-have')?.textContent || ''), null, 60000);
    await q.click('#hx-have [data-hxin]');
    ok(await q.$eval('[data-hxm="borrow"]', (b) => b.getAttribute('aria-selected')) === 'true', 'hxsend: Mint some opens the card on Borrow');
    await q.evaluate(() => { location.hash = '#card=send:cusd&to=alice.wei&amt=5'; });
    await until(q, () => document.querySelector('#hx-sa')?.value === 'cusd' && document.querySelector('#hx-rcpt')?.value === 'alice.wei' && document.querySelector('#hx-amt')?.value === '5', null, 60000);
    ok(await q.evaluate(() => location.hash) === '', 'hxsend: a #card=send link fills the card with its asset, recipient and amount');
    // A unified tacit1 address runs to about 270 characters, and a link names it whole; with no asset named the card opens on what the key holds.
    const long = shownAddress('7d7e'.padEnd(64, '5'));
    await q.selectOption('#hx-sa', 'eth');
    await q.evaluate((h) => { location.hash = h; }, `#card=send&to=${encodeURIComponent(long)}`);
    await until(q, (v) => document.querySelector('#hx-rcpt')?.value === v && document.querySelector('#hx-sa')?.value === 'cusd', long, 60000);
    ok(long.length > 200, `hxsend: a link names a ${long.length}-character tacit1 address whole, and an asset left out opens on the cUSD the key holds`);
    // The recipient is said under the field before the hand-off: another key's tacit1 with its ID, this key's own refused, a name nothing is registered on refused.
    await q.fill('#hx-rcpt', to);
    await until(q, (id) => { const e = document.querySelector('#hx-rc'); return !e.hidden && !e.classList.contains('warn') && /ID /.test(e.textContent); }, null, 60000);
    ok(true, `hxsend: a tacit1 address is shown with its ID under the field (${(await text(q, '#hx-rc')).replace(/\s+/g, ' ')})`);
    await q.fill('#hx-rcpt', long);
    ok(await q.$eval('#hx-rc', (e) => e.hidden), 'hxsend: what was said of the last recipient is gone the moment another is typed');
    await until(q, () => { const e = document.querySelector('#hx-rc'); return !e.hidden && e.classList.contains('warn') && /own Tacit address/.test(e.textContent); }, null, 60000);
    ok(true, 'hxsend: this key\'s own address is refused under the field');
    await q.fill('#hx-rcpt', 'no-such-name-zzqx.wei');
    await until(q, () => { const e = document.querySelector('#hx-rc'); return !e.hidden && e.classList.contains('warn') && e.textContent.trim().length > 5 && !/own Tacit address/.test(e.textContent); }, null, 120000);
    ok(true, `hxsend: a name with nothing registered is refused under the field (${(await text(q, '#hx-rc')).replace(/\s+/g, ' ').slice(0, 90)})`);
    // Request a payment: this key's link, for the asset and amount asked for, copied; opened, it is the same payment filled in.
    await q.evaluate(() => { window.__clip = []; navigator.clipboard.writeText = async (t) => { window.__clip.push(t); }; });
    await q.click('#hx-ask');
    await q.fill('#hx-amt', '5');
    ok(/Copy payment link/.test(await text(q, '#hx-go')) && !(await q.$('#hx-rcpt')) && /You ask for/.test(await text(q, '#hx-panel')), 'hxsend: Request a payment asks for an asset and an amount and offers the link');
    await q.click('#hx-go');
    const link = await q.evaluate(() => window.__clip[0] || '');
    ok(link === `${new URL(q.url()).origin}/#card=send:cusd&to=${encodeURIComponent(long)}&amt=5`, `hxsend: the link is this key's tacit1 address with cUSD and 5 (${link.slice(0, 60)}…)`);
    await q.click('#hx-pay');
    await q.evaluate((h) => { location.hash = h; }, new URL(link).hash);
    await until(q, (v) => document.querySelector('#hx-rcpt')?.value === v && document.querySelector('#hx-amt')?.value === '5' && document.querySelector('#hx-sa')?.value === 'cusd', long, 60000);
    ok(true, 'hxsend: opening that link fills Send with the address, cUSD and the amount');
    // A Send button elsewhere on the page opens Send, even after Request was used.
    await q.click('#hx-ask');
    await q.click('#dash-g .di-send[data-hx="send:cusd"]');
    await until(q, () => !!document.querySelector('#hx-rcpt') && /Send privately/.test(document.querySelector('#hx-go')?.textContent || ''), null, 60000);
    ok(true, 'hxsend: a Send button on Your Tacit opens Send, not Request, after Request was used');
    if (r2.errors.length) { fails++; console.log('FAIL hxsend page errors: ' + r2.errors.slice(0, 3).join(' | ')); }
  } finally { await r2.browser.close(); }
});

// A wrap still settling (as the card's two steps leave one): the private farm says the tETH is on its way and does not ask for it again,
// and with no wrap in flight it asks as before.
await step('farmcoming', async () => {
  const r = await openFarmKey('c0de'.padEnd(64, '6'), { notes: [] }, undefined, (page) => page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('tacit-lite-activity-v1', JSON.stringify({ items: [{ id: 'op-wrap-test', kind: 'op', label: 'Wrap 0.05 ETH into tETH', steps: [], status: 'pending', pub: null, dest: null, at: Date.now() }], cleared: 0 })); }
  }));
  const p = r.page;
  try {
    await go(p, '#farm/private-0');
    await until(p, () => !!document.querySelector('#sheet-farm[open] [data-coming]'), null, 300000);
    ok(/Your tETH is on its way/.test(await text(p, '#sheet-farm [data-coming]')), `farmcoming: with a wrap settling, the farm says the tETH is on its way (${(await text(p, '#sheet-farm [data-coming]')).trim().slice(0, 90)})`);
    await go(p, '#private/swap');
    await until(p, () => !!document.querySelector('#sheet-eth[open] [data-coming]'), null, 300000);
    ok(/Your tETH is on its way/.test(await text(p, '#sheet-eth [data-coming]')) && !(await p.$('#sw-first')), 'farmcoming: and the private Swap tab says the same, without offering to make ETH private again');
    if (r.errors.length) { fails++; console.log('FAIL farmcoming page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
  const q = await openFarmKey('c0de'.padEnd(64, '7'), { notes: [] });
  try {
    await go(q.page, '#farm/private-0');
    await until(q.page, () => !!document.querySelector('#sheet-farm[open] [data-join-get]'), null, 300000);
    ok(!(await q.page.$('#sheet-farm [data-coming]')), 'farmcoming: with nothing settling it asks for private tETH as before');
  } finally { await q.browser.close(); }
});

await step('farmsteps', async () => {
  const r = await openFarmKey('57e9'.padEnd(64, '6'), { notes: [[FARM_CETH, 2000000n]], positions: [] });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('[data-farm="pid0"] > button', { timeout: 120000 });
    if (!(await p.$('.farm.open[data-farm="pid0"]'))) await p.click('[data-farm="pid0"] > button');
    await p.waitForSelector('#farm-pid0 [data-sjm="pair"]', { timeout: 300000 });
    const on = (m) => p.$eval(`#farm-pid0 [data-sjm="${m}"]`, (b) => b.getAttribute('aria-selected') === 'true');
    ok(!(await p.$('#farm-pid0 .steps')) && await on('a') && (await text(p, '#sj-go-0')) === 'Farm with tETH' && /About half is swapped to TAC inside the pool/.test(await text(p, '#farm-pid0 .how')),
      `farmsteps: with tETH and no TAC the form opens on tETH alone and says what is swapped (${(await text(p, '#farm-pid0 .how')).trim()})`);
    await p.click('#farm-pid0 [data-sjm="b"]');
    await p.waitForSelector('#farm-pid0 .how [data-join-get="tac"]', { timeout: 30000 });
    ok(/You hold no private TAC/.test(await text(p, '#farm-pid0 .how')) && /farm with tETH alone/.test(await text(p, '#farm-pid0 .how [data-join-one="a"]')), 'farmsteps: the TAC tab with no TAC says where to get it, or to farm with tETH alone');
    await p.click('#farm-pid0 [data-sjm="pair"]');
    await p.waitForSelector('#farm-pid0 [data-join-get="tac"]', { timeout: 30000 });
    ok(/You hold no private TAC/.test(await text(p, '#farm-pid0 .how')) && !(await p.$('#sj-go-0')) && /farm with tETH alone/.test(await text(p, '#farm-pid0 [data-join-one="a"]')), 'farmsteps: both sides with no TAC says where to get it, or to farm with tETH alone');
    await p.click('#farm-pid0 [data-join-get="tac"]');
    await p.waitForSelector('#sheet-tac[open] .farm-back a', { timeout: 30000 });
    ok(!(await p.$('#sheet-farm[open]')) && (await p.getAttribute('.farm-back a', 'href')) === '#farm/private-0' && /tETH \/ TAC/.test(await text(p, '.farm-back')), 'farmsteps: it opens the TAC sheet with a way back to this farm');
    await p.click('.farm-back a');
    await p.waitForSelector('#sheet-farm[open] .farm.open[data-farm="pid0"] [data-join-one="a"]', { timeout: 60000 });
    await p.waitForTimeout(500);
    ok(!(await p.$('.farm-back')), 'farmsteps: back at the same farm, and the way back is gone');
    await p.click('#farm-pid0 [data-join-one="a"]');
    await p.waitForSelector('#sj-go-0', { timeout: 30000 });
    ok(await on('a') && (await text(p, '#sj-go-0')) === 'Farm with tETH', 'farmsteps: and the link opens the form on tETH alone');
    if (r.errors.length) { fails++; console.log('FAIL farmsteps page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// One side alone farms. With tETH and no TAC, Max takes the whole balance and the quote says what is swapped and what both
// sides then add. The press cuts a note of the swap amount, swaps it whole in the farm's pool, cuts what pairs with the
// return at the live ratio (or spends what is left whole when that costs the pool's other LPs less than a cut), and bonds both.
await step('farmzap', async () => {
  const r = await openFarmKey('7a9b'.padEnd(64, '6'), { notes: [[FARM_CETH, 2000000n]], positions: [], swap: true });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('[data-farm="pid0"] > button', { timeout: 120000 });
    if (!(await p.$('.farm.open[data-farm="pid0"]'))) await p.click('[data-farm="pid0"] > button');
    await p.waitForSelector('#sj-max-0', { timeout: 300000 });
    await p.click('#sj-max-0');
    // Cold, the fork fetches the relay-fee quotes' DEX reads slot by slot (see csend): minutes where mainnet takes a second.
    await until(p, () => /Swaps/.test(document.querySelector('#sj-rcpt-0')?.textContent || '') && !document.querySelector('#sj-go-0').disabled, null, 420000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(p, '#sj-rcpt-0')).replace(/\s+/g, ' ')}`); });
    const rc = (await text(p, '#sj-rcpt-0')).replace(/\s+/g, ' ');
    ok((await p.inputValue('#sj-a-0')) === '0.02' && /Swaps\s*0\.0\d+ tETH for about [\d.,]+ TAC/.test(rc) && /Then adds\s*0\.0\d+ tETH \+ [\d.,]+ TAC/.test(rc) && /Relay fee for the swap/.test(rc) && /Relay fee to split your notes/.test(rc) && /Share of the farm/.test(rc) && /Gas, from your Tacit account/.test(rc),
      `farmzap: Max takes the whole balance, and the quote says what is swapped, what both sides add, and the fees (${rc})`);
    await shot(p, 'farmzap');
    await p.click('#sj-go-0');
    await until(p, () => !!window.__join || /err/.test(document.querySelector('#sf-status-0')?.innerHTML || ''), null, 240000);
    const j = await p.evaluate(() => window.__join), calls = await p.evaluate(() => window.__swapCalls);
    if (!j) throw new Error(`no bond: ${await text(p, '#sf-status-0')} ${JSON.stringify(calls)}`);
    const sw = calls.find((c) => c.amountIn), cuts = calls.filter((c) => c.split);
    const poolId = '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00';
    const sel = Buffer.from(keccak_256('pools(bytes32)')).toString('hex').slice(0, 8);
    const w = (await rpc('eth_call', [{ to: '0x000000000Ed1eabD231Be41d93b719056F7febFC', data: '0x' + sel + poolId.slice(2) }, 'latest'])).slice(2);
    const rA = BigInt('0x' + w.slice(3 * 64, 4 * 64)), rB = BigInt('0x' + w.slice(4 * 64, 5 * 64)), a = BigInt(j.a), b = BigInt(j.b), need = b * rA / rB;
    ok(sw && cuts[0] && cuts[0].split === sw.amountIn && sw.noteValue === sw.amountIn && sw.path[0].endsWith(FARM_CTAC) && BigInt(sw.minOut) === BigInt(sw.out) * 99n / 100n && !sw.self,
      `farmzap: a note of the swap amount is cut and swapped whole in the farm's pool, at most 1% under the quote (${JSON.stringify(calls)})`);
    ok(j.aAsset === FARM_CETH && j.bAsset === FARM_CTAC && b === BigInt(sw.out) && a >= need && (a - need) * 250n <= a && a + BigInt(sw.amountIn) <= 2000000n && j.selfSettle === 'function',
      `farmzap: the bond spends the swap's return whole and pairs tETH with it at the live ratio, within what was held (${a} : ${b}, pool ${rA} : ${rB}, swapped ${sw.amountIn})`);
    await until(p, () => /In the farm/.test(document.querySelector('#sf-status-0')?.textContent || ''), null, 60000).catch(() => {});
    ok(/In the farm/.test(await text(p, '#sf-status-0')), `farmzap: the sheet says it is in (${await text(p, '#sf-status-0')})`);
    if (r.errors.length) { fails++; console.log('FAIL farmzap page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// A private pool whose price is far from the market's says so on its card (what 1 ETH buys there, and what it buys at the market), and a deposit of
// tETH alone, which buys the other asset at that price, shows what that costs against the market and waits for it to be accepted.
await step('farmmarket', async () => {
  const CUSD_POOL = '0x5925c0c2954c5b11bedd20e444f0cb22f3827f6197814f97d193e7a44e909da7';
  const r = await openFarmKey('b4d1'.padEnd(64, '6'), { notes: [[FARM_CETH, 2000000n]], positions: [], swap: true, fees: { transfer: 10000, route: 10000 }, reserves: { [CUSD_POOL]: { reserveA: '10000000000', reserveB: '10000000000000' } } }, undefined, async (pg) => {
    await pg.route(/api\.tacit\.finance\/farm\/program/, async (route) => {
      const res = await route.fetch(), j = await res.json(), p1 = j.pools.find((x) => Number(x.pid) === 1);
      if (p1) { p1.reserves.reserveA = '10000000000'; p1.reserves.reserveB = '10000000000000'; }       // 100 tETH against 100,000 cUSD: 1 ETH = 1,000 cUSD
      await route.fulfill({ response: res, json: j });
    });
  });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('[data-farm="pid1"] > button', { timeout: 120000 });
    if (!(await p.$('.farm.open[data-farm="pid1"]'))) await p.click('[data-farm="pid1"] > button');
    await until(p, () => /Price in the pool/.test(document.querySelector('#farm-pid1')?.textContent || ''), null, 120000);
    const facts = (await text(p, '#farm-pid1')).replace(/\s+/g, ' ');
    ok(/Price in the pool\s*1 ETH = 1,000 cUSD · market [\d,]+/.test(facts), `farmmarket: a pool far from the market says what 1 ETH buys there and at the market (${facts.slice(0, 200)})`);
    await p.waitForSelector('#sj-max-1', { timeout: 300000 });
    await p.click('#sj-max-1');
    await until(p, () => /Swaps/.test(document.querySelector('#sj-rcpt-1')?.textContent || ''), null, 420000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(p, '#sj-rcpt-1')).replace(/\s+/g, ' ')}`); });
    const rc = (await text(p, '#sj-rcpt-1')).replace(/\s+/g, ' ');
    ok(/Against the market\s*\d+% of this deposit/.test(rc) && /above the market’s/.test(rc), `farmmarket: tETH alone shows what the swap costs against the market (${rc.slice(0, 240)})`);
    ok(await p.isDisabled('#sj-go-1') && !!(await p.$('#sj-ackv-1')), 'farmmarket: and waits for that to be accepted');
    if (await p.$eval('#sj-ackv-1', (x) => x.type === 'checkbox')) await p.check('#sj-ackv-1'); else await p.fill('#sj-ackv-1', await p.$eval('.ack b', (b) => b.textContent));
    await until(p, () => !document.querySelector('#sj-go-1').disabled, null, 30000);
    ok(true, 'farmmarket: accepted, the deposit can go ahead');
    await shot(p, 'farmmarket');
    if (r.errors.length) { fails++; console.log('FAIL farmmarket page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// The card's Earn tab takes TAC too: a wallet's TAC goes to the public pool (the form's TAC tab, with the amount), private TAC to the pool that
// pairs it (the private form's TAC side, with the amount). Each source lists only the farms it can join.
await step('hxearntac', async () => {
  const hex = 'e7a1'.padEnd(64, '6');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await fundTac(acct, 2000n * 10n ** 18n);
  const r = await openFarmKey(hex, { notes: [[FARM_CTAC, 50000000000n]], positions: [], swap: true, fees: { transfer: 10000, route: 10000 } }, { width: 1280, height: 1100 });
  const p = r.page, closeAll = () => p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  const rows = () => p.$$eval('#hx-routes [data-hxr]', (a) => a.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  try {
    await closeAll();
    await p.click('[data-hxm="earn"]');
    await p.click('[data-pk="hx-from"]'); await p.waitForSelector('.hx-pk-r');
    ok((await p.$$eval('.hx-pk-g', (g) => g.map((x) => x.textContent.trim()).join('|'))) === 'In your wallet|Private' && (await p.$$eval('.hx-pk-r', (r) => r.length)) === 4, 'hxearntac: Earn offers ETH and TAC in the wallet, tETH and TAC private, in those two groups');
    await p.waitForTimeout(700); await shot(p, 'hxearntac-picker'); await p.keyboard.press('Escape');
    await p.selectOption('#hx-from', 'wtac');
    await p.fill('#hx-amt', '1000');
    await until(p, () => document.querySelector('#hx-go')?.textContent === 'Farm with TAC' && /Precision pool/.test(document.querySelector('#hx-routes')?.textContent || ''), null, 240000);
    const wallet = await rows();
    ok(wallet.length === 1 && /Precision pool/.test(wallet[0]) && /%\s*APR/.test(wallet[0]), `hxearntac: a wallet's TAC lists the public pool alone, with its APR (${wallet.join(' | ')})`);
    ok(/2,000/.test(await text(p, '#hx-bal')), `hxearntac: and the balance line is the wallet's TAC (${await text(p, '#hx-bal')})`);
    await p.click('#hx-go');
    await p.waitForSelector('#sheet-farm[open] #pf-tac', { timeout: 120000 }).catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(p, '#farm-precision')).replace(/\s+/g, ' ').slice(-300)} | ${JSON.stringify(await p.evaluate(() => ({ modes: [...document.querySelectorAll('[data-pfm]')].map((b) => b.dataset.pfm + ':' + b.getAttribute('aria-pressed') + b.className), ids: ['pf-amt', 'pf-tac', 'pf-go', 'pf-connect'].filter((i) => document.getElementById(i)) })))}`); });
    await until(p, () => document.querySelector('#pf-tac')?.value === '1000', null, 60000);
    ok(await p.$eval('[data-pfm="tac"]', (b) => b.getAttribute('aria-pressed') === 'true' || b.classList.contains('on') || b.getAttribute('aria-selected') === 'true'), 'hxearntac: its button opens the public form on TAC with the amount in it');
    await closeAll();
    await p.click('[data-hxm="earn"]');
    await p.selectOption('#hx-from', 'tac');
    await p.fill('#hx-amt', '100');
    await until(p, () => document.querySelector('#hx-go')?.textContent === 'Farm privately' && /tETH \/ TAC/.test(document.querySelector('#hx-routes')?.textContent || ''), null, 240000);
    const priv = await rows();
    ok(priv.length === 1 && /tETH \/ TAC/.test(priv[0]) && !/2 steps/.test(priv[0]), `hxearntac: private TAC lists the pool that pairs it alone, in one step (${priv.join(' | ')})`);
    await p.click('#hx-go');
    await p.waitForSelector('#sheet-farm[open] #sj-b-0', { timeout: 300000 });
    await until(p, () => document.querySelector('#sj-b-0')?.value === '100', null, 60000);
    ok(!(await p.$('#sj-a-0')), 'hxearntac: its button opens the TAC pool on the TAC side alone with the amount in it');
    await shot(p, 'hxearn');
    if (r.errors.length) { fails++; console.log('FAIL hxearntac page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// Private cUSD held (borrowed, say): the Borrow sheet offers to farm it, which opens the pool that pairs it on its own side, where it farms alone.
// Where the pool prices cUSD above the market's, selling some into it for tETH shows no cost against the market.
await step('farmcusd', async () => {
  const CUSD_ID = '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d', CBTC_ID = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
  const CUSD_POOL = '0x5925c0c2954c5b11bedd20e444f0cb22f3827f6197814f97d193e7a44e909da7';
  const r = await openFarmKey('c05d'.padEnd(64, '6'), { notes: [[CUSD_ID, 10000000000n], [CBTC_ID, 50000n]], positions: [], swap: true, fees: { transfer: 10000, route: 10000 }, reserves: { [CUSD_POOL]: { reserveA: '10000000000', reserveB: '10000000000000' } } }, undefined, async (pg) => {
    await pg.route(/api\.tacit\.finance\/farm\/program/, async (route) => {
      const res = await route.fetch(), j = await res.json(), p1 = j.pools.find((x) => Number(x.pid) === 1);
      if (p1) { p1.reserves.reserveA = '10000000000'; p1.reserves.reserveB = '10000000000000'; }
      await route.fulfill({ response: res, json: j });
    });
  });
  const p = r.page;
  try {
    await go(p, '#borrow');
    await p.waitForSelector('[data-farm-with="cusd"]', { timeout: 300000 });
    ok(/Private cUSD\s*100/.test(await text(p, '#borrow-body')), 'farmcusd: the Borrow sheet shows the private cUSD held');
    await p.click('[data-farm-with="cusd"]');
    await p.waitForSelector('#sheet-farm[open] #sj-b-1', { timeout: 300000 });
    ok(!(await p.$('#sj-a-1')) && /cUSD/.test(await text(p, '#farm-pid1')), 'farmcusd: its link opens the cUSD pool on the cUSD side alone');
    await p.fill('#sj-b-1', '50');
    await until(p, () => /Swaps\s*50(\.0+)? cUSD for about/.test((document.querySelector('#sj-rcpt-1')?.textContent || '').replace(/\s+/g, ' ')) || /Swaps/.test(document.querySelector('#sj-rcpt-1')?.textContent || ''), null, 420000);
    const rc = (await text(p, '#sj-rcpt-1')).replace(/\s+/g, ' ');
    ok(/Swaps[^T]*cUSD for about [\d.,]+ tETH/.test(rc) && !/Against the market/.test(rc), `farmcusd: selling cUSD into a pool that prices it dear shows no cost against the market (${rc.slice(0, 160)})`);
    await shot(p, 'farmcusd');
    if (r.errors.length) { fails++; console.log('FAIL farmcusd page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// A step the relay has not done when the wait runs out is not a dead end: the line says it is in the relay's queue, how to carry on
// when it is done, and offers to send it from the paying account (what a refused step offers). The cut then goes out with the settle
// handed over, and pressing again carries the chain on to the bond.
await step('farmqueue', async () => {
  const r = await openFarmKey('9c0e'.padEnd(64, '6'), { notes: [[FARM_CETH, 2000000n]], positions: [], swap: true });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('[data-farm="pid0"] > button', { timeout: 120000 });
    if (!(await p.$('.farm.open[data-farm="pid0"]'))) await p.click('[data-farm="pid0"] > button');
    await p.waitForSelector('#sj-max-0', { timeout: 300000 });
    await p.click('#sj-max-0');
    await until(p, () => /Swaps/.test(document.querySelector('#sj-rcpt-0')?.textContent || '') && !document.querySelector('#sj-go-0').disabled, null, 420000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(p, '#sj-rcpt-0')).replace(/\s+/g, ' ')}`); });
    await p.evaluate(() => { window.__swapQueue = 1; });
    await p.click('#sj-go-0');
    await p.waitForSelector('#sf-status-0 [data-selfdo]', { timeout: 240000 });
    const line = (await text(p, '#sf-status-0')).replace(/\s+/g, ' ');
    ok(/Still in the relay’s queue/.test(line) && /goes through on its own/.test(line) && /press the button again to carry on/.test(line) && /Send it from/.test(line),
      `farmqueue: a cut still in the relay's queue says so, how to carry on, and offers the paying account (${line})`);
    ok(!/don’t send it again/.test(line), 'farmqueue: and does not tell the reader not to send it, when sending it is offered');
    await shot(p, 'farmqueue');
    await p.click('#sf-status-0 [data-selfdo]');
    await until(p, () => /Your note is ready/.test(document.querySelector('#sf-status-0')?.textContent || ''), null, 240000);
    const calls = await p.evaluate(() => window.__swapCalls), cuts = calls.filter((c) => c.split);
    ok(cuts.length === 2 && cuts[0].self === false && cuts[1].self === true && cuts[0].split === cuts[1].split, `farmqueue: the offer runs the same cut with the settle handed over (${JSON.stringify(calls)})`);
    // The note is cut: pressing again carries on from it.
    await until(p, () => !document.querySelector('#sj-go-0')?.disabled, null, 240000);
    await p.click('#sj-go-0');
    await until(p, () => !!window.__join || /err/.test(document.querySelector('#sf-status-0')?.innerHTML || ''), null, 300000);
    ok(!!(await p.evaluate(() => window.__join)), `farmqueue: and pressing again goes on to the bond (${(await text(p, '#sf-status-0')).replace(/\s+/g, ' ').slice(0, 160)})`);
    if (r.errors.length) { fails++; console.log('FAIL farmqueue page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// The Shield card's relay tip is the relay's own for the amount typed. It turns on the size while the amount is small (3% of it, up to a
// cap), so a small wrap is not told the tip a large one pays; and nothing is asked before an amount is typed.
await step('hxtip', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const p = r.page, asked = [];
  try {
    await p.route(/\/confidential\/quote\?/, (route) => {
      const wei = BigInt(new URL(route.request().url()).searchParams.get('amountWei') || '0'), cap = 117222807204416n, tip = wei * 3n / 100n < cap ? wei * 3n / 100n : cap;
      asked.push(String(wei));
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ relayFeeEligible: true, recommendedTipRecipient: '0x' + '6c'.repeat(20), tipSplitter: '0x' + '5e'.repeat(20), recommendedWrapTipWei: String(tip) }) });
    });
    await p.goto(r.url);
    await p.waitForSelector('#hx-amt', { timeout: 120000 });
    await p.focus('#hx-amt'); await sleep(1500);
    ok(asked.length === 0, `hxtip: nothing is asked of the relay before an amount is typed (${asked.length})`);
    await p.fill('#hx-amt', '0.003');
    await until(p, () => /relay tip of 0\.00009 ETH/.test(document.querySelector('#hx')?.textContent || ''), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(p, '#hx')).replace(/\s+/g, ' ').slice(-200)}`); });
    ok(true, 'hxtip: a 0.003 ETH wrap says its tip is 0.00009 ETH (3% of it)');
    await p.fill('#hx-amt', '0.1');
    await until(p, () => /relay tip of 0\.000117 ETH/.test(document.querySelector('#hx')?.textContent || ''), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(p, '#hx')).replace(/\s+/g, ' ').slice(-200)}`); });
    ok(asked.includes('3000000000000000') && asked.includes('100000000000000000'), `hxtip: and a 0.1 ETH wrap says the capped figure, each amount asked for itself (${asked.join(', ')})`);
    if (r.errors.length) { fails++; console.log('FAIL hxtip page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// A harvest or an unbond still in the relay's queue when the wait runs out is offered from the paying account, as a refused one is.
await step('farmheld', async () => {
  const r = await openFarmKey('b3d1'.padEnd(64, '6'), { notes: [], positions: [farmPos(7, 150000000, 1234560000, '12.3456')], chain: true, refuse: true });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('[data-harvest="0"]', { timeout: 300000 });
    await p.evaluate(() => { window.__farmQueue = true; });
    await p.click('[data-harvest="0"]');
    await p.waitForSelector('#sf-act-0 [data-selfdo]', { timeout: 120000 });
    const line = (await text(p, '#sf-act-0')).replace(/\s+/g, ' ');
    ok(/Still in the relay’s queue/.test(line) && /goes through on its own/.test(line) && /Send it from/.test(line) && !/don’t send it again/.test(line), `farmheld: a harvest still in the relay's queue offers the paying account (${line})`);
    await p.click('#sf-act-0 [data-selfdo]');
    await until(p, () => /Harvested to a wTAC note/.test(document.querySelector('#sf-act-0')?.textContent || ''), null, 240000);
    const calls = await p.evaluate(() => window.__farmCalls);
    ok(calls.includes('refused:farmHarvest') && calls.includes('self:farmHarvest') && calls.includes(`harvest:0x${'7'.repeat(64)}`), `farmheld: and the offer runs the same harvest with the settle handed over (${calls.join(', ')})`);
    if (r.errors.length) { fails++; console.log('FAIL farmheld page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// A zap stopped part-way leaves its notes cut to the plan: one of exactly what is swapped and one that pairs with its return. Max takes
// both whole, the quote says nothing is split again, and the press swaps the first and bonds the second with no cut at all.
await step('farmreuse', async () => {
  const poolId = '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00';
  const sel = Buffer.from(keccak_256('pools(bytes32)')).toString('hex').slice(0, 8);
  const w = (await rpc('eth_call', [{ to: '0x000000000Ed1eabD231Be41d93b719056F7febFC', data: '0x' + sel + poolId.slice(2) }, 'latest'])).slice(2);
  const rA = BigInt('0x' + w.slice(3 * 64, 4 * 64)), rB = BigInt('0x' + w.slice(4 * 64, 5 * 64));
  const fr = 40000n, fee = 41000n, G = 9970n, x = 1000000n, y = x - fr;                       // the pool's 30 bp fee; the fees the stub fixes
  const out = rB * y * G / (rA * 10000n + y * G), pair = out * (rA + y) / (rB - out), m = pair + 7n;
  const r = await openFarmKey('4d2a'.padEnd(64, '6'), { notes: [[FARM_CETH, x], [FARM_CETH, m]], positions: [], swap: true, fees: { transfer: Number(fee), route: Number(fr) } });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('[data-farm="pid0"] > button', { timeout: 120000 });
    if (!(await p.$('.farm.open[data-farm="pid0"]'))) await p.click('[data-farm="pid0"] > button');
    await p.waitForSelector('#sj-max-0', { timeout: 300000 });
    await p.evaluate(() => { window.__poolMoves = true; });             // after the swap the pool's ratio is the one the pair note is sized for
    await p.click('#sj-max-0');
    await until(p, () => /Swaps/.test(document.querySelector('#sj-rcpt-0')?.textContent || '') && !document.querySelector('#sj-go-0').disabled, null, 420000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | ${(await text(p, '#sj-rcpt-0')).replace(/\s+/g, ' ')}`); });
    const rc = (await text(p, '#sj-rcpt-0')).replace(/\s+/g, ' '), typed = Math.round(parseFloat(await p.inputValue('#sj-a-0')) * 1e8);
    ok(typed === Number(x + m) && /Uses the two notes already made/.test(rc) && !/Relay fee to split your notes/.test(rc) && /Relay fee for the swap/.test(rc),
      `farmreuse: Max takes both notes whole (${typed} of ${x + m}), and the quote says nothing is split again (${rc})`);
    await shot(p, 'farmreuse');
    await p.click('#sj-go-0');
    await until(p, () => !!window.__join || /err/.test(document.querySelector('#sf-status-0')?.innerHTML || ''), null, 240000);
    const j = await p.evaluate(() => window.__join), calls = await p.evaluate(() => window.__swapCalls);
    if (!j) throw new Error(`no bond: ${await text(p, '#sf-status-0')} ${JSON.stringify(calls)}`);
    const sw = calls.find((c) => c.amountIn);
    ok(calls.filter((c) => c.split).length === 0 && sw && BigInt(sw.amountIn) === x && BigInt(sw.noteValue) === x && BigInt(j.a) === m && BigInt(j.b) === BigInt(sw.out),
      `farmreuse: no note is cut: the first is swapped whole and the second bonded whole with the swap's return (${JSON.stringify(calls)} ${j.a} ${j.b})`);
    if (r.errors.length) { fails++; console.log('FAIL farmreuse page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// Exit is one press: harvest what is worth harvesting, unbond (giving up what the position earned while the harvest settled,
// which a plain unbond refuses), take the liquidity out. The steps are named as they run, and what is left is a position gone,
// both assets as private notes, and the rewards as wTAC.
await step('farmexit', async () => {
  const r = await openFarmKey('e817'.padEnd(64, '6'), { notes: [], positions: [farmPos(7, 150000000, 1234560000, '12.3456')], chain: true });
  const p = r.page, leaf = '0x' + '7'.repeat(64);
  try {
    await go(p, '#farm');
    await p.waitForSelector('.farm.open[data-farm="pid0"] [data-exit]', { timeout: 300000 });
    const card = (await text(p, '#farm-pid0')).replace(/\s+/g, ' ');
    ok(/Exit takes everything out/.test(card) && /earns while those steps run \(about [\d.,]+ TAC a minute\) is given up/.test(card), 'farmexit: Exit says what it does and what it gives up');
    await shot(p, 'farmexit-before');
    await p.evaluate(() => { window.__seen = new Set(); setInterval(() => window.__seen.add((document.querySelector('#sf-act-0')?.textContent || '').trim()), 80); });
    await p.click('[data-exit="0"]');
    await until(p, () => /^Out\./.test(document.querySelector('#sf-act-0')?.textContent.trim() || '') || !!document.querySelector('#sf-act-0 .err'), null, 120000);
    const calls = await p.evaluate(() => window.__farmCalls), seen = await p.evaluate(() => [...window.__seen].filter(Boolean));
    ok(JSON.stringify(calls) === JSON.stringify([`harvest:${leaf}`, `unbond:${leaf}:forfeit`, 'remove:150000000']), `farmexit: harvest, then unbond giving up the little accrued since, then take the liquidity out (${calls.join(', ')})`);
    ok(seen.some((t) => /^Step 1 of 3 · .*harvest/.test(t)) && seen.some((t) => /^Step 2 of 3 · .*unbond/.test(t)) && seen.some((t) => /^Step 3 of 3 · .*liquidity out/.test(t)), `farmexit: each step names itself as it runs (${seen.map((t) => t.slice(0, 28)).join(' | ')})`);
    await shot(p, 'farmexit-after');
    await until(p, () => !document.querySelector('[data-exit]') && /Harvested rewards\s*12\.35 wTAC/.test(document.querySelector('#farm-notes')?.textContent || ''), null, 120000);
    ok(true, 'farmexit: the position is gone, and the rewards wait as wTAC notes');
    if (r.errors.length) { fails++; console.log('FAIL farmexit page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});
// Claim rewards is one press too: every position with a real reward is harvested (not one holding dust), then what is harvested
// is turned into TAC. On the fork the paying account has no wTAC to withdraw, so the chain ends where it says the wTAC is not visible.
await step('farmclaim', async () => {
  const r = await openFarmKey('c1a1'.padEnd(64, '6'), { notes: [], positions: [farmPos(7, 150000000, 1234560000, '12.3456'), farmPos(8, 20000000, 50000, '0.0005')], chain: true });
  const p = r.page;
  try {
    await go(p, '#farm');
    await p.waitForSelector('#fn-redeem', { timeout: 300000 });
    ok(/Claim rewards/.test(await text(p, '#fn-redeem')) && /harvests every position whose reward is worth turning into TAC/.test(await text(p, '#farm-notes')), 'farmclaim: with rewards unharvested the button says Claim rewards, and what it does');
    await p.click('#fn-redeem');
    await until(p, () => /wTAC is not visible yet|Your rewards are TAC/.test(document.querySelector('#fn-status')?.textContent || ''), null, 180000);
    const calls = await p.evaluate(() => window.__farmCalls);
    ok(JSON.stringify(calls) === JSON.stringify([`harvest:0x${'7'.repeat(64)}`, 'redeem:1234560000']), `farmclaim: the position with a real reward is harvested, the one with dust is not, then the wTAC is unwrapped (${calls.join(', ')})`);
    if (r.errors.length) { fails++; console.log('FAIL farmclaim page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The landing card's Bitcoin tab, going out: what it offers follows what is switched on (TAC's own setting, tETH's own), TAC is quoted at its
// own relay floor and limits, the button opens the TAC sheet's To Bitcoin side with the amount, and a key short of private TAC is sent to make
// some first. The key holds 62 TAC privately (50 and 12).
await step('hxout', async () => {
  const r = await openFarmKey('6e7b'.padEnd(64, '6'), { notes: [['@cTAC', 5000000000n], ['@cTAC', 1200000000n]] }, undefined, async (page) => { await page.addInitScript(() => { localStorage.setItem('tacit-tac-btc', 'true'); localStorage.setItem('tacit-teth-btc', 'false'); }); await page.route(/^https:\/\/api\.tacit\.finance\/confidential\/quote\?asset=cTAC/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ticker: 'cTAC', staticFloorUnits: '400000000' }) })); });
  const p = r.page;
  const lander = () => p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  const body = async () => (await text(p, '#hx-body')).replace(/\s+/g, ' ');
  // Shield names what is held, then the ways it can go: the Bitcoin legs are ways, and each follows its own setting.
  const sourceValues = () => p.$$eval('#hx-from option', (o) => o.map((x) => x.value).join());
  const waysOf = async (src) => { await p.selectOption('#hx-from', src); return p.$$eval('#hx-dest [data-hxd], #hx-dest .hx-r', (r) => r.map((x) => x.dataset.hxd || 'back').join()); };
  const repaint = async () => { await p.click('[data-hxm="swap"]'); await p.click('[data-hxm="private"]'); };
  try {
    await lander();
    await p.click('[data-hxm="private"]'); await p.selectOption('#hx-from', 'tac');
    ok(!!(await p.$('[data-hxd="btc"]')), 'hxout: with TAC to Bitcoin switched on, private TAC has a way to Bitcoin');
    await until(p, () => document.querySelector('#hx-go')?.textContent === 'Bridge TAC to Bitcoin', null, 120000);
    ok((await sourceValues()) === 'ether,btc,eth,tac,pp' && (await waysOf('ether')) === 'defi,pay' && (await waysOf('eth')) === 'wallet' && (await waysOf('tac')) === 'btc,wallet', `hxout: with only TAC on, only TAC has a way to Bitcoin (${await sourceValues()})`);
    await p.selectOption('#hx-from', 'tac');
    await p.fill('#hx-amt', '25');
    await until(p, () => document.querySelector('#hx-out')?.textContent === '21' && /to cut a note of this size/.test(document.querySelector('#hx-q')?.textContent || ''), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | q: ${await text(p, '#hx-q').catch(() => '?')} | out: ${await text(p, '#hx-out').catch(() => '?')} | dash: ${(await text(p, '#dash-g').catch(() => '?')).replace(/\s+/g, ' ').slice(0, 200)}`); });
    const line = (await text(p, '#hx-q')).replace(/\s+/g, ' ');
    ok(line === 'Relay fee 4 TAC (8 TAC if its floor has moved), and 2 TAC to cut a note of this size, plus a Bitcoin fee in sats from your Bitcoin address; 20 to 1,000 TAC a bridge while this is new. Usually a few hours, sometimes up to a day.', `hxout: 25 TAC arrives as 21 (the relay's 4 TAC floor, 8 TAC if it has moved), the cut of a note of that size, the limits and the time are said (${line.slice(0, 260)})`);
    await p.click('#hx-go');
    await until(p, () => location.hash === '#bridge/out' && !!document.querySelector('#bridge-body [data-brm="out"][aria-selected="true"]') && document.querySelector('#xt-amt')?.value === '25', null, 120000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | hash: ${await p.evaluate(() => location.hash)} | body: ${(await text(p, '#bridge-body')).replace(/\s+/g, ' ').slice(0, 200)} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(true, 'hxout: the button opens the TAC sheet on its To Bitcoin side, with the amount in the form');
    // Outside what a bridge takes: no figure is promised, and the limits are said.
    await lander();
    // Each amount's own answer (the card shows a quote still out as coming, never the last amount's): 5,000 is also more than the 62 held.
    const limits = 'A bridge takes 20 to 1,000 TAC while this is new.';
    for (const [v, said] of [['5', limits], ['5000', `You hold 62 private TAC, less than this: make TAC private first. ${limits}`]]) {
      await p.fill('#hx-amt', v);
      await until(p, (x) => document.querySelector('#hx-out')?.textContent === '—' && (document.querySelector('#hx-q')?.textContent || '').trim() === x, said, 240000)
        .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | at ${v}: ${await body()}`); });
    }
    ok(true, 'hxout: 5 TAC and 5,000 TAC are not quoted, and the limits are said (5,000 TAC also says what is held)');
    // 61 of the 62 held, with no note exactly that size: the 2 TAC to cut one cannot also come out of what is left, as the sheet will say.
    await p.fill('#hx-amt', '61');
    await until(p, () => document.querySelector('#hx-out')?.textContent === '—' && /^The most you can use is 60 TAC: the relay fee to cut a note of this size comes out of it\.$/.test((document.querySelector('#hx-q')?.textContent || '').trim()), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | at 61: ${await body()}`); });
    ok(true, 'hxout: 61 of 62 TAC held is not quoted, and the most that can be used is said');
    // More than the 62 TAC held: the card says so and sends the holder to make TAC private.
    await lander();
    await p.fill('#hx-amt', '70');
    await until(p, () => document.querySelector('#hx-go')?.textContent === 'Make TAC private' && /You hold 62 private TAC, less than this: make TAC private first\./.test(document.querySelector('#hx-q')?.textContent || ''), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | card: ${await body()}`); });
    ok(true, 'hxout: more than the private TAC held says what is held and offers to make TAC private');
    await p.click('#hx-go');
    await until(p, () => !!document.querySelector('#sheet-tac[open]'), null, 120000);
    const hash = await p.evaluate(() => location.hash);
    ok(hash !== '#sell', `hxout: and the button opens the TAC sheet, where TAC is made private at the top, not on its Sell tab (${hash})`);
    // Both switched on: ETH, tETH and TAC are offered, and each is quoted as itself.
    await lander();
    await p.evaluate(() => localStorage.setItem('tacit-teth-btc', 'true'));
    await repaint();
    const both = [await waysOf('ether'), await waysOf('eth'), await waysOf('tac')];
    ok(both.join(' | ') === 'defi,pay,btc | wallet,btc | btc,wallet' && (await sourceValues()) === 'ether,btc,eth,tac,pp,tb', `hxout: with both on it can send ETH (made tETH first), tETH or TAC to Bitcoin (${both.join(' | ')})`);
    await p.selectOption('#hx-from', 'eth'); await p.click('[data-hxd="btc"]');
    await p.fill('#hx-amt', '0.04');
    await until(p, () => /tETH a bridge while this is new/.test(document.querySelector('#hx-q')?.textContent || '') && document.querySelector('#hx-go')?.textContent !== 'Bridge TAC to Bitcoin', null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | card: ${await body()}`); });
    const tethLine = (await text(p, '#hx-q')).replace(/\s+/g, ' ');
    ok(/Relay fee [\d.]+ tETH, plus a Bitcoin fee in sats from your Bitcoin address; [\d.]+ to [\d.]+ tETH a bridge while this is new\. Usually a few hours, sometimes up to a day\./.test(tethLine) && !/TAC/.test(tethLine), `hxout: tETH is quoted as tETH, in its own words, with the time the sheet gives (${tethLine.slice(0, 200)})`);
    // The picker has the focus when it changes from tETH to TAC, and keeps it through the redraw that causes.
    await p.focus('#hx-from');
    await p.selectOption('#hx-from', 'tac');
    await until(p, () => document.querySelector('#hx-go')?.textContent === 'Bridge TAC to Bitcoin', null, 120000);
    ok((await p.evaluate(() => document.activeElement?.id)) === 'hx-from', 'hxout: the focus stays on the picker after it redraws the card');
    await p.fill('#hx-amt', '25');
    await until(p, () => /20 to 1,000 TAC a bridge while this is new/.test(document.querySelector('#hx-q')?.textContent || ''), null, 120000);
    const tacLine = (await text(p, '#hx-q')).replace(/\s+/g, ' ');
    ok(/Relay fee 4 TAC/.test(tacLine) && !/tETH/.test(tacLine), `hxout: and TAC as TAC (${tacLine.slice(0, 120)})`);
    // Turned back to bringing TAC in, the card names the way out for all the assets it now has.
    await p.click('#hx-flip');
    await until(p, () => document.querySelector('#hx-go')?.textContent === 'Bridge TAC from Bitcoin', null, 60000);
    ok((await p.$eval('#hx-from', (e) => e.value)) === 'btc', 'hxout: reversing TAC to Bitcoin is TAC from Bitcoin');
    await p.click('#hx-flip');
    await until(p, () => document.querySelector('#hx-go')?.textContent === 'Bridge TAC to Bitcoin', null, 60000);
    // Only tETH on: TAC is not offered.
    await p.evaluate(() => localStorage.setItem('tacit-tac-btc', 'false'));
    await repaint();
    const only = [await waysOf('ether'), await waysOf('eth'), await waysOf('tac')];
    ok(only.join(' | ') === 'defi,pay,btc | wallet,btc | wallet', `hxout: with only tETH on, TAC has no way to Bitcoin (${only.join(' | ')})`);
    // Neither on: the tab only brings TAC in.
    await p.evaluate(() => localStorage.setItem('tacit-teth-btc', 'false'));
    await repaint();
    const none = [await waysOf('ether'), await waysOf('eth'), await waysOf('tac'), await waysOf('btc')];
    ok(none.join(' | ') === 'defi,pay | wallet | wallet | eth,pool' && !(await p.$('#hx-flip')), `hxout: with both switched off nothing goes to Bitcoin: it only brings TAC in (${none.join(' | ')})`);
    // Nothing set: both are on, so ETH, tETH and TAC are all offered.
    await p.evaluate(() => { localStorage.removeItem('tacit-teth-btc'); localStorage.removeItem('tacit-tac-btc'); });
    await repaint();
    const dflt = [await waysOf('ether'), await waysOf('eth'), await waysOf('tac')];
    ok(dflt.join(' | ') === 'defi,pay,btc | wallet,btc | btc,wallet', `hxout: with nothing set both are on, and ETH, tETH and TAC go to Bitcoin (${dflt.join(' | ')})`);
    if (r.errors.length) { fails++; console.log('FAIL hxout page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The card's TAC out pressed with no key open: the Bridge tab asks for the key, still addressed as the way out, and once the key is open it is on
// the To Bitcoin side with the amount in.
await step('hxlink', async () => {
  const r = await openPage({ account: A0, key: K0 });
  await stubFarmUx(r.page, { notes: [['@cTAC', 5000000000n], ['@cTAC', 1200000000n]] });
  await r.page.addInitScript(() => { localStorage.setItem('tacit-tac-btc', 'true'); localStorage.setItem('tacit-teth-btc', 'false'); });
  await r.page.route(/^https:\/\/api\.tacit\.finance\/confidential\/quote\?asset=cTAC/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ticker: 'cTAC', staticFloorUnits: '400000000' }) }));
  const p = r.page;
  try {
    await p.goto(r.url);
    await p.waitForSelector('[data-hxm="private"]', { timeout: 120000 });
    await p.click('[data-hxm="private"]'); await p.selectOption('#hx-from', 'tac');
    await until(p, () => document.querySelector('#hx-go')?.textContent === 'Bridge TAC to Bitcoin', null, 60000);
    await p.fill('#hx-amt', '25');
    await until(p, () => document.querySelector('#hx-out')?.textContent === '21', null, 120000);
    await p.click('#hx-go');
    await until(p, () => !!document.querySelector('#sheet-tac[open] #bridge-body-in'), null, 60000);
    const hash = await p.evaluate(() => location.hash);
    ok(hash === '#bridge/out', `hxlink: with no key open the button opens the Bridge tab, which asks for one, still addressed as the way out (${hash})`);
    await p.click('#bridge-body [data-in="paste"]');
    await p.fill('#bridge-body-hex', '6e7b'.padEnd(64, '9'));
    await p.click('#bridge-body [data-in="key"]');
    await until(p, () => !!document.querySelector('#bridge-body [data-brm="out"][aria-selected="true"]') && document.querySelector('#xt-amt')?.value === '25', null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | hash ${await p.evaluate(() => location.hash)} | body: ${(await text(p, '#bridge-body')).replace(/\s+/g, ' ').slice(0, 240)}`); });
    ok((await p.evaluate(() => location.hash)) === '#bridge/out', 'hxlink: and with the key open it is on the To Bitcoin side, with the 25 TAC in the form');
    if (r.errors.length) { fails++; console.log('FAIL hxlink page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The hero's panel: each verb's button opens the form that does it with the amount in. A route from ETH into the private
// pool is one step when the tETH held covers it; otherwise the ETH is made private first, and the wrap's sheet offers the
// second step at its top, which opens with the same amount.
await step('hxpanel', async () => {
  const r = await openFarmKey('4a7e'.padEnd(64, '6'), { notes: [[FARM_CETH, 5000000n], [FARM_CETH, 5000000n]], swap: true });
  const p = r.page;
  const val = (sel) => p.evaluate((s) => document.querySelector(s)?.value ?? null, sel);
  const press = async (mode, amt, route, label) => {
    await p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
    await p.click(`[data-hxm="${mode}"]`);
    if (amt != null) await p.fill('#hx-amt', amt);
    if (route) { await p.waitForSelector(`[data-hxr="${route}"]`, { timeout: 600000 }); await p.click(`[data-hxr="${route}"]`); }
    // The private balance is read on a cold fork first. A wait that runs out says what the panel showed.
    await until(p, (l) => document.querySelector('#hx-go')?.textContent === l, label, 900000).catch(async (e) => {
      console.log('     panel:', JSON.stringify(await p.evaluate(() => ['#hx-go', '#hx-out', '#hx-routes', '#hx-q', '#wallet-dot'].map((s) => `${s}=${(document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').slice(0, 160)}`))));
      throw e;
    });
    await p.click('#hx-go');
  };
  const form = (sel, v) => until(p, ([s, x]) => document.querySelector(s)?.value === x, [sel, v], 120000).then(() => true, () => false);
  try {
    await press('swap', '0.01', 'private', 'Swap privately');
    ok(await form('#sw-amt', '0.01') && await p.$eval('#sheet-eth [data-v1="swap"]', (b) => b.getAttribute('aria-selected') === 'true'), 'hxpanel: ETH to TAC through the private pool, with tETH held, is one step: the swap form opens with the amount');
    await press('swap', '1', 'private', 'Make ETH private');
    ok(await form('#w-amt', '1') && /Then swap it for TAC/.test(await text(p, '#sheet-eth .farm-back')), `hxpanel: more than the tETH held makes the ETH private first, and the wrap's sheet names the swap next (${(await text(p, '#sheet-eth .farm-back')).trim()})`);
    await p.click('#sheet-eth .farm-back a');
    ok(await form('#sw-amt', '1') && !(await p.$('#sheet-eth .farm-back')), 'hxpanel: the second step opens the swap with the same amount, and the line is gone');
    await press('swap', '0.05', 'public', 'Buy TAC');
    ok(await form('#b-amt', '0.05'), 'hxpanel: the public route opens Buy TAC with the amount');
    await press('earn', '0.05', null, 'Farm with ETH');
    ok(await form('#pf-amt', '0.05'), 'hxpanel: Earn opens the public farm with the ETH in');
    await press('earn', '0.01', '0', 'Farm privately');
    ok(await form('#sj-a-0', '0.01'), 'hxpanel: a private farm, with tETH held, opens on tETH alone with the amount');
    // More than the tETH held: the ETH is made private first, and the wrap's sheet names the farm next, which then opens with the same amount.
    await press('earn', '1', '0', 'Make ETH private');
    ok(await form('#w-amt', '1') && /Then farm it in/.test(await text(p, '#sheet-eth .farm-back')), `hxpanel: a private farm for more than the tETH held makes the ETH private first, and names the farm next (${(await text(p, '#sheet-eth .farm-back')).trim()})`);
    await p.click('#sheet-eth .farm-back a');
    ok(await form('#sj-a-0', '1') && !!(await p.$('#sheet-farm[open]')), 'hxpanel: the second step opens that farm on tETH alone with the same amount');
    // The card's points figure for a wrap is the Private sheet's own: the same number, before and after the hand-off.
    await p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
    await p.click('[data-hxm="private"]'); await p.fill('#hx-amt', '0.02');
    // The amount carries over from the last tab, so the figure for it comes first: wait for this amount's own.
    await until(p, () => document.querySelector('#hx-out')?.textContent === '0.02' && !document.querySelector('#hx-pts')?.hidden && /≈ [\d,]+/.test(document.querySelector('#hx-pts b')?.textContent || ''), null, 120000);
    const figure = (t) => (t.match(/≈\s*([\d,]+)/) || [])[1];
    const onCard = figure(await text(p, '#hx-pts b'));
    await until(p, () => document.querySelector('#hx-go')?.textContent === 'Make ETH private', null, 120000);
    await p.click('#hx-go');
    ok(await form('#w-amt', '0.02') && !(await p.$('#sheet-eth .farm-back')), 'hxpanel: Private opens the wrap with the amount and no second step');
    await until(p, () => /≈\s*[\d,]+/.test(document.querySelector('#w-rcpt [data-pts] b')?.textContent || ''), null, 120000);
    const onSheet = figure(await text(p, '#w-rcpt [data-pts] b'));
    ok(onCard && onCard === onSheet, `hxpanel: the card and the Private sheet estimate the same points for 0.02 ETH (${onCard} and ${onSheet})`);
    if (r.errors.length) { fails++; console.log('FAIL hxpanel page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The card's note on the week's multiplier, from a wallet's own scored rows (the service's /points answer stubbed): a swap
// yesterday plus a private deposit today is two kinds on two days, x1.5, and the next step is named; a deposit too small to
// count as a kind says nothing about the week.
await step('hxweek', async () => {
  const yesterday = Math.floor(Date.now() / 1000) - 86400;
  const rows = [{ tx_hash: '0x' + '11'.repeat(32), block_number: 1, block_time: yesterday, amount_wei: '100000000000000000', prior_deposit_count: 0, points: 100, tip_wei: null, tip_recipient: null, pp_boosted: false, activity: 'zswapeth', tac_boost: 1, z_share_boost: 1, chain_id: 1 }];
  const r = await openFarmKey('7e4b'.padEnd(64, '6'), { notes: [] }, undefined, (page) => page.route(/api\.tacit\.finance\/points\/0x[0-9a-fA-F]{40}$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ address: '0x' + '00'.repeat(20), points: 100, deposit_count: 1, amount_wei: '0', today: null, deposits: rows }) })));
  const p = r.page;
  try {
    await p.waitForSelector('#hx-body .hx-h');
    await p.click('[data-hxm="private"]'); await p.fill('#hx-amt', '0.02');
    await until(p, () => /Counts ×1\.5 toward/.test(document.querySelector('#hx-pts')?.textContent || ''), null, 300000);   // the card waits for the Points reading made at sign-in
    const tip = (await text(p, '#hx-pts')).replace(/\s+/g, ' ');
    ok(/Counts ×1\.5 toward today’s pot\. A loan or a \.wei name this week lifts it to ×1\.75\./.test(tip), `hxweek: yesterday's swap and today's private deposit count x1.5, and the next kind is named (${tip.slice(0, 200)})`);
    if (SHOTS) await (await p.$('#hx')).screenshot({ path: join(SHOTS, 'weld-hxweek.png') });
    await p.fill('#hx-amt', '0.0001');
    await until(p, () => document.querySelector('#hx-out')?.textContent === '0.0001' && !document.querySelector('#hx-pts')?.hidden, null, 120000);
    const small = (await text(p, '#hx-pts')).replace(/\s+/g, ' ');
    ok(/< 1 TAC points/.test(small) && !/Counts ×/.test(small) && !/: 0 more/.test(small), `hxweek: a deposit too small to count as a kind says nothing of the week (${small.slice(0, 120)})`);
    // A key with nothing on Bitcoin is told so, and where to receive it.
    await p.click('[data-hxm="private"]'); await p.selectOption('#hx-from', 'btc');
    await until(p, () => /No TAC on this key’s Bitcoin address yet/.test(document.querySelector('#hx-have')?.textContent || ''), null, 240000);
    ok(!!(await p.$('#hx-have a[data-link="bitcoin/receive"]')), `hxweek: a key with no TAC on Bitcoin is told so, with the way to receive it (${(await text(p, '#hx-have')).replace(/\s+/g, ' ').slice(0, 120)})`);
    if (r.errors.length) { fails++; console.log('FAIL hxweek page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// What each action on the console says it earns in the points program, by the terms the service states (stubbed here, so a pass shows they
// are read and not echoed): a deposit for payments, whose "how?" names the share limit on pool deposits; a swap's routes, where only the
// Precision pool's share scores; and the two ways of borrowing, one naming the loan and the bond, the other the bond alone.
await step('hxearn', async () => {
  const today = Math.floor(Date.now() / 86400e3);
  const program = { startDay: today - 8, days: 90, dayBudgetWei: '1111111111111111111111', totalWei: '100000000000000000000000', earlyBonus: { max: 5, halfLife: 200 }, tethWrapBoost: 1.25,
    holder: { tiers: [{ tac: 100, multiplier: 1.25 }], windowHours: 24 }, rates: { wrap: 1250, evmpooldeposit: 1000, zswapeth: 1000, cbtcmint: 1000, cusdmint: 2, cbtchold: 500 },
    weights: [{ fromDay: today - 1, weights: {} }], categoryShareCaps: [{ fromDay: today - 1, caps: { evmpooldeposit: 0.4 } }], bondHoldFromDay: today - 1, cbtcHoldFromDay: today - 1,
    kinds: { wrap: 'private', evmpooldeposit: 'private', zswapeth: 'swap', cbtcmint: 'borrow', cbtchold: 'borrow', cusdmint: 'borrow' } };
  const stub = (page) => page.route(/api\.tacit\.finance\/leaderboard/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(/day=today/.test(route.request().url()) ? { day: today, programDay: 9, programDays: 90, program, totalPoints: 1000, dayBudgetWei: '1111111111111111111111', taking: 1, rows: [] } : []) }));
  const r = await openFarmKey('7e4b'.padEnd(64, '6'), { notes: [] }, undefined, stub);
  const p = r.page, line = async () => (await text(p, '#hx-pts')).replace(/\s+/g, ' ').trim();
  try {
    await p.waitForSelector('#hx-body .hx-h');
    // The program's terms reach the page with the Points reading; the console reads them from there.
    await p.evaluate(() => { location.hash = '#points'; });
    await until(p, () => /together up to 40%/.test(document.querySelector('#pts-body')?.textContent || ''), null, 120000);
    await p.keyboard.press('Escape');
    await p.evaluate(() => { location.hash = ''; });
    await p.waitForSelector('#hx-body .hx-h');
    // A deposit for payments: the estimate, and in its "how?" the share limit that pool deposits are under.
    await p.click('[data-hxm="private"]'); await p.click('[data-hxd="pay"]'); await p.fill('#hx-amt', '0.5');
    await until(p, () => /TAC points/.test(document.querySelector('#hx-pts')?.textContent || ''), null, 120000);
    await p.click('#hx-pts [data-ptsinfo]');
    const how = await line();
    ok(/Deposits in the ETH pools together take at most 40% of a day’s 1,111 TAC\./.test(how.replace(/'/g, '’')), `hxearn: a pool deposit's "how?" names the share limit (${how.slice(-200)})`);
    // A deposit into the Tacit pool is a different activity, and is not under it.
    await p.click('[data-hxd="defi"]');
    await until(p, () => /TAC points/.test(document.querySelector('#hx-pts')?.textContent || ''), null, 120000);
    ok(!/together take at most/.test(await line()), `hxearn: a wrap into the Tacit pool does not carry the limit of pool deposits`);
    // Borrow: the cUSD way names the loan and the bond; the cBTC way the bond alone.
    await p.click('[data-hxm="borrow"]');
    await until(p, () => /Borrow cUSD:/.test(document.querySelector('#hx-pts')?.textContent || ''), null, 60000);
    let t = await line();
    ok(/Post a bond toward cBTC: .*1,000 per wstETH/.test(t) && /Borrow cUSD: 2 per dollar, when you send the loan yourself/.test(t) && !!(await p.$('#hx-pts a[data-link="points"]')), `hxearn: borrowing cUSD names the loan and the bond, and where the terms are (${t.slice(0, 220)})`);
    if (SHOTS) await (await p.$('#hx')).screenshot({ path: join(SHOTS, 'weld-hxearn-borrow.png') });
    await p.click('[data-hxd="cbtc"]');
    await until(p, () => !/Borrow cUSD:/.test(document.querySelector('#hx-pts')?.textContent || '') && /Post a bond/.test(document.querySelector('#hx-pts')?.textContent || ''), null, 60000);
    t = await line();
    ok(!/Borrow cUSD/.test(t) && /Post a bond toward cBTC/.test(t), `hxearn: the way that only mints cBTC names the bond alone (${t.slice(0, 160)})`);
    // Send and Earn score nothing, and say nothing of points.
    for (const m of ['send', 'earn']) { await p.click(`[data-hxm="${m}"]`); await sleep(1500); ok(!(await p.$('#hx-pts')) || (await p.$eval('#hx-pts', (e) => e.hidden)), `hxearn: ${m} says nothing of points`); }
    if (r.errors.length) { fails++; console.log('FAIL hxearn page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The Swap tab sells TAC for wallet ETH: the public pools (one, or split across two in a single transaction when that pays more than
// its extra gas) beside the private Tacit pool, and the Sell sheet it hands off to carries the amount and runs the same route. A sale
// big enough to split is run through the page on the fork: the permit rides inside the one transaction and nothing is left behind.
await step('hxsell', async () => {
  const key = '0x' + Buffer.from(secp.utils.randomPrivateKey()).toString('hex');
  const who = '0x' + Buffer.from(keccak_256(secp.getPublicKey(key.slice(2), false).slice(1)).slice(12)).toString('hex');
  await rpc('anvil_impersonateAccount', [who]); await rpc('anvil_setBalance', [who, '0x' + (10n ** 18n).toString(16)]);
  await fundTac(who, 40000n * 10n ** 18n);
  const r = await openPage({ account: who, key });
  const p = r.page;
  try {
    await p.goto(r.url);
    await p.waitForSelector('#hx-body .hx-h');
    await p.click('[data-hxm="swap"]');
    await p.selectOption('#hx-from', 'tac');
    await p.selectOption('#hx-to', 'ether');
    ok(await p.$$eval('#hx-to option', (o) => o.map((x) => x.value).join()) === 'eth,cusd,cbtc,ether,sats', 'hxsell: paying TAC, the lists offer tETH, cUSD, cBTC, wallet ETH and sats');
    ok(await p.$$eval('#hx-from option', (o) => o.map((x) => x.value).join()) === 'ether,eth,tac,cusd,cbtc', 'hxsell: and sats is not a thing to pay while the other side is ETH');
    await p.fill('#hx-amt', '1');
    await until(p, () => document.querySelector('#hx-out') && !document.querySelector('#hx-out').classList.contains('ph') && /Sells the TAC in your wallet|tETH/.test(document.querySelector('#hx-q')?.textContent || ''), null, 300000);
    ok(/^Sell TAC$|^Swap privately$/.test(await text(p, '#hx-go')), `hxsell: 1 TAC is quoted with a button that sells it (${await text(p, '#hx-go')})`);
    ok(await p.$eval('#hx-trade', (a) => !a.hidden && a.getAttribute('href') === '/trade/tac/#side=sell&amount=1'), 'hxsell: and the way to the trade page carries the side and the amount');
    ok(!/Split across/.test(await text(p, '#hx-q')), 'hxsell: one TAC is not split');
    await p.fill('#hx-amt', '12000');
    await until(p, () => /Split across two pools in one transaction: [\d.]+% more/.test(document.querySelector('#hx-q')?.textContent || ''), null, 300000);
    ok(await text(p, '#hx-go') === 'Sell TAC' && !/…|—/.test(await text(p, '#hx-out')), `hxsell: 12,000 TAC is quoted as a split, paid out as ETH (${(await text(p, '#hx-q')).slice(0, 110)})`);
    const rows = await p.$$eval('#hx-routes [data-hxr]', (b) => b.map((x) => `${x.dataset.hxr}:${x.textContent.replace(/\s+/g, ' ')}`));
    ok(rows.length === 0 || (rows.some((x) => /^public:.*Two public pools.*Precision pool.*Tacit public pool/.test(x)) && rows.some((x) => /^private:.*arrives as tETH/.test(x))), `hxsell: with both ways quoted they are two rows, the public one naming the two pools (${rows.join(' | ').slice(0, 220)})`);
    const w0 = await text(p, '#hx-to-w');
    if (rows.length > 1) {
      await p.click('#hx-routes [data-hxr="private"]');
      await until(p, () => /private on Ethereum/.test(document.querySelector('#hx-to-w')?.textContent || ''), null, 120000);
      await p.click('#hx-routes [data-hxr="public"]');
      await until(p, () => /your wallet/.test(document.querySelector('#hx-to-w')?.textContent || ''), null, 120000);
    }
    ok(/your wallet/.test(w0), `hxsell: what you get is said to land where the chosen route sends it (${w0}), and follows the route picked`);
    await p.click('#hx-go');
    await p.waitForSelector('#sell-connect, #sl-amt', { timeout: 60000 });
    if (await p.$('#sell-connect')) await p.click('#sell-connect');
    await p.waitForSelector('#sl-amt');
    ok(await until(p, () => document.querySelector('#sl-amt')?.value === '12000', null, 30000).then(() => true, () => false), 'hxsell: the Sell sheet opens with the amount from the card');
    await until(p, () => /Split: \d+% Precision pool, \d+% Tacit public pool/.test(document.querySelector('#sl-rcpt')?.textContent || ''), null, 300000);
    ok(true, `hxsell: and quotes the same split (${(await text(p, '#sl-rcpt')).replace(/\s+/g, ' ').slice(0, 160)})`);
    await acceptLoss(p, '#sl-go', '#sl-ackv');
    const e0 = BigInt(await rpc('eth_getBalance', [who, 'latest'])), n0 = BigInt(await rpc('eth_getTransactionCount', [who, 'latest']));
    const mc0 = await tacOf('0xcA11bde05977b3631167028862bE2a173976CA11');
    await p.click('#sl-go');
    await until(p, () => /Sold|class="err"/.test(document.querySelector('#sl-status')?.innerHTML || ''), null, 300000);
    ok((await tacOf(who)) === 28000n * 10n ** 18n, `hxsell: 12,000 TAC sold through the split (${await text(p, '#sl-status')})`);
    ok(BigInt(await rpc('eth_getTransactionCount', [who, 'latest'])) === n0 + 1n && (await allowanceOf(TAC, who, ZROUTER)) === 0n, 'hxsell: one transaction, the permit riding inside it, no allowance left');
    ok(BigInt(await rpc('eth_getBalance', [who, 'latest'])) > e0 + 5n * 10n ** 17n && (await tacOf('0xcA11bde05977b3631167028862bE2a173976CA11')) === mc0, 'hxsell: the ETH arrives (over 0.5 ETH for 12,000 TAC) and Multicall3 keeps no TAC');
    if (r.errors.length) { fails++; console.log('FAIL hxsell page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); await rpc('anvil_stopImpersonatingAccount', [who]); }
});

// The Swap tab with sats: TAC for sats says what the standing bids pay and what a sale needs (with the bridge offered first; with no bid
// on the book it says so), sats for TAC plans the cheapest whole listings on the book, and each hand-off goes to the page that does it
// (the order book, /tac's Buy).
await step('hxsats', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const p = r.page;
  // The book is stubbed so the figures are known: three whole listings of 100, 318.87755103 and 500 TAC at 150, 156.8 and 180 sats a
  // TAC, and a last trade at 150. (The live book moves.)
  const TACID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', soon = Math.floor(Date.now() / 1000) + 7 * 86400;
  const sale = (n, amount, sats) => ({ asset_id: TACID, sale_id: 'a'.repeat(31) + n, seller_pubkey: '02' + String(n).repeat(64), asset_opening: { amount: String(amount), blinding: '00' }, min_price_sats: sats, expiry: soon, expired: false, created_at: soon - 86400, decimals: 8 });
  // Two standing bids, each taken whole: 600 TAC at 210 sats a TAC and 400 TAC at 160 (`bidsOn` false answers an empty list).
  const bid = (n, amount, sats) => ({ asset_id: TACID, bid_id: String(n).repeat(32), buyer_pubkey: '03' + String(n).repeat(64), buyer_address: 'bc1q' + 'x'.repeat(38), amount: String(amount), price_sats: sats, expiry: soon, nonce: '00', created_at: soon - 86400, network: 'mainnet', remaining_amount: String(amount) });
  const stub = (bidsOn) => (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(/preauth-sales$/.test(path) ? { asset_id: TACID, count: 3, sales: [sale(1, 10000000000, 15000), sale(2, 31887755103, 50000), sale(3, 50000000000, 90000)] }
        : /bid-intents$/.test(path) ? { asset_id: TACID, count: bidsOn ? 2 : 0, intents: bidsOn ? [bid(1, 60000000000, 126000), bid(2, 40000000000, 64000)] : [] }
        : { asset_id: TACID, mark_price: { unit: 150, source: 'last_trade', ts: soon - 3600 }, last_trade: { price_sats: 15000, amount: '10000000000', ts: soon - 3600, fill_count: 1 } }) });
  };
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/assets\//, stub(true));
  try {
    await p.goto(r.url);
    await p.waitForSelector('#hx-body .hx-h');
    await p.click('[data-hxm="swap"]');
    await p.selectOption('#hx-from', 'tac');
    await p.selectOption('#hx-to', 'sats');
    await p.fill('#hx-amt', '1000');
    await until(p, () => /standing bid/.test(document.querySelector('#hx-q')?.textContent || '') && /≈ [\d,]+/.test(document.querySelector('#hx-out')?.textContent || ''), null, 120000).catch(async (e) => {
      console.log('     panel:', JSON.stringify(await p.evaluate(() => ['#hx-go', '#hx-out', '#hx-routes', '#hx-q', '#hx-alt'].map((s) => `${s}=${(document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').slice(0, 200)}`))), 'errors:', r.errors.slice(0, 4));
      console.log('     probe:', JSON.stringify(await p.evaluate(async () => {
        const out = {};
        try { await import('/btc-book.js?cb=00000000'); out.book = 'ok'; } catch (x) { out.book = String(x); }
        try { const f = await fetch('https://api.tacit.finance/assets/f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b/preauth-sales?network=mainnet'); out.sales = f.status + ' ' + (await f.text()).slice(0, 80); } catch (x) { out.sales = String(x); }
        return out;
      })));
      throw e;
    });
    ok(await text(p, '#hx-go') === 'Sell TAC on Bitcoin', 'hxsats: TAC for sats offers to sell on Bitcoin');
    const line = (await text(p, '#hx-q')).replace(/\s+/g, ' ');
    ok(/^2 standing bids on the Bitcoin book, the best 210 sats per TAC, pay about 190,000 sats for it before about 3,200 sats of fees; a sale settles when its bidder is online\. Or list a sale at your price\./.test(line) && /Last trade 150 sats, cheapest listing 150\./.test(line) && /bridged to Bitcoin first/.test(line) && /^≈ 190,000$/.test((await text(p, '#hx-out')).trim()), `hxsats: 1,000 TAC is about 190,000 sats from the two standing bids (settling when each bidder is online), and it says that Ethereum TAC is bridged first (${line.slice(0, 260)})`);
    await p.fill('#hx-amt', '3000');
    await until(p, () => /of it/.test(document.querySelector('#hx-q')?.textContent || ''), null, 60000);
    ok(/pay about 190,000 sats for 1,000 of it/.test((await text(p, '#hx-q')).replace(/\s+/g, ' ')) && /^≈ 450,000$/.test((await text(p, '#hx-out')).trim()), 'hxsats: an amount larger than the bids want says how much of it they take, and prices the rest at the last trade');
    await p.fill('#hx-amt', '1000');
    await until(p, () => /^≈ 190,000$/.test((document.querySelector('#hx-out')?.textContent || '').trim()), null, 60000);
    ok(!(await p.$eval('#hx-alt', (e) => e.hidden)) && /Bridge TAC to Bitcoin first/.test(await text(p, '#hx-alt')), 'hxsats: and the bridge is offered first');
    ok((await p.$$('#hx-routes [data-hxr]')).length === 0, 'hxsats: there are no route rows to choose between: it is one way');
    await p.click('#hx-flip');
    ok(await p.$eval('#hx-from', (e) => e.value) === 'sats' && (await p.$$eval('#hx-body .hx-coin b', (b) => b.map((x) => x.textContent))).join() === 'sats,TAC', 'hxsats: the flip makes it sats for TAC (TAC is the only thing sats pay for, so it has no picker)');
    ok(await p.$eval('#hx-trade', (a) => !a.hidden && a.getAttribute('href') === '/trade/tac/#side=buy'), 'hxsats: sats for TAC leads to the trade page to buy, with no amount (the amount there is ETH)');
    await p.fill('#hx-amt', '200000');
    await until(p, () => /listing/.test(document.querySelector('#hx-q')?.textContent || '') && /^[\d,]+(\.\d+)?$/.test((document.querySelector('#hx-out')?.textContent || '').trim()), null, 120000);
    const buy = (await text(p, '#hx-q')).replace(/\s+/g, ' ');
    ok(await text(p, '#hx-go') === 'Buy TAC on Bitcoin' && /^918\.8[78]$/.test((await text(p, '#hx-out')).trim()) && /^3 listings at 169 sats per TAC, about [\d,]+ sats of Bitcoin fees on top; 45,000 sats left over, since listings are taken whole\./.test(buy), `hxsats: 200,000 sats take all three whole listings, 918.88 TAC, with their fees and what is left over (${buy.slice(0, 220)})`);
    await p.fill('#hx-amt', '16000');
    await until(p, () => /^One listing at 150 sats per TAC/.test(document.querySelector('#hx-q')?.textContent || ''), null, 60000);
    ok(/^100$/.test((await text(p, '#hx-out')).trim()), 'hxsats: 16,000 sats takes only the first listing: 100 TAC');
    await p.fill('#hx-amt', '14000');
    await until(p, () => /No listing costs 14,000 sats or less\. The cheapest is 100 TAC for 15,000 sats\./.test(document.querySelector('#hx-q')?.textContent || ''), null, 60000);
    ok(true, 'hxsats: less than the cheapest listing costs says what the cheapest is');
    await p.fill('#hx-amt', '100');
    await until(p, () => /at least 546 sats/.test(document.querySelector('#hx-q')?.textContent || ''), null, 60000);
    ok(true, 'hxsats: less than a listing can cost says so');
    await p.fill('#hx-amt', '200000');
    await until(p, () => /listing/.test(document.querySelector('#hx-q')?.textContent || ''), null, 60000);
    await p.click('#hx-go');
    await p.waitForURL(/\/tac\/#buy/, { timeout: 30000 });
    ok(true, 'hxsats: Buy TAC on Bitcoin goes to /tac, where the listings are taken');
    if (r.errors.length) { fails++; console.log('FAIL hxsats page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
  // with no bid on the book
  const e = await openPage({ account: A0, key: K0 });
  try {
    await e.ctx.route(/^https:\/\/api\.tacit\.finance\/assets\//, stub(false));
    await e.page.goto(e.url);
    await e.page.waitForSelector('#hx-body .hx-h');
    await e.page.click('[data-hxm="swap"]'); await e.page.selectOption('#hx-from', 'tac'); await e.page.selectOption('#hx-to', 'sats'); await e.page.fill('#hx-amt', '1000');
    await until(e.page, () => /No standing bids/.test(document.querySelector('#hx-q')?.textContent || '') && /≈ [\d,]+/.test(document.querySelector('#hx-out')?.textContent || ''), null, 120000);
    ok(/No standing bids on the Bitcoin book: list a sale at your price and wait for a buyer/.test(await text(e.page, '#hx-q')) && /^≈ 150,000$/.test((await text(e.page, '#hx-out')).trim()), 'hxsats: with no bid on the book it says so, and prices the sale at the last trade');
  } finally { await e.browser.close(); }
});

// The lander leads to the assets from the header (the links every page has: Assets, Swap, Pay and Borrow, then a menu with the rest, which on a phone
// holds them all) and to the trade page from a tile under the card, and TAC's own links go to its own address (/trade/tac/). The header still holds them without a sideways scroll.
await step('tradelinks', async () => {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 360, height: 740 }]]) {
    const r = await openPage({ account: A0, key: K0, viewport });
    const p = r.page;
    try {
      await p.goto(r.url);
      await p.waitForSelector('#hx-body .hx-h');
      const seen = await p.evaluate(() => {
        const vis = (s) => { const e = document.querySelector(s); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.left >= 0 && b.right <= window.innerWidth + 1; };
        const list = (s) => [...document.querySelectorAll(s)].map((a) => `${a.textContent.trim()}:${a.getAttribute('href')}`).join(' ');
        return { assets: vis('.sn > a[href="/assets/"]'), menu: vis('.sn .sm > summary'), order: list('.sn > a'), more: list('.sm-p a:not(.pr)'), all: list('.sm-p a'), tile: !!document.querySelector('#tac a[href="/trade/tac/"]'),
          chip: (() => { const l = document.getElementById('wallet-label'); return !!l && l.scrollWidth <= l.clientWidth + 1 && l.clientWidth >= 30; })(), foot: [...document.querySelectorAll('footer.sf nav a')].map((a) => a.getAttribute('aria-label')).join(', '),
          scroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
      });
      ok(seen.menu, `tradelinks (${name}): the header has its menu in view`);
      if (name === 'desktop') ok(seen.assets && seen.order === 'Assets:/assets/ Swap:/swap/ Pay:/pay/ Borrow:/vault/', `tradelinks (${name}): and Assets, Swap, Pay and Borrow beside it (${seen.order})`);
      else ok(!seen.assets && seen.all.startsWith('Assets:/assets/ Swap:/swap/ Pay:/pay/ Borrow:/vault/ '), `tradelinks (${name}): the menu holds them all, Assets first (${seen.all})`);
      ok(seen.more === 'Shielded TAC:/tac/ Tasks:/tasks/ Rewards:/rewards/ Build:/build/ Stats:/weld/stats/ Community ops:/weld/keeper/ Classic app:/classic.html', `tradelinks (${name}): and, under the menu, the rest of the pages (${seen.more})`);
      await p.click('.sn .sm > summary');
      ok(await p.evaluate(() => [...document.querySelectorAll('.sm-p a[href="/assets/"]')].some((a) => a.getBoundingClientRect().width > 0)) === (name === 'phone'), `tradelinks (${name}): the menu lists Assets only where the header has not`);
      await p.keyboard.press('Escape');
      ok(!(await p.$eval('.sm', (d) => d.open)), `tradelinks (${name}): and Escape shuts it`);
      ok(seen.chip, `tradelinks (${name}): and the account chip still shows its whole label`);
      ok(seen.tile, `tradelinks (${name}): the TAC section links to TAC's own trade page`);
      ok(seen.foot === 'Whitepaper, Security, Source, Pool contract, DefiLlama, @tacitfi on X', `tradelinks (${name}): and the footer is icons for the places outside the app (${seen.foot})`);
      ok(!seen.scroll, `tradelinks (${name}): and the page does not scroll sideways`);
      if (r.errors.length) { fails++; console.log('FAIL tradelinks page errors: ' + r.errors.slice(0, 3).join(' | ')); }
    } finally { await r.browser.close(); }
  }
});

// The price strip under the header: TAC, cBTC and tETH, each with its own mark, a link to its trade page and a dollar price read from the one shared multicall. It reserves
// its row, so the hero does not move when the figures arrive; TAC links to the trade page; at a phone's width it fits.
await step('pxs', async () => {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 360, height: 740 }]]) {
    const r = await openPage({ account: A0, key: K0, viewport });
    const p = r.page;
    try {
      await p.goto(r.url);
      await p.waitForSelector('#hx-body .hx-h');
      const top0 = await p.$eval('.hero', (e) => e.getBoundingClientRect().top);
      await p.waitForFunction(() => document.querySelector('#pxs.on'), null, { timeout: 120000 });
      const s = await p.evaluate(() => {
        const items = [...document.querySelectorAll('#pxs .px')].map((x) => ({ name: x.querySelector('b').textContent, val: Number(x.querySelector('.num').textContent.replace(/[$,]/g, '')), mark: x.querySelector('use').getAttribute('href'), href: x.getAttribute('href') }));
        return { items, top: document.querySelector('.hero').getBoundingClientRect().top, scroll: document.documentElement.scrollWidth > innerWidth + 1, h: document.querySelector('#pxs').getBoundingClientRect().height };
      });
      const [tac, btc, eth] = s.items;                                                      // the cBTC and tETH entries: bitcoin's and ETH's dollars
      ok(s.items.map((x) => x.name).join() === 'TAC,cBTC,tETH' && s.items.map((x) => x.mark).join() === '#tk-tac,#tk-cbtc,#tk-teth', `pxs (${name}): the strip names TAC, cBTC and tETH, each with its own mark (${s.items.map((x) => `${x.name} ${x.val}`).join(', ')})`);
      ok(btc.val > 1000 && eth.val > 100 && btc.val / eth.val > 5 && btc.val / eth.val < 200 && tac.val > 0 && tac.val < eth.val, `pxs (${name}): the dollar prices are sane against one another (BTC ${btc.val}, ETH ${eth.val}, TAC ${tac.val})`);
      ok(tac.href === '/trade/tac/' && btc.href === '/trade/cbtc/' && eth.href === '/trade/teth/', `pxs (${name}): each is a link to its own trade page`);
      ok(Math.abs(s.top - top0) < 1 && s.h >= 18, `pxs (${name}): the row was already there, so the hero did not move when the prices arrived (${Math.round(s.top - top0)}px)`);
      ok(!s.scroll, `pxs (${name}): and the page does not scroll sideways`);
      if (r.errors.length) { fails++; console.log('FAIL pxs page errors: ' + r.errors.slice(0, 3).join(' | ')); }
    } finally { await r.browser.close(); }
  }
});

// A return visit draws the prices it last read before it reads them again: figures kept less than an hour ago show at once and the reading
// replaces them; older ones are never drawn.
await step('pxsback', async () => {
  const seedAt = (ago) => ({ fn: ({ ago }) => {
    if (!localStorage.getItem('tacit-front-pxs-v1')) localStorage.setItem('tacit-front-pxs-v1', JSON.stringify({ at: Date.now() - ago, v: { mid: 0.00007, ethBtc: 31.5, usdBtc: 99999 } }));
    window.__seen = [];
    const note = () => { const e = document.querySelector('#pxs'); const t = e && e.classList.contains('on') ? e.textContent : ''; if (t && window.__seen[window.__seen.length - 1] !== t) window.__seen.push(t); };
    new MutationObserver(note).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  }, arg: { ago } });
  for (const [name, ago, shown] of [['fresh', 5 * 60e3, true], ['old', 3 * 3600e3, false]]) {
    const r = await openPage({ account: A0, key: K0, init: seedAt(ago) });
    const p = r.page;
    try {
      await p.goto(r.url);
      await p.waitForSelector('#hx-body .hx-h');
      await p.waitForFunction(() => window.__seen.some((t) => !t.includes('99,999')) , null, { timeout: 120000 });
      const seen = await p.evaluate(() => window.__seen);
      ok(shown ? seen[0].includes('$99,999') : !seen.some((t) => t.includes('99,999')), `pxsback (${name}): ${shown ? 'the figures kept five minutes ago show first' : 'figures kept three hours ago are not drawn'} (${JSON.stringify(seen[0])})`);
      const last = seen[seen.length - 1], btc = Number((last.match(/cBTC\$([\d,]+)/) || [])[1]?.replace(/,/g, ''));
      ok(btc > 1000 && btc !== 99999, `pxsback (${name}): the reading replaces them (${last})`);
      if (r.errors.length) { fails++; console.log('FAIL pxsback page errors: ' + r.errors.slice(0, 3).join(' | ')); }
    } finally { await r.browser.close(); }
  }
});

// The card's Shield by what is held: each source has its own ways (a way that moves ETH into the Tacit pool needs Ethereum, so a pool on
// another chain does not offer it), the chain picker appears only for the ETH-only pools, MegaETH says it scores no points, ETH kept
// private on a chain goes to that chain's Deposit form with the amount, and Borrow hands its BTC to the lock form.
await step('hxways', async () => {
  const r = await openPage({ account: A0, key: K0, viewport: { width: 1280, height: 1000 } });
  const p = r.page;
  const sheetAt = () => p.evaluate(() => { const d = document.querySelector('dialog.sheet[open]:not(.layer)'); return d ? d.id.replace('sheet-', '') + ' ' + location.hash : null; });
  const closeAll = () => p.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); history.replaceState(null, '', location.pathname); });
  const waysOf = async (src) => { await p.selectOption('#hx-from', src); return p.$$eval('#hx-dest [data-hxd]', (r) => r.map((x) => x.dataset.hxd).join()); };
  try {
    await p.goto(r.url);
    await p.waitForSelector('#hx-body .hx-h');
    ok((await waysOf('ether')) === 'defi,pay,btc' && (await waysOf('btc')) === 'eth,pool' && (await waysOf('eth')) === 'wallet,btc' && (await waysOf('tac')) === 'btc,wallet' && (await waysOf('pp')) === 'addr,defi' && (await waysOf('tb')) === 'back',
      'hxways: ETH can be made tETH, kept for payments or sent to Bitcoin; TAC on Bitcoin goes to Ethereum or its shielded pool; each private thing has its own ways out');
    await p.selectOption('#hx-from', 'ether'); await p.click('[data-hxd="pay"]');
    ok(await p.$eval('#hx-chain', (e) => e.hidden) === false, 'hxways: payments ETH asks for its chain');
    await p.selectOption('#hx-chain-sel', '8453');
    ok((await waysOf('pp')) === 'addr', 'hxways: on Base, ETH kept for payments goes to an address (moving it into tETH needs Ethereum)');
    await p.selectOption('#hx-from', 'ether'); await p.click('[data-hxd="defi"]');
    ok(await p.$eval('#hx-chain', (e) => e.hidden), 'hxways: the tETH way has no chain to pick');
    await p.click('[data-hxd="pay"]');
    await p.selectOption('#hx-chain-sel', '4326'); await p.fill('#hx-amt', '0.02');
    await until(p, () => /No TAC points on MegaETH/.test(document.querySelector('#hx-q')?.textContent || '') && document.querySelector('#hx-pts')?.hidden, null, 60000);
    ok(true, 'hxways: on MegaETH the card says it scores no points, and shows none');
    await p.selectOption('#hx-chain-sel', '8453'); await p.fill('#hx-amt', '0.03');
    await until(p, () => document.querySelector('#hx-out')?.textContent === '0.03' && /Proved on this device/.test(document.querySelector('#hx-q')?.textContent || ''), null, 60000);
    await pasteKey(p, 'ab12'.padEnd(64, '7'));
    await closeAll();
    await p.click('#hx-go');
    await until(p, () => !!document.querySelector('#sheet-eth[open] #d-amt'), null, 120000);
    ok((await sheetAt()) === 'eth #device/base', `hxways: payments on Base opens the Deposit form of the Base pool (${await sheetAt()})`);
    await until(p, () => document.querySelector('#d-amt')?.value === '0.03', null, 60000);
    ok(true, 'hxways: with the amount in it');
    await closeAll();
    await p.selectOption('#hx-chain-sel', '1'); await p.fill('#hx-amt', '0.04');
    await until(p, () => document.querySelector('#hx-out')?.textContent === '0.04', null, 60000);
    await p.click('#hx-go');
    await until(p, () => document.querySelector('#sheet-eth[open] #d-amt')?.value === '0.04', null, 120000);
    ok((await sheetAt()) === 'eth #device/ethereum', `hxways: and on Ethereum, the Ethereum pool's (${await sheetAt()})`);
    await closeAll();
    // With the key open, Borrow does the lock in the card: the BTC goes to the key's own Bitcoin address first, then is locked there.
    await p.click('[data-hxm="borrow"]'); await p.fill('#hx-amt', '0.002');
    await until(p, () => /^≈ /.test(document.querySelector('#hx-out')?.textContent || '') && /this lock needs about/.test(document.querySelector('#hx-q')?.textContent || ''), null, 120000);
    ok((await text(p, '#hx-go')) === 'Send BTC to lock' && /ETH bond of at least 1\.5×/.test(await text(p, '#hx-q')) && /Your Bitcoin address bc1q/.test(await text(p, '#hx-have')),
      `hxways: Borrow quotes what the lock can borrow, names the key's Bitcoin address and says what the lock needs (${(await text(p, '#hx-q')).slice(0, 140)})`);
    await p.click('#hx-go');
    await until(p, () => /Bitcoin wallet|Send from any wallet|on its way/i.test(document.querySelector('#hx-bw-s')?.textContent || ''), null, 120000);
    ok(true, `hxways: and with no BTC there yet its button sends it from a Bitcoin wallet, or says to send it from any (${(await text(p, '#hx-bw-s')).slice(0, 100)})`);
    if (r.errors.length) { fails++; console.log('FAIL hxways page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The Swap tab of the Tacit pool: its link, a swap of a note that is exactly the amount (one route over the whole note, the least
// it returns 1% under the quote, a relay fee), an amount no note matches (cut first), a swap between two assets that are not tETH
// (through tETH, two pools in one route), and a relay that refuses (the swap offered from the paying account, no relay fee).
await step('swap', async () => {
  const r = await openFarmKey('5a9b'.padEnd(64, '6'), { notes: [[FARM_CETH, 5000000n], [FARM_CETH, 5000000n], [FARM_CTAC, 50000000000n], ['@cUSD', 10000000000n]], swap: true });
  const p = r.page, calls = () => p.evaluate(() => window.__swapCalls);
  const netBad = []; p.on('response', (x) => { if (x.status() >= 400) netBad.push(`${x.status()} ${x.url().slice(0, 120)}`); }); p.on('requestfailed', (x) => netBad.push(`failed ${x.url().slice(0, 120)} ${x.failure()?.errorText}`)); p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') netBad.push(`console ${m.text().slice(0, 200)}`); });
  const typed = async (v) => { await p.fill('#sw-amt', v); await until(p, () => !document.querySelector('#sw-go').disabled || !!document.querySelector('#sw-ack input') || /Swap more|More than|relay fee is|no pool/i.test(document.querySelector('#sw-rcpt')?.textContent || ''), null, 600000).catch(async (e) => { console.log(`     no quote for ${v}: rcpt=${JSON.stringify((await text(p, '#sw-rcpt')).slice(0, 200))} status=${JSON.stringify((await text(p, '#v1-status')).slice(0, 160))} go.disabled=${await p.$eval('#sw-go', (b) => b.disabled).catch(() => '?')} max=${(await text(p, '#sw-max')).trim()}`); throw e; });
    console.log(`     quote for ${v}: ${(await text(p, '#sw-rcpt')).replace(/\s+/g, ' ').slice(0, 220)}${(await text(p, '#sw-ack')).trim() ? ' | gate: ' + (await text(p, '#sw-ack')).trim().slice(0, 90) : ''}`);
    // A loss gate (15% and over) waits for the tick, or the typed figure from 30%, as a person gives it.
    if (await p.$('#sw-ack input[type="checkbox"]')) await p.check('#sw-ack input[type="checkbox"]');
    else if (await p.$('#sw-ack input')) await p.fill('#sw-ack input', (await text(p, '#sw-ack b')).trim());
    await until(p, () => !document.querySelector('#sw-go').disabled, null, 60000);
  };
  // The press hands the swap to the relay and the form frees up once the scan after it has drawn the new balances (a slow fork takes minutes).
  const settled = (re) => until(p, (x) => new RegExp(x).test(document.querySelector('#sw-max')?.textContent || ''), re.source, 900000);
  const choose = async (attr, k) => { try { await until(p, () => !document.querySelector('#sheet-eth [aria-busy="true"]'), null, 400000).catch(async (e) => { console.log('     still busy:', JSON.stringify(await p.evaluate(() => ({ busy: [...document.querySelectorAll('[aria-busy="true"]')].map((b) => b.id || b.textContent.slice(0, 30)), status: document.querySelector('#v1-status')?.textContent.slice(0, 200), calls: window.__swapCalls.length, act: document.querySelector('#act-body')?.textContent.replace(/\s+/g, ' ').slice(0, 300) }))), '\n'); throw e; }); await p.click(`#sheet-eth [data-${attr}="${k}"]`, { timeout: 60000 }); await p.waitForSelector('#sw-amt', { timeout: 30000 }); } catch (e) { throw new Error(`choosing ${attr}=${k}: ${e.message.split('\n').slice(0, 8).join(' | ')}`); } };
  try {
    await p.evaluate(() => { location.hash = '#private/swap'; });
    await p.waitForSelector('#sw-amt', { timeout: 300000 });
    ok(await p.$eval('#sheet-eth [data-v1="swap"]', (b) => b.getAttribute('aria-selected') === 'true') && await p.evaluate(() => location.hash) === '#private/swap', 'swap: #private/swap opens the Swap tab, and it keeps its link');
    await until(p, () => /Private 0\.1 tETH/.test(document.querySelector('#sw-max')?.textContent || ''), null, 120000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | max: ${(await text(p, '#sw-max')).trim()} | net: ${[...new Set(netBad)].slice(0, 12).join(' || ')}`); });
    ok(true, `swap: the balance of what is paid reads on the tab (${(await text(p, '#sw-max')).trim()})`);

    // A note that is exactly the amount: one route over the whole note.
    await typed('0.05');
    const quote = (await text(p, '#sw-rcpt')).replace(/\s+/g, ' ');
    ok(/[1-9]/.test(await text(p, '#sw-outv')) && /TAC/.test(await text(p, '#sw-out')) && /Price\s*1 tETH ≈ [\d,.]+ TAC/.test(quote) && /At least\s*[\d,.]+ TAC/.test(quote) && /Relay fee\s*[\d.]+ tETH/.test(quote) && !/split a note|Through tETH/.test(quote), `swap: tETH for TAC states what it returns, the least, and the relay fee (${quote.slice(0, 150)})`);
    await shot(p, 'swap-quote');
    await p.click('#sw-go');
    await until(p, () => window.__swapCalls.length >= 1, null, 300000);
    let c = (await calls())[0];
    ok(c.amountIn === '5000000' && c.noteValue === '5000000' && c.path.length === 1 && c.path[0].endsWith(FARM_CTAC) && BigInt(c.fee) > 0n && BigInt(c.minOut) === BigInt(c.out) * 99n / 100n,
      `swap: one route over the whole note into TAC, the least 1% under the quote, a relay fee (${JSON.stringify(c)})`);
    await settled(/Private 0\.05 tETH/);
    await choose('swf', 'tac');
    await settled(/Private [\d,.]+ TAC/);
    const held = parseFloat((await text(p, '#sw-max')).replace(/[^\d.]/g, '') || '0');
    ok(held > 500, `swap: the TAC arrives as a private balance (${(await text(p, '#sw-max')).trim()})`);
    ok(!(await p.$('#sheet-eth [data-swt="tac"]')), 'swap: what is paid is not offered as what is bought');

    // No note of that size: it is cut first.
    await choose('swt', 'eth');
    await typed('100');
    ok(/Relay fee to (split a note|combine notes)/.test(await text(p, '#sw-rcpt')), 'swap: an amount no note matches shows the relay fee to cut one');
    await p.click('#sw-go');
    await until(p, () => window.__swapCalls.length >= 3, null, 900000);
    const cut = await calls();
    ok(cut[1].split === '10000000000' && cut[2].amountIn === '10000000000' && cut[2].noteValue === '10000000000' && cut[2].path[0].endsWith(FARM_CETH), `swap: the note is cut to the amount, then that note is swapped (${JSON.stringify(cut.slice(1))})`);

    // Between two assets that are not tETH: through tETH.
    await choose('swf', 'cusd');
    await choose('swt', 'tac');
    await settled(/Private 100 cUSD/);
    await typed('100');
    ok(/Through\s*tETH, two pools in one settle/.test((await text(p, '#sw-rcpt')).replace(/\s+/g, ' ')) && /[1-9]/.test(await text(p, '#sw-outv')), 'swap: cUSD for TAC says it goes through tETH');
    await p.click('#sw-go');
    await until(p, () => window.__swapCalls.length >= 4, null, 300000);
    c = (await calls())[3];
    ok(c.path.length === 2 && c.path[0].endsWith(FARM_CETH) && c.path[1].endsWith(FARM_CTAC) && c.amountIn === '10000000000', `swap: two pools in one route, tETH between (${JSON.stringify(c.path.map((x) => x.slice(0, 6) + '…' + x.slice(-4)))})`);

    // A relay that refuses: the swap is offered from the paying account, with no relay fee.
    await p.evaluate(() => { window.__swapRefuse = true; });
    await choose('swf', 'eth');
    await choose('swt', 'tac');
    await typed('0.05');
    await p.click('#sw-go');
    await p.waitForSelector('#sheet-eth [data-selfdo]', { timeout: 300000 });
    ok(/Send it from .* instead/.test(await text(p, '#v1-status')), 'swap: a refusing relay leaves the swap offered from the paying account');
    await p.click('#sheet-eth [data-selfdo]');
    await until(p, () => window.__swapCalls.some((x) => x.self), null, 300000);
    c = (await calls()).find((x) => x.self);
    ok(c.fee === '0' && c.amountIn === '5000000', `swap: sent from the paying account the route has no relay fee (${JSON.stringify(c)})`);
    if (r.errors.length) { fails++; console.log('FAIL swap page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});


// The farm sheet in each state a visitor can reach, for design review: nobody connected, a wallet with and without TAC, a
// stake with something earned and a withdrawal previewed, then the private farms with nothing to add, with notes to add, and
// with a position, a harvest and liquidity that is not bonded. Opt-in (`farmtour`), and it writes to SHOTS.
await step('farmtour', async () => {
  if (!SHOTS) throw new Error('the farm tour needs SHOTS=<dir>');
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  const WTAC_ASSET = '0x1097c9e552ae4fce2a8c416b93403953fa445a5f2cdae8ced36d9a78cfe40832', LP0 = '0x17c56713a7e4a5d679a71def3ff9fa186f1556ef757b0ee6b7a3ed8c9249ef99';
  const shown = (p, sel, ms = 120000) => p.waitForSelector(sel, { timeout: ms }).catch(() => {});
  // PART=public or PART=private runs half of it (the private half scans a key's notes, which needs an archive fork); WIDTH=phone or WIDTH=desk runs one width.
  const part = process.env.PART || 'both';
  for (const [tag, viewport] of [['phone', { width: 390, height: 1700 }], ['desk', { width: 1280, height: 1500 }]].filter(([t]) => !process.env.WIDTH || t === process.env.WIDTH)) {
    if (part !== 'private') {
      const r = await openPage({ account: A0, key: K0, viewport });
      const p = r.page, snap = async (name) => { await p.waitForTimeout(1200); await p.screenshot({ path: join(SHOTS, `farm-${tag}-${name}.png`), fullPage: true }); };
      const held = await tacOf(A0);
      if (held > 0n) await rpc('eth_sendTransaction', [{ from: A0, to: TAC, data: '0xa9059cbb' + addrWord(RESERVE) + word(held) }]);
      await p.goto(r.url + '#farm');
      await p.waitForSelector('#pf-connect, [data-pfm]', { timeout: 120000 });
      await snap('1-public-signed-out');
      if (await p.$('#pf-connect')) await p.click('#pf-connect');
      await p.waitForSelector('[data-pfm="eth"]', { timeout: 120000 });
      await p.fill('#pf-amt', '0.05'); await shown(p, '#pf-rcpt:not([hidden])'); await snap('2-public-eth');
      await p.fill('#pf-amt', '2'); await shown(p, '#pf-ackv'); await snap('3-public-eth-big');
      await p.fill('#pf-amt', '');
      await p.click('[data-pfm="pair"]'); await snap('4-public-pair-no-tac');
      await p.fill('#pf-amt', '0.002');
      await until(p, () => /Not enough TAC/.test(document.querySelector('#pf-rcpt')?.textContent || ''), null, 240000).catch(() => {}); await snap('4b-public-pair-no-tac-typed');
      await fundTac(A0, 1000n * 10n ** 18n);
      await go(p, '#farm'); await until(p, () => /[1-9]/.test(document.querySelector('#pf-tmax')?.textContent || ''), null, 120000);
      await p.fill('#pf-amt', ''); await until(p, () => document.querySelector('#pf-rcpt')?.hidden, null, 60000);
      await p.click('#pf-max'); await until(p, () => !document.querySelector('#pf-go').disabled || /Not enough|refuse/.test(document.querySelector('#pf-rcpt')?.textContent || ''), null, 240000).catch(() => {});
      await snap('5-public-pair');
      await p.fill('#pf-amt', '0.02');
      await acceptLoss(p, '#pf-go', '#pf-ackv');
      await p.click('#pf-go'); await p.waitForSelector('#pf-exit', { timeout: 120000 });
      await snap('6-public-just-staked');
      await rpc('evm_increaseTime', [2 * 86400]); await rpc('evm_mine', []);
      await go(p, '#farm'); await until(p, () => { const b = document.querySelector('#pf-claim'); return b && !b.disabled; });
      await shown(p, '#pf-out-rcpt:not([hidden])'); await snap('7-public-staked');
      await p.click('[data-pfp="50"]'); await p.click('[data-pfr="eth"]'); await shown(p, '#pf-out-rcpt:not([hidden])'); await snap('8-public-withdraw-half-as-eth');
      await p.click('#pf-claim'); await until(p, () => /TAC claimed/.test(document.querySelector('#toast-container')?.textContent || ''), null, 120000).catch(() => {});
      await shown(p, '#pf-status .ok'); await snap('9-public-claimed');
      if (r.errors.length) console.log(`   ${tag} page errors: ${r.errors.slice(0, 3).join(' | ')}`);
      await r.browser.close();
    }
    if (part !== 'public') for (const variant of ['bare', 'notes', 'position']) {
      const notes = variant === 'bare' ? [] : [[FARM_CETH, 2000000n], [FARM_CTAC, 50000000000n]].concat(variant === 'position' ? [[FARM_WTAC_ASSET, 1234560000n], [FARM_LP0, 50000000n]] : []);
      const r = await openFarmKey(({ bare: 'ba7e', notes: 'f4a3e', position: 'b05e' })[variant].padEnd(64, '6'), { notes, positions: variant === 'position' ? [farmPos(7, 150000000, 1234560000, '12.3456'), farmPos(8, 20000000, 50000, '0.0005')] : null }, viewport);
      const p = r.page, snap = async (name) => { await p.waitForTimeout(1200); await p.screenshot({ path: join(SHOTS, `farm-${tag}-${name}.png`), fullPage: true }); };
      await go(p, '#farm');
      await p.waitForSelector('[data-farm="pid0"] > button', { timeout: 120000 });
      if (!(await p.$('.farm.open[data-farm="pid0"]'))) await p.click('[data-farm="pid0"] > button');
      if (variant === 'bare') { await shown(p, '#farm-pid0 .gate-p, #farm-pid0 .note'); await p.waitForTimeout(3000); await snap('10-private-no-notes'); }
      else {
        await shown(p, variant === 'notes' ? '#sj-max-0' : '#farm-pid0 [data-unbond]', 240000);
        if (variant === 'notes') {
          await p.click('#sj-max-0');
          await until(p, () => /Adds/.test(document.querySelector('#sj-rcpt-0')?.textContent || '') && !document.querySelector('#sj-go-0').disabled, null, 420000).catch(() => {});
          await snap('11-private-join');
        } else {
          await p.waitForTimeout(2000); await snap('12-private-position');
          await p.click('[data-harvest="0"]'); await shown(p, '#sf-act-0 [data-fn-go]'); await snap('13-private-harvested');
        }
      }
      if (r.errors.length) console.log(`   ${tag} ${variant} page errors: ${r.errors.slice(0, 3).join(' | ')}`);
      await r.browser.close();
    }
  }
  ok(true, `farmtour: screenshots in ${SHOTS}`);
});

// A walk through every sheet and its main states for design review: one screenshot each, at phone and desktop widths
// and in the dark scheme too. Opt-in (`tour`), and it writes to SHOTS.
await step('tour', async () => {
  if (!SHOTS) throw new Error('the tour needs SHOTS=<dir>');
  const other = tacit1('b0b'.padEnd(64, '5'));
  const loaded = (p, sel, ms = 180000) => p.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !/reading…|Reading|Finding|Checking/.test(e.textContent) && !e.querySelector('.sk'); }, sel, { timeout: ms }).catch(() => {});
  const shown = (p, sel, ms = 60000) => p.waitForSelector(sel, { timeout: ms }).catch(() => {});
  for (const [tag, viewport, colorScheme] of [['phone', { width: 390, height: 1400 }, 'light'], ['desk', { width: 1280, height: 1200 }, 'light'], ['phone-dark', { width: 390, height: 1400 }, 'dark']]) {
    const r = await openPage({ account: A0, key: K0, viewport, colorScheme });
    const p = r.page, snap = async (name) => { await p.waitForTimeout(1500); await p.screenshot({ path: join(SHOTS, `${tag}-${name}.png`), fullPage: true }); };
    await p.goto(r.url);
    await p.waitForSelector('#hx-body .hx-h'); await snap('home');
    await go(p, '#wallet'); await p.waitForSelector('#wallet-body [data-in]'); await snap('wallet-signin');
    await p.click('#wallet-body [data-in="eth"]'); await until(p, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
    await go(p, '#wallet'); await p.waitForSelector('#wallet-body .who'); await snap('wallet');
    await p.click('[data-wal="out"]'); await snap('wallet-send-out');
    await go(p, '#private'); await p.waitForSelector('#w-amt', { timeout: 120000 }); await p.fill('#w-amt', '0.05'); await loaded(p, '#eth-v1 .bal'); await shown(p, '#w-rcpt:not([hidden])'); await snap('eth-wrap');
    await p.click('[data-v1="send"]'); await p.fill('#s-to', other); await p.fill('#s-amt', '0.01'); await shown(p, '#s-rcpt:not([hidden])'); await snap('eth-send');
    await p.click('[data-v1="out"]'); await p.fill('#o-to', A0); await p.fill('#o-amt', '0.01'); await shown(p, '#o-rcpt:not([hidden])'); await snap('eth-withdraw');
    await p.click('[data-eth-mode="dev"]'); await shown(p, '[data-dev]'); await loaded(p, '#eth-dev .bal'); await snap('device-deposit');
    for (const m of ['send', 'out', 'receive']) { await p.click(`[data-dev="${m}"]`); await snap(`device-${m}`); }
    await go(p, '#btc'); await shown(p, '#bt-to', 120000); await loaded(p, '#btc-body .bal'); await p.fill('#bt-to', other).catch(() => {}); await p.fill('#bt-amt', '0.001').catch(() => {}); await shown(p, '#bt-rcpt:not([hidden])'); await snap('btc-send');
    await p.click('[data-btcm="receive"]'); await snap('btc-receive');
    await go(p, '#airdrop'); await shown(p, '#air-body .gate'); await snap('tac-airdrop');
    await p.click('[data-tac-mode="buy"]'); await p.fill('#b-amt', '0.01'); await shown(p, '#b-rcpt:not([hidden])'); await snap('tac-buy');
    await go(p, '#pts'); await shown(p, '#wei-name'); await shown(p, '#pts-body .pt', 120000); await p.fill('#wei-name', 'tacitlite'); await shown(p, '#wei-rcpt:not([hidden])'); await snap('points');
    await go(p, '#farm'); await shown(p, '#pf-amt', 120000); await p.fill('#pf-amt', '0.05'); await shown(p, '#pf-rcpt:not([hidden])'); await snap('farm-precision');
    const pid = await p.$('[data-farm^="pid"] > button');
    if (pid) { await pid.click(); await snap('farm-shielded'); }
    await go(p, '#borrow'); await shown(p, '#borrow-body .steps', 180000); await snap('borrow');
    await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    for (const a of ['tac', 'cbtc']) { await go(p, `#asset/${a}`); await shown(p, '#asset-card[open] .links'); await snap(`card-${a}`); await p.keyboard.press('Escape'); }
    if (r.errors.length) console.log(`   ${tag} page errors: ${r.errors.slice(0, 3).join(' | ')}`);
    await r.browser.close();
  }
  ok(true, `tour: screenshots in ${SHOTS}`);
});
// Steps the relay proved and nobody sent, as an earlier visit left them in Activity: a relayed withdrawal it holds open, a split proved for
// a page that closed before sending it, and one a relay took to send minutes ago. Each offers "Send it now" from the paying account,
// which reads the proof from the relay and sends settle() as it is (no second proof), then tells the relay it landed. A proof that goes
// in with its deposit (wrap and send), and a send a relay took a moment ago, are not offered. One a relay sent meanwhile reads as done.
await step('openact', async () => {
  const served = {}, PV = '0x' + '01'.repeat(32), PF = '0x' + '02'.repeat(32), M = '0x' + 'ab'.repeat(40);
  const r = await openPage({ account: A0, key: K0 });
  await serveStatus(r.ctx, served);
  const proved = (b) => ({ publicValues: PV, proof: PF, ...b });
  Object.assign(served, {
    'o-open': proved({ type: 'unwrap', status: 'open', memos: [] }),
    'o-prov': proved({ type: 'transfer', mode: 'prove', status: 'proven', memos: [M] }),
    'o-router': proved({ type: 'wraptransfer', mode: 'prove', status: 'proven', memos: [M] }),
    'o-slow': proved({ type: 'sendunwrap', status: 'sending', memos: [M] }),
    'o-new': proved({ type: 'sendunwrap', status: 'sending', memos: [M] }),
  });
  const row = async (id) => (await actRows(r.page)).find((x) => x.id === id) || { text: '' };
  const offered = (id) => r.page.$(`[data-act="${id}"] [data-sendopen]`).then(Boolean);
  let restore = null;
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#hx-body .hx-h');
    await r.page.evaluate((t) => localStorage.setItem('tacit-lite-activity-v1', JSON.stringify({ cleared: 0, items: [
      { id: 'job:o-open', kind: 'job', type: 'unwrap', label: 'Withdraw 0.1 ETH', status: 'pending', at: t - 300e3, up: t - 300e3 },
      { id: 'job:o-prov', kind: 'job', type: 'transfer', label: 'Split a note', status: 'proven', at: t - 600e3, up: t - 500e3, end: t - 500e3 },
      { id: 'job:o-router', kind: 'job', type: 'wraptransfer', label: 'Make private and send', status: 'proven', at: t - 700e3, up: t - 650e3, end: t - 650e3 },
      { id: 'job:o-slow', kind: 'job', type: 'sendunwrap', label: 'Withdraw 0.2 ETH', status: 'sending', at: t - 900e3, up: t - 400e3 },
      { id: 'job:o-new', kind: 'job', type: 'sendunwrap', label: 'Withdraw 0.3 ETH', status: 'sending', at: t - 120e3, up: t - 30e3 },
    ] })), Date.now());
    await r.page.reload();
    await r.page.waitForSelector('#hx-body .hx-h');
    await openActivity(r.page);
    const due = await until(r.page, () => !!document.querySelector('[data-act="job:o-open"] [data-sendopen]'), null, 60000).then(() => true, () => false);
    const open = await row('job:o-open');
    ok(due && /Ready to send/.test(open.text) && /Proved and ready/.test(open.text) && /relay fee comes back to you/.test(open.text) && /goes through when a relay sends it/.test(open.text),
      `openact: a withdrawal the relay proved and holds open offers to send it now (${open.text.slice(0, 200)})`);
    const prov = await row('job:o-prov');
    ok(await offered('job:o-prov') && /never sent/.test(prov.text) && !/Start it again/.test(prov.text), `openact: a split proved for a page that closed is offered too (${prov.text.slice(0, 160)})`);
    const router = await row('job:o-router');
    ok(!(await offered('job:o-router')) && /Start it again/.test(router.text), `openact: a proof that goes in with its deposit is not offered (${router.text.slice(0, 140)})`);
    ok(await offered('job:o-slow') && !(await offered('job:o-new')), 'openact: a send a relay took minutes ago is offered, one it took a moment ago is not');
    ok(!/gas|top.?up|out of|low on|credit/i.test((await actRows(r.page)).map((x) => x.text).join(' ')), 'openact: nothing on the list speaks of the relay\'s funds');
    // Sent: the pool takes the proof as it is, from the connected wallet, with no second proof asked for.
    restore = await stubPoolSettle('ok');
    const s0 = submits.length, w0 = walletTxs.length, l0 = landedPosts.length;
    await r.page.click('[data-act="job:o-open"] [data-sendopen]');
    await until(r.page, () => /Done in|Went through/.test(document.querySelector('[data-act="job:o-open"]')?.textContent || '') || !!document.querySelector('[data-act="job:o-open"] .actr-f.err'), null, 180000).catch(() => {});
    const sent = walletTxs.slice(w0).find((x) => String(x.to).toLowerCase() === POOL_ADDR);
    ok(sent && sent.from.toLowerCase() === A0 && sent.data.startsWith('0x' + SETTLE_SEL) && sent.data.includes('02'.repeat(32)) && submits.length === s0,
      `openact: pressed, settle() goes to the pool from the wallet carrying the relay's proof, and nothing is proved again (${(await row('job:o-open')).text.slice(0, 160)})`);
    const told = landedPosts.slice(l0).find((x) => x.jobId === 'o-open');
    ok(told && /^0x[0-9a-f]{64}$/i.test(told.txHash) && /Done in|Went through/.test((await row('job:o-open')).text), `openact: the relay is told it landed, and the row reads done (${JSON.stringify(told)})`);
    await restore(); restore = null;
    // A relay sent it meanwhile: the pool refuses it as spent, which reads as gone through, not as a failure.
    restore = await stubPoolSettle('b115d857');
    const w1 = walletTxs.length;
    await r.page.click('[data-act="job:o-prov"] [data-sendopen]');
    await until(r.page, () => /Done in|Went through/.test(document.querySelector('[data-act="job:o-prov"]')?.textContent || '') || !!document.querySelector('[data-act="job:o-prov"] .actr-f.err'), null, 180000).catch(() => {});
    const again = await row('job:o-prov');
    ok(/Done in|Went through/.test(again.text) && !/refuses|did not/.test(again.text) && walletTxs.length === w1, `openact: one already sent reads as done, with nothing sent (${again.text.slice(0, 140)})`);
    if (r.errors.length) { fails++; console.log('FAIL openact page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { if (restore) await restore(); await r.browser.close(); }
});

// A harvest the relay proves and then holds (it cannot send it just now): the wait ends with the proof, and the sheet offers to send it
// now from the paying account. Pressed, that proof goes to the pool as it is (no second proof), and the relay is told it landed.
await step('openfarm', async () => {
  const r = await openFarmKey('0fe1'.padEnd(64, '6'), { notes: [], positions: [farmPos(7, 150000000, 1234560000, '12.3456')], chain: true, held: true });
  const p = r.page;
  let restore = null;
  try {
    await go(p, '#farm');
    await p.waitForSelector('[data-harvest="0"]', { timeout: 300000 });
    openNext = 1;
    const s0 = submits.length, l0 = landedPosts.length;
    await p.click('[data-harvest="0"]');
    await p.waitForSelector('#sf-act-0 [data-selfdo]', { timeout: 180000 });
    const line = (await text(p, '#sf-act-0')).replace(/\s+/g, ' ');
    ok(/proved and ready to send/i.test(line) && /Send it now from/.test(line) && /relay fee comes back to you/.test(line) && /goes through when a relay sends it/.test(line) && !/gas|credit|low on/i.test(line),
      `openfarm: a harvest proved and held offers to send it now (${line})`);
    restore = await stubPoolSettle('ok');
    await p.click('#sf-act-0 [data-selfdo]');
    await until(p, () => /Harvested to a wTAC note/.test(document.querySelector('#sf-act-0')?.textContent || '') || /class="err"/.test(document.querySelector('#sf-act-0')?.innerHTML || ''), null, 240000).catch(() => {});
    const calls = await p.evaluate(() => window.__farmCalls), told = landedPosts.slice(l0)[0];
    const tx = told?.txHash ? await rpc('eth_getTransactionByHash', [told.txHash]) : null;
    ok(/Harvested to a wTAC note/.test(await text(p, '#sf-act-0')) && calls.join() === 'relayed:farmHarvest' && submits.slice(s0).length === 1 && submits[s0]?.type === 'farmharvest' && !submits[s0]?.mode,
      `openfarm: pressed, it is sent with no second proof (${calls.join(', ')}; ${submits.slice(s0).map((x) => `${x.type}/${x.mode || 'settle'}`).join(', ')}; ${(await text(p, '#sf-act-0')).replace(/\s+/g, ' ').slice(0, 120)})`);
    ok(tx && String(tx.to).toLowerCase() === POOL_ADDR && tx.input.startsWith('0x' + SETTLE_SEL) && tx.input.includes('02'.repeat(32)) && told.jobId === `stub-${s0 + 1}`,
      `openfarm: settle() carries the relay's proof to the pool, and the relay is told it landed (${JSON.stringify(told)})`);
    if (r.errors.length) { fails++; console.log('FAIL openfarm page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { openNext = 0; if (restore) await restore(); await r.browser.close(); }
});

// The relay holds settles that expire (relay_held): a withdrawal that needs two notes combined first gets the combine queued (the form goes
// to Activity then), and its own exit refused. The refusal is offered on the withdrawal's receipt in Activity, and pressed there the exit goes
// out from the paying account with no relay fee, the receipt following it to the end.
await step('heldoff', async () => {
  const PV = '0x' + '01'.repeat(32), PF = '0x' + '02'.repeat(32);
  const r = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 900 } });
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const ETH = String(ux.assetByTicker.cETH.assetId).toLowerCase();
      let seq = 0, leaves = 700000;
      const note = (value) => { const i = ++seq; return { asset: ETH, value: String(value), leaf: '0x' + (0xdef000 + i).toString(16).padStart(64, '0'), leafIndex: 700000 + i, cx: '0x' + String(i).padStart(64, '0'), cy: '0x01', owner: '0x02', root: '0x' + '1'.padStart(64, '0'), path: [] }; };
      const S = window.__ho = { notes: [note(6000000n), note(6000000n)], spent: new Set(), calls: [] };
      ux.poolLeafCount = async () => ++leaves;
      ux.balance = async (priv) => {
        const b = await balance(priv), add = S.notes.filter((n) => !S.spent.has(n.leaf));
        b.notes = [...b.notes, ...add];
        for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.notes = [...(g.notes || []), n]; g.value = g.notes.reduce((a, x) => a + BigInt(x.value), 0n); }
        return b;
      };
      ux.quoteOpFee = async () => '100000';
      const fire = (d) => dispatchEvent(new CustomEvent('tacit:job', { detail: { txHash: null, error: null, at: Date.now(), ...d } }));
      ux.transfer = async ({ notes, amount, fee, waitOpts }) => {
        const jobId = 'ho-combine';
        S.calls.push({ type: 'transfer', fee: String(fee) });
        waitOpts?.onJob?.(jobId, 'transfer'); fire({ jobId, type: 'transfer', status: 'pending' });
        await new Promise((res) => setTimeout(res, 1500));
        for (const n of notes) S.spent.add(n.leaf);
        S.notes.push(note(amount));
        const total = notes.reduce((a, n) => a + BigInt(n.value), 0n) - BigInt(amount) - BigInt(fee);
        if (total > 0n) S.notes.push(note(total));
        fire({ jobId, type: 'transfer', status: 'settled', txHash: '0x' + 'c1'.repeat(32) });
        return { jobId, status: 'settled', txHash: '0x' + 'c1'.repeat(32) };
      };
      ux.sendUnwrap = async (a) => {
        S.calls.push({ type: 'sendunwrap', self: typeof a.selfSettle, amount: String(a.amount) });
        if (!a.selfSettle) throw Object.assign(new Error('relay 429: the relay can’t take this one right now; send it from your own wallet, or try again later'), { code: 'relay_held', httpStatus: 429 });
        const jobId = 'ho-prove';
        a.waitOpts?.onJob?.(jobId, 'sendunwrap'); fire({ jobId, type: 'sendunwrap', status: 'pending' });
        fire({ jobId, type: 'sendunwrap', status: 'proven' });
        S.spent.add(a.note.leaf);
        return { jobId, ...(await a.selfSettle({ jobId, publicValues: '${PV}', proof: '${PF}', memos: [] })) };
      };
      return ux;
    }` }));
  const hx = 'a0ff'.padEnd(64, '5');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hx, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 18n).toString(16)]);
  const ho = () => r.page.evaluate(() => window.__ho?.calls || []);
  const receipt = async () => (await actRows(r.page)).find((x) => /Withdraw 0\.1 ETH/.test(x.text)) || { text: '', id: '' };
  let restore = null;
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#hx-body .hx-h');
    await pasteKey(r.page, hx);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await go(r.page, '#private');
    await r.page.waitForSelector('#sheet-eth[open]');
    await r.page.click('[data-v1="out"]');
    await until(r.page, () => /Private 0\.12 tETH/.test(document.querySelector('#o-max')?.textContent || ''), null, 240000);
    await r.page.fill('#o-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#o-amt', '0.1');
    await until(r.page, () => /Arrives/.test(document.querySelector('#o-rcpt')?.textContent || '') && !document.querySelector('#o-go').disabled, null, 60000);
    await r.page.click('#o-go');
    await until(r.page, () => (window.__ho?.calls || []).some((c) => c.type === 'sendunwrap'), null, 120000);
    await openActivity(r.page);
    const offered = await until(r.page, () => [...document.querySelectorAll('#act-body .actr')].some((li) => /Withdraw 0\.1 ETH/.test(li.textContent) && li.querySelector('[data-selfdo]')), null, 60000).then(() => true, () => false);
    const rc = await receipt();
    ok(offered && rc.id.startsWith('op:') && /can’t take this one right now/.test(rc.text) && /Send it from your Tacit account instead/.test(rc.text) && /no relay fee/.test(rc.text) && !/gas|credit|low on/i.test(rc.text),
      `heldoff: the exit refused after the combine went to Activity is offered on its receipt there (${rc.text.slice(0, 220)})`);
    restore = await stubPoolSettle('ok');
    if (offered) await r.page.click(`[data-act="${rc.id}"] [data-selfdo]`);
    // Done, or a second error line under the refusal (the self-send's own failure).
    await until(r.page, (id) => /Done in/.test(document.querySelector(`[data-act="${id}"]`)?.textContent || '') || document.querySelectorAll(`[data-act="${id}"] .actr-f.err`).length > 1, rc.id, 600000).catch(() => {});
    const calls = await ho(), after = await receipt();
    ok(calls.filter((c) => c.type === 'sendunwrap').map((c) => c.self).join() === 'undefined,function' && /Done in/.test(after.text),
      `heldoff: pressed, the same exit goes out from the paying account, and the receipt reads done (${JSON.stringify(calls)}; ${after.text.slice(0, 140)})`);
    if (r.errors.length) { fails++; console.log('FAIL heldoff page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { if (restore) await restore(); await r.browser.close(); }
});

// The relay's day of proofs used up (prove_budget) is not a refusal the paying account gets round (sending it needs a proof from the same
// relay): it is said plainly, with nothing offered. Met while sending from the account, after a refusal that was offered, it says the same.
await step('provecap', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ca9'.padEnd(64, '6');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      ux.balance = async (priv) => {
        const b = await balance(priv);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        const w = ux.buildWrap({ walletPriv: hx, amountWei: (5n * 10n ** 17n).toString(), ticker: 'cETH', index: 0 });
        const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        b.notes = [...b.notes, note];
        const g = b.byAsset[note.asset] ||= { asset: note.asset, value: 0n, notes: [] };
        g.value = BigInt(g.value) + BigInt(note.value); g.notes = [...g.notes, note];
        return b;
      };
      return ux;
    }` }));
  const CAP = { code: 'prove_budget', error: 'the relay has made as many proofs as it can for today (prove_budget); try again after midnight UTC' };
  const HELD = { code: 'relay_held', error: 'the relay can’t take this one right now; send it from your own wallet, or try again later' };
  const said = () => text(r.page, '#v1-status').then((t) => t.replace(/\s+/g, ' '));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
    await go(r.page, '#eth');
    await r.page.waitForSelector('[data-v1="out"]', { timeout: 600000 });
    await r.page.click('[data-v1="out"]');
    await r.page.fill('#o-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#o-amt', '0.1');
    await until(r.page, () => !document.querySelector('#o-rcpt')?.hidden && !document.querySelector('#o-go')?.disabled, null, QUOTE_WAIT);
    refuseSubmits = 1; refuseWith = CAP;
    await r.page.click('#o-go');
    await until(r.page, () => /as many proofs/.test(document.querySelector('#v1-status')?.textContent || '') || !!document.querySelector('#v1-status [data-selfdo]'), null, QUOTE_WAIT).catch(() => {});
    ok(/The relay has made as many proofs as it can for today\. Try again after midnight UTC; nothing was spent\./.test(await said()) && !(await r.page.$('#v1-status [data-selfdo]')),
      `provecap: a withdrawal met by the day's proofs used up says so, and offers nothing (${await said()})`);
    // Refused for another reason, it is offered; the proof the account then asks for meets the cap, and that is said the same way.
    await until(r.page, () => !document.querySelector('#o-go')?.disabled && !document.querySelector('#o-go')?.getAttribute('aria-busy'), null, 120000).catch(() => {});
    refuseSubmits = 2; refuseWith = [HELD, CAP];
    await r.page.click('#o-go');
    const offered = await until(r.page, () => !!document.querySelector('#v1-status [data-selfdo]'), null, QUOTE_WAIT).then(() => true, () => false);
    ok(offered && /can’t take this one right now/.test(await said()), `provecap: a withdrawal the relay holds is offered from the paying account (${await said()})`);
    if (offered) {
      const n0 = refused.length;
      await r.page.click('#v1-status [data-selfdo]');
      await until(r.page, () => /as many proofs/.test(document.querySelector('#v1-status')?.textContent || ''), null, QUOTE_WAIT).catch(() => {});
      ok(/as many proofs as it can for today/.test(await said()) && refused.length === n0 + 1 && refused.at(-1)?.mode === 'prove' && !(await r.page.$('#v1-status [data-selfdo]')),
        `provecap: the proof it then asks for meets the cap, said plainly, with no offer to go round again (${await said()})`);
    }
    if (r.errors.length) { fails++; console.log('FAIL provecap page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { refuseSubmits = 0; refuseWith = null; await r.browser.close(); }
});

// The Borrow sheet when the relay holds settles (relay_held): Borrow and Repay each offer to send it from the paying account, as the other
// sheets do, and pressed, the same loan call goes out with the settle handed over. The pool module is stubbed with a minted cBTC note, the
// loan calls the relay refuses until handed a self-settle, and the loan they open (and the cUSD it makes) for Repay to find.
await step('heldborrow', async () => {
  const hex = 'b07'.padEnd(64, '6'), pub = Buffer.from(secp.getPublicKey(hex, true)).toString('hex');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 18n).toString(16)]);
  const r = await openPage({ account: A0, key: K0 });
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const CB = String(ux.pool.CBTC_ZK_ASSET_ID).toLowerCase(), USD = String(ux.cdp.debtAssetId(ux.cfg.collateralEngine)).toLowerCase();
      const h = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
      let seq = 0, leaves = 600000;
      const note = (asset, value) => { const i = ++seq; return { asset, value: String(value), leaf: h(0xb0b000 + i), leafIndex: 600000 + i, cx: h(0x100 + i), cy: h(2), owner: h(3), secret: h(0x5100 + i), blinding: h(0x7700 + i), root: h(1), path: [] }; };
      const S = window.__bw = { notes: [note(CB, 20000n)], calls: [], loan: null };
      ux.poolLeafCount = async () => ++leaves;
      ux.balance = async (priv, opts) => {
        const b = await balance(priv, opts);
        b.notes = [...b.notes, ...S.notes];
        for (const n of S.notes) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.notes = [...(g.notes || []), n]; g.value = g.notes.reduce((a, x) => a + BigInt(x.value), 0n); }
        return b;
      };
      ux.recoverCdpPositions = async () => ({ nextKeyNonce: S.loan ? 1 : 0, positions: S.loan ? [{ controller: S.loan.controller, keyNonce: 0, debtValue: String(S.loan.debtValue), rateSnapshot: S.loan.rateSnapshot,
        positionOwner: S.loan.positionOwner, nonce: h(0), basket: [{ asset: CB, value: '20000' }], live: true }] : [] });
      ux.cdpPositionTree = async () => ({ indexOf: () => 0, pathFor: () => ({ path: [] }), root: h(9) });
      const refuse = () => Object.assign(new Error('relay 429: the relay can’t take this one right now; send it from your own wallet, or try again later'), { code: 'relay_held', httpStatus: 429 });
      const defi = ux.defiActions;
      ux.defiActions = (priv) => ({ ...defi(priv),
        openCdp: async (a) => {
          S.calls.push({ kind: 'open', self: typeof a.selfSettle, fee: String(a.fee) });
          if (!a.selfSettle) throw refuse();
          S.loan = a; S.notes = [note(USD, BigInt(a.debtValue))];
          return { txHash: h(0xee) };
        },
        closeCdp: async (a) => {
          S.calls.push({ kind: 'close', self: typeof a.selfSettle, fee: String(a.fee) });
          if (!a.selfSettle) throw refuse();
          S.loan = null; S.notes = [note(CB, 20000n)];
          return { txHash: h(0xef) };
        },
      });
      return ux;
    }` }));
  const calls = () => r.page.evaluate(() => (window.__bw?.calls || []).map((c) => `${c.kind}:${c.self}`).join(','));
  const offerIn = () => until(r.page, () => !!document.querySelector('#bw-status [data-selfdo], #bw-s4 [data-selfdo]'), null, QUOTE_WAIT).then(() => true, () => false);
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate((p) => localStorage.setItem(`tacit-lite-cbtc-v1:${p}`, JSON.stringify({ lockTxid: 'ab'.repeat(32), lockVout: 1, vBtc: '20000',
      anchor: { txid: 'cd'.repeat(32), vout: 0 }, at: Date.now(), minted: true })), pub);
    await go(r.page, '#borrow');
    await r.page.waitForSelector('#bw-borrow', { timeout: 300000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ').slice(0, 300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    await sleep(2000);
    await r.page.click('#bw-borrow');
    const offered = await offerIn();
    ok(offered && /can’t take this one right now/.test(await bwText(r.page)) && /Send it from/.test(await bwText(r.page)), `heldborrow: a loan the relay holds offers to send it from the paying account (${(await bwText(r.page)).replace(/\s+/g, ' ').trim().slice(0, 160)})`);
    if (offered) {
      await r.page.click('#bw-status [data-selfdo], #bw-s4 [data-selfdo]');
      await until(r.page, () => /Borrowed [\d.,]+ cUSD/.test([...document.querySelectorAll('#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4')].map((e) => e.textContent).join(' ')), null, 180000).catch(() => {});
      ok((await calls()) === 'open:undefined,open:function' && /Borrowed [\d.,]+ cUSD/.test(await bwText(r.page)), `heldborrow: pressed, the same loan goes out with the settle handed over (${await calls()} | ${(await bwText(r.page)).replace(/\s+/g, ' ').trim().slice(0, 120)})`);
    }
    // Repay, the same.
    await r.page.waitForSelector('#bw-repay', { timeout: 300000 });
    await sleep(2000);
    await r.page.click('#bw-repay');
    const offered2 = await offerIn();
    ok(offered2 && /can’t take this one right now/.test(await bwText(r.page)), `heldborrow: a repayment the relay holds offers the same (${(await bwText(r.page)).replace(/\s+/g, ' ').trim().slice(0, 160)})`);
    if (offered2) {
      await r.page.click('#bw-status [data-selfdo], #bw-s4 [data-selfdo]');
      await until(r.page, () => /Repaid\./.test([...document.querySelectorAll('#bw-status, #bw-s1, #bw-s2, #bw-s3, #bw-s4')].map((e) => e.textContent).join(' ')), null, 180000).catch(() => {});
      ok((await calls()).endsWith('close:undefined,close:function') && /Repaid\./.test(await bwText(r.page)), `heldborrow: and goes out from the paying account (${await calls()} | ${(await bwText(r.page)).replace(/\s+/g, ' ').trim().slice(0, 120)})`);
    }
    if (r.errors.length) { fails++; console.log('FAIL heldborrow page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The Borrow sheet for cBTC the key holds that no lock of its own made (sent, bridged, bought): it leads with a borrow form on the private notes it
// finds, sized by ratio presets, with what the loan is liquidated at; the lock steps fold under it. The pool module is stubbed with two cBTC notes,
// the loan calls (recording what they were handed), the position the loan makes, and the self-send that cuts a note to size.
await step('holdborrow', async () => {
  const hex = 'b0d1'.padEnd(64, '5'), pub = Buffer.from(secp.getPublicKey(hex, true)).toString('hex');
  const r = await openPage({ account: A0, key: K0 });
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const CB = String(ux.pool.CBTC_ZK_ASSET_ID).toLowerCase(), USD = String(ux.cdp.debtAssetId(ux.cfg.collateralEngine)).toLowerCase();
      const h = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
      let seq = 0, leaves = 700000;
      const note = (asset, value) => { const i = ++seq; return { asset, value: String(value), leaf: h(0xc0b000 + i), leafIndex: 700000 + i, cx: h(0x100 + i), cy: h(2), owner: h(3), secret: h(0x5100 + i), blinding: h(0x7700 + i), root: h(1), path: [] }; };
      const S = window.__hb = { notes: [note(CB, 30000n), note(CB, 20000n)], calls: [], loans: [] };
      ux.poolLeafCount = async () => ++leaves;
      ux.quoteOpFee = async () => 100n;
      ux.balance = async (priv, opts) => {
        const b = await balance(priv, opts);
        b.notes = [...b.notes, ...S.notes];
        for (const n of S.notes) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.notes = [...(g.notes || []), n]; g.value = g.notes.reduce((a, x) => a + BigInt(x.value), 0n); }
        return b;
      };
      ux.recoverCdpPositions = async () => ({ nextKeyNonce: S.loans.length, positions: S.loans.map((l, i) => ({ controller: l.controller, keyNonce: i, debtValue: String(l.debtValue), rateSnapshot: l.rateSnapshot,
        positionOwner: l.positionOwner, nonce: h(0), basket: [{ asset: CB, value: String(l.collateral[0].value) }], live: true })) });
      ux.cdpPositionTree = async () => ({ indexOf: () => 0, pathFor: () => ({ path: [] }), root: h(9) });
      ux.transfer = async (a) => {
        S.calls.push({ kind: 'cut', amount: String(a.amount), fee: String(a.fee), from: a.notes.map((n) => String(n.value)).join('+') });
        const sum = a.notes.reduce((t, n) => t + BigInt(n.value), 0n), gone = new Set(a.notes.map((n) => n.leaf));
        S.notes = [...S.notes.filter((n) => !gone.has(n.leaf)), note(CB, BigInt(a.amount)), ...(sum - BigInt(a.amount) - BigInt(a.fee) > 0n ? [note(CB, sum - BigInt(a.amount) - BigInt(a.fee))] : [])];
        return { txHash: h(0xd1) };
      };
      const defi = ux.defiActions;
      ux.defiActions = (priv) => ({ ...defi(priv),
        openCdp: async (a) => {
          S.calls.push({ kind: 'open', value: String(a.collateral[0].value), debt: String(a.debtValue), fee: String(a.fee), owner: a.positionOwner });
          S.loans.push(a); S.notes = S.notes.filter((n) => n.leafIndex !== a.collateral[0].leafIndex); S.notes.push(note(USD, BigInt(a.debtValue)));
          return { txHash: h(0xee) };
        },
        closeCdp: async (a) => {
          S.calls.push({ kind: 'close', debt: String(a.debtValue) });
          const l = S.loans.shift();
          S.notes = [...S.notes.filter((n) => n.asset !== USD), note(CB, BigInt(l.collateral[0].value))];
          return { txHash: h(0xef) };
        },
      });
      return ux;
    }` }));
  const calls = () => r.page.evaluate(() => (window.__hb?.calls || []).map((c) => c.kind + (c.value ? ':' + c.value : '') + (c.amount ? ':' + c.amount : '')).join(','));
  const sheet = () => r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' '));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    // The card's Borrow tab would ask for BTC to lock first: with cBTC already held it says so and points at the sheet.
    await r.page.evaluate(() => { location.hash = ''; });
    await r.page.click('[data-hxm="borrow"]');
    await r.page.waitForSelector('#hx-bw-hold:not([hidden])', { timeout: 240000 }).catch(() => {});
    ok(/You hold 0\.0005 cBTC\. Borrow against it/.test(await text(r.page, '#hx-bw-hold')) && (await r.page.$eval('#hx-bw-hold a', (a) => a.getAttribute('href'))) === '#borrow', `holdborrow: the card's Borrow tab says the key holds cBTC and points at the sheet (${(await text(r.page, '#hx-bw-hold')).trim()})`);
    await go(r.page, '#borrow');
    await r.page.waitForSelector('#bw-hold #bw-borrow', { timeout: 300000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await sheet()).slice(0, 300)} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    await until(r.page, () => !document.querySelector('#bw-rcpt')?.hidden, null, 60000).catch(() => {});
    const b0 = await sheet();
    ok(/Borrow cUSD\s*Private 0\.0005 cBTC/.test(b0), `holdborrow: with no lock of its own, the sheet leads with what the key holds (${b0.slice(0, 80)})`);
    ok(!(await r.page.$('details.lockmore[open] > summary')) && /Get cBTC from BTC/.test(b0) && (await r.page.$$('#borrow-body ol.steps > li')).length === 3, 'holdborrow: the lock steps fold under it, with no fourth step');
    const rc0 = await text(r.page, '#bw-rcpt');
    ok(/You borrow/.test(rc0) && /Collateral ratio\s*200%/.test(rc0.replace(/\s+/g, ' ')) && /Liquidated below\s*\$[\d,]+ a bitcoin/.test(rc0.replace(/\s+/g, ' ')), `holdborrow: an empty amount borrows at 200%, and says what it is liquidated at (${rc0.replace(/\s+/g, ' ').trim()})`);
    ok(await r.page.$eval('[data-bh-ratio="200"]', (x) => x.getAttribute('aria-selected')) === 'true', 'holdborrow: the 200% preset reads as chosen');
    await r.page.click('[data-bh-ratio="250"]');
    const rc1 = (await text(r.page, '#bw-rcpt')).replace(/\s+/g, ' ');
    ok(/Collateral ratio\s*250%/.test(rc1) && (await r.page.$eval('#bw-debt', (x) => x.value)) !== '', `holdborrow: a preset sets the cUSD to borrow (${rc1.trim()})`);
    // A note of another size is cut first, and the receipt says so; an amount no note covers says so too.
    await r.page.evaluate(() => { document.querySelector('#bw-hold details.lockmore').open = true; });
    await r.page.fill('#bh-coll', '0.00025');
    ok(/A note of exactly 0\.00025 cBTC is cut first/.test(await text(r.page, '#bw-rcpt')), 'holdborrow: an amount no note matches says a note is cut first');
    await r.page.fill('#bh-coll', '0.001');
    ok(/You hold 0\.0005 cBTC privately/.test(await text(r.page, '#bw-rcpt')), 'holdborrow: more than the key holds is said');
    await r.page.fill('#bh-coll', '');
    // Borrow at the 200% default against the largest note: no lock record is made for cBTC no lock produced.
    await r.page.fill('#bw-debt', '');
    await r.page.click('#bw-borrow');
    await until(r.page, () => /Borrowed [\d.,]+ cUSD/.test([...document.querySelectorAll('#bw-status, #bw-s4')].map((e) => e.textContent).join(' ')), null, 180000).catch(() => {});
    ok((await calls()) === 'open:30000' && /Borrowed [\d.,]+ cUSD/.test(await bwText(r.page)), `holdborrow: the loan is opened against the largest note (${await calls()} | ${(await bwText(r.page)).replace(/\s+/g, ' ').trim().slice(0, 100)})`);
    ok(!(await r.page.evaluate((p) => localStorage.getItem(`tacit-lite-cbtc-v1:${p}`), pub)), 'holdborrow: no lock record is written for cBTC no lock made');
    await r.page.waitForSelector('#bw-repay', { timeout: 300000 });
    const b1 = await sheet();
    ok(/Your loans\s*\d[\d.,]* cUSD against 0\.0003 cBTC/.test(b1) && /Liquidated below\s*\$[\d,]+ a bitcoin/.test(b1), `holdborrow: the loan is listed with its collateral and liquidation price (${(b1.match(/Your loans.{0,120}/) || [''])[0]})`);
    // The 0.0002 note left is cut to size when a smaller amount is asked for (the single note is more than 0.00015).
    await r.page.evaluate(() => { document.querySelector('#bw-hold details.lockmore').open = true; });
    await r.page.fill('#bh-coll', '0.00015');
    await r.page.fill('#bw-debt', '3');
    await r.page.click('#bw-borrow');
    await until(r.page, () => (window.__hb?.calls || []).filter((c) => c.kind === 'open').length === 2, null, 240000).catch(() => {});
    const cs = await r.page.evaluate(() => window.__hb.calls.map((c) => c.kind + (c.amount ? ':' + c.amount + ':' + c.from : '') + (c.value ? ':' + c.value : '')).join(','));
    ok(/cut:15000:20000,open:15000$/.test(cs), `holdborrow: an amount no note matches is cut to size first, then borrowed against (${cs})`);
    // Repay the first loan.
    await r.page.waitForSelector('#bw-repay', { timeout: 300000 });
    await sleep(2000);
    await r.page.click('#bw-repay');
    await until(r.page, () => /Repaid\./.test([...document.querySelectorAll('#bw-status, #bw-s4')].map((e) => e.textContent).join(' ')), null, 180000).catch(() => {});
    ok((await calls()).endsWith('close') && /Repaid\./.test(await bwText(r.page)), `holdborrow: a loan is repaid from its row (${await calls()} | ${(await bwText(r.page)).replace(/\s+/g, ' ').trim().slice(0, 80)})`);
    if (r.errors.length) { fails++; console.log('FAIL holdborrow page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// tacBTC held in public by the paying account is borrowed against in one transaction: the borrow form offers it, the relay is asked to prove the
// deposit-collateral open (OP_WRAP_CDP_MINT) for exactly that amount, the account signs the tacBTC approval, and the router call is asked of the
// pool before it is sent. The relay's proof here is a stand-in, so the pool refuses the call and nothing is sent: the check is the page's side of it.
await step('holdpublic', async () => {
  const hex = 'b0d2'.padEnd(64, '8');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  const TACBTC = '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696';
  // solady's balance slot: keccak(owner (20 bytes) ‖ 8 zero bytes ‖ 0x87a211a2)
  const balSlot = (owner) => '0x' + Buffer.from(keccak_256(Buffer.concat([Buffer.from(owner.slice(2).toLowerCase(), 'hex'), Buffer.alloc(8), Buffer.from('87a211a2', 'hex')]))).toString('hex');
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 18n).toString(16)]);
  await rpc('anvil_setStorageAt', [TACBTC, balSlot(acct), '0x' + word(30000n * 10n ** 10n)]);
  ok(BigInt(await rpc('eth_call', [{ to: TACBTC, data: '0x70a08231' + addrWord(acct) }, 'latest'])) === 30000n * 10n ** 10n, 'holdpublic: the account holds 0.0003 tacBTC on the fork');
  const r = await openPage({ account: A0, key: K0 });
  const n0 = submits.length, tx0 = walletTxs.length;
  try {
    proveStub = true;
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await go(r.page, '#borrow');
    await r.page.waitForSelector('#bw-hold #bw-borrow', { timeout: 300000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ').slice(0, 300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    await until(r.page, () => !document.querySelector('#bw-rcpt')?.hidden, null, 60000).catch(() => {});
    const b0 = await r.page.evaluate(() => (document.querySelector('#bw-hold')?.textContent || '').replace(/\s+/g, ' '));
    const rc = (await text(r.page, '#bw-rcpt')).replace(/\s+/g, ' ');
    ok(/0\.0003 tacBTC in your Tacit account/.test(b0) && !(await r.page.$('#bw-pts')), `holdpublic: the form offers the tacBTC the account holds (${b0.slice(0, 90)})`);
    ok(/Collateral ratio\s*200%/.test(rc) && /One transaction from your Tacit account/.test(rc), `holdpublic: it sizes at 200% and says it is one transaction (${rc.trim().slice(0, 150)})`);
    await r.page.click('#bw-borrow');
    await until(r.page, () => /Nothing was sent|could not|reverted/i.test([...document.querySelectorAll('#bw-status, #bw-s4')].map((e) => e.textContent).join(' ')), null, 240000).catch(() => {});
    const said = await bwText(r.page);
    const job = submits.slice(n0).find((x) => x.type === 'wrapcdpmint');
    ok(!!job && job.mode === 'prove', `holdpublic: the relay is asked to prove a wrapcdpmint, prove-only (${job ? job.type + ' ' + job.mode : 'none'})`);
    ok(job && job.op.legs.length === 1 && job.op.legs[0].value === '30000' && /^0x[0-9a-f]{64}$/.test(job.op.owner) && job.op.fee === '0' && BigInt(job.op.nonce) === 0n && job.op.depositIds.length === 1,
      `holdpublic: its op deposits all 30000 sats under a fresh position owner, fee-free, nonce 0 (${job ? JSON.stringify({ v: job.op.legs[0].value, fee: job.op.fee }) : ''})`);
    ok(/Nothing was sent: the pool refuses this as it stands/.test(said) && walletTxs.length === tx0, `holdpublic: the router call is asked of the pool first, and nothing is sent when it refuses (${said.replace(/\s+/g, ' ').trim().slice(0, 140)})`);
    ok(BigInt(await rpc('eth_call', [{ to: TACBTC, data: '0x70a08231' + addrWord(acct) }, 'latest'])) === 30000n * 10n ** 10n, 'holdpublic: the tacBTC is where it was');
    if (r.errors.length) { fails++; console.log('FAIL holdpublic page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { proveStub = false; await r.browser.close(); }
});

// ── proving with your own credit ──
// The page's own self-prover.js runs, with the two modules it builds on stood in for: the program input (sp1-stdin.js) and Succinct's
// network (succinct-net.js), whose credit, delay and answer window.__spn sets. Nothing reaches the network.
const PROVE_TKN = '0x6bef15d938d4e72056ac92ea4bdd0d76b1c4ad29', VAPP_ADDR = '0x5ad5bc4b18f7c173dce17a57682cb0dc8788951f';
const SPN_INIT = (cfg) => { window.__spn = Object.assign({ credit: '0', notProved: false, delay: 3000, requests: [], inputs: [], types: null, privateOff: false }, cfg || {}); };
const SP_TYPES = ['wrap', 'unwrap', 'sendunwrap', 'transfer', 'route', 'stealthlock', 'stealthclaim', 'stealthrefund', 'lpremove', 'lpbond', 'bridgeburn', 'bridgemint', 'bridgestealthmint',
  'farmbond', 'farmharvest', 'farmunbond', 'cdpmint', 'cdpclose', 'cdptopup', 'cbtcmint'];
const stubSelfProver = (page) => Promise.all([
  page.route(/\/sp1-stdin\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    const all = ${JSON.stringify(SP_TYPES)};
    export const SELF_PROVE_TYPES = (window.__spn && window.__spn.types) || all;
    export const LIMITS = Object.fromEntries(all.map((t) => [t, { cycleLimit: 1000000n, gasLimit: 1000000n }]));
    export const stdinFor = (type, op) => { window.__spn.inputs.push({ type, memos: (op.memoHashes || []).length }); return new Uint8Array([1, 2, 3]); };
    export const zstdFrame = (b) => b;` })),
  page.route(/\/succinct-net\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    export function makeSuccinctNetwork() {
      const S = () => window.__spn, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      return {
        balance: async () => BigInt(S().credit),
        needWei: async () => 450000000000000000n,
        // privateOff: the network refusing private inputs, as mainnet did from 2026-10-15 22:11 UTC ('auto' then goes public).
        requestProof: async ({ priv, input = 'private', onPublic }) => {
          if (S().privateOff && input !== 'auto') throw Object.assign(new Error('succinct RequestProof: PERMISSION_DENIED - private stdin is not enabled on this network'), { code: 'private_off', grpcStatus: 7 });
          const isPrivate = !S().privateOff;
          if (!isPrivate && onPublic) { onPublic(); await wait(300); }                  // an upload and a request take a moment
          const requestId = '0x' + String(S().requests.length + 1).padStart(64, 'a');
          S().requests.push({ requestId, signed: /^0x[0-9a-f]{64}$/.test(priv), private: isPrivate, input });
          return { requestId, private: isPrivate };
        },
        privateOff: () => !!S().privateOff,
        waitProof: async (id, { onUpdate } = {}) => {
          await wait(800); if (onUpdate) onUpdate({ status: 'assigned' });
          await wait(S().delay);
          if (S().notProved) throw Object.assign(new Error('the request was not proved in time'), { code: 'not_proved' });
          if (onUpdate) onUpdate({ status: 'proved' });
          return { publicValues: '0x' + '01'.repeat(32), proof: '0x' + '02'.repeat(32) };
        },
      };
    }` })),
]);

// Adding PROVE from the wallet: the wallet sends the PROVE the Tacit account lacks, then the vApp's permitAndDeposit with a permit the
// Tacit account signs in the page, which the real vApp on the fork takes (the Tacit account spends no ETH). Then the switch, and its note.
await step('selffund', async () => {
  const hex = '5e1f0'.padEnd(64, '7'), pub = Buffer.from(secp.getPublicKey(hex, true)).toString('hex');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address.toLowerCase();
  const r = await openPage({ account: A0, key: K0, init: { fn: SPN_INIT } });
  await stubSelfProver(r.page);
  const proveOf = async (a) => BigInt(await rpc('eth_call', [{ to: PROVE_TKN, data: '0x70a08231' + addrWord(a) }, 'latest']));
  // Five PROVE for the wallet, from what the vApp holds, on the fork.
  await rpc('anvil_impersonateAccount', [VAPP_ADDR]); await rpc('anvil_setBalance', [VAPP_ADDR, '0x' + (10n ** 18n).toString(16)]);
  await rpc('eth_sendTransaction', [{ from: VAPP_ADDR, to: PROVE_TKN, data: '0xa9059cbb' + addrWord(A0) + word(5n * 10n ** 18n) }]);
  await rpc('anvil_stopImpersonatingAccount', [VAPP_ADDR]);
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#hx-body .hx-h');
    await pasteKey(r.page, hex);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await go(r.page, '#prove-self');
    await r.page.waitForSelector('#sheet-prove[open] #sp-credit', { timeout: 60000 });
    await until(r.page, () => /^0 PROVE/.test(document.querySelector('#sp-credit')?.textContent || ''), null, 60000).catch(() => {});
    const body = () => r.page.evaluate(() => (document.querySelector('#prove-body')?.textContent || '').replace(/\s+/g, ' '));
    const b0 = await body();
    ok(/Your prover account/.test(b0) && b0.toLowerCase().includes(acct.slice(0, 8)) && /Prover credit\s*0 PROVE/.test(b0) && /about 0 proofs/.test(b0) && /shows here a few minutes after it lands/.test(b0) && /Add PROVE/.test(b0) && /Prove my actions with my own credit/.test(b0),
      `selffund: #prove-self opens the sheet: the Tacit account as prover account, its credit, what it pays for, the way to add PROVE, the switch (${b0.slice(260, 760)})`);
    ok(await r.page.evaluate(() => location.hash) === '#prove-self', 'selffund: and keeps its link');
    await r.page.click('#sp-go');                                                     // Connect wallet
    await until(r.page, () => /Add PROVE/.test(document.querySelector('#sp-go')?.textContent || ''), null, 60000);
    await r.page.fill('#sp-amt', '1');
    await until(r.page, () => !document.querySelector('#sp-go').disabled, null, 30000);
    const w0 = walletTxs.length, a0 = await proveOf(acct);
    await r.page.click('#sp-go');
    await until(r.page, () => /Added|class="err"/.test(document.querySelector('#sp-status')?.innerHTML || ''), null, 300000).catch(() => {});
    const said = await text(r.page, '#sp-status'), sent = walletTxs.slice(w0);
    ok(/Added 1 PROVE/.test(said) && /a few minutes after it lands/.test(said), `selffund: from the wallet, PROVE is added (${said.slice(0, 160)})`);
    const t1 = sent.find((x) => String(x.to).toLowerCase() === PROVE_TKN), t2 = sent.find((x) => String(x.to).toLowerCase() === VAPP_ADDR);
    ok(a0 === 0n && t1 && t1.from.toLowerCase() === A0 && t1.data === '0xa9059cbb' + addrWord(acct) + word(10n ** 18n), `selffund: the wallet first sends the PROVE to the Tacit account (${t1?.data?.slice(0, 80)})`);
    // permitAndDeposit(from, amount, deadline, v, r, s): its permit recovers to the Tacit account, over PROVE's own domain.
    const d = (t2?.data || '').slice(10), wd = (i) => d.slice(i * 64, i * 64 + 64);
    let signer = null;
    if (t2) {
      const dom = (await rpc('eth_call', [{ to: PROVE_TKN, data: '0x3644e515' }, 'latest'])).slice(2);
      const k = (b) => Buffer.from(keccak_256(b));
      const typeHash = k(Buffer.from('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
      const struct = k(Buffer.from(typeHash.toString('hex') + wd(0) + addrWord(VAPP_ADDR) + wd(1) + word(0) + wd(2), 'hex'));
      const digest = k(Buffer.from('1901' + dom + struct.toString('hex'), 'hex'));
      const sig = secp.Signature.fromCompact(wd(4) + wd(5)).addRecoveryBit(Number(BigInt('0x' + wd(3))) - 27);
      const pk = sig.recoverPublicKey(digest).toRawBytes(false);
      signer = '0x' + k(pk.slice(1)).subarray(12).toString('hex');
    }
    const vapp0 = await proveOf(VAPP_ADDR);
    ok(t2 && t2.from.toLowerCase() === A0 && t2.data.startsWith('0x58981c7e') && '0x' + wd(0).slice(24) === acct && BigInt('0x' + wd(1)) === 10n ** 18n && signer === acct,
      `selffund: then the wallet sends permitAndDeposit for the Tacit account, its permit signed by that account (${signer})`);
    ok((await proveOf(acct)) === 0n, `selffund: the vApp on the fork takes it: the PROVE has left the Tacit account for its credit (${await proveOf(acct)} left)`);
    // The credit, once the network counts it, and what it pays for.
    await r.page.evaluate(() => { window.__spn.credit = String(2n * 10n ** 18n); });
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#prove-self'; });
    await until(r.page, () => /^2 PROVE/.test(document.querySelector('#sp-credit')?.textContent || ''), null, 60000).catch(() => {});
    ok(/^2 PROVE/.test(await text(r.page, '#sp-credit')) && /about 4 proofs/.test(await text(r.page, '#sp-proofs')), `selffund: the credit and about how many proofs it pays for (${await text(r.page, '#sp-credit')} · ${await text(r.page, '#sp-proofs')})`);
    // The switch: a preference for this key, and each private sheet says so.
    await r.page.click('#sp-on');
    await until(r.page, (p) => localStorage.getItem('tacit-lite-prove-self-v1:' + p) === 'true', pub, 15000).catch(() => {});
    ok(await r.page.evaluate((p) => localStorage.getItem('tacit-lite-prove-self-v1:' + p) === 'true', pub), 'selffund: the switch is kept for this key');
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((x) => x.close()));
    await go(r.page, '#private');
    await r.page.waitForSelector('#sheet-eth[open] .sp-note', { timeout: 30000 }).catch(() => {});
    const note = await text(r.page, '#sheet-eth .sp-note');
    ok(/Proved with your own credit \(about 0\.4 PROVE\) and sent from your wallet/.test(note), `selffund: a private sheet says how its actions are proved and sent (${note})`);
    if (r.errors.length) { fails++; console.log('FAIL selffund page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// Adding PROVE with ETH: a wallet that holds ETH and no PROVE starts on the ETH route; a quick size works the ETH out from zQuoter's price, so
// the credit is enough for that many proofs; pressing it swaps through zRouter to the Tacit account at the quoted price (the ETH typed is the ETH
// spent) and the real vApp on the fork takes the deposit.
await step('selfeth', async () => {
  const hex = '5e1f2'.padEnd(64, '9');
  const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address.toLowerCase();
  const r = await openPage({ account: A0, key: K0, init: { fn: SPN_INIT } });
  await stubSelfProver(r.page);
  const proveOf = async (a) => BigInt(await rpc('eth_call', [{ to: PROVE_TKN, data: '0x70a08231' + addrWord(a) }, 'latest']));
  const held = await proveOf(A0);                                                     // an earlier scenario may have left the wallet some
  if (held > 0n) await rpc('eth_sendTransaction', [{ from: A0, to: PROVE_TKN, data: '0xa9059cbb' + addrWord('0x000000000000000000000000000000000000dead') + word(held) }]);
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#hx-body .hx-h');
    await pasteKey(r.page, hex);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await go(r.page, '#prove-self');
    await r.page.waitForSelector('#sheet-prove[open] #sp-credit', { timeout: 60000 });
    await r.page.click('#sp-go');                                                     // Connect wallet
    await until(r.page, () => document.querySelector('[data-sps="eth"][aria-selected="true"]'), null, 60000).catch(() => {});
    ok(await r.page.evaluate(() => !!document.querySelector('[data-sps="eth"][aria-selected="true"]')), 'selfeth: a wallet with ETH and no PROVE starts on the ETH route');
    const sizes = await text(r.page, '.sp-size');
    ok(/Add enough for 1 proof · 5 proofs · 20 proofs/.test(sizes), `selfeth: quick sizes are offered (${sizes})`);
    await r.page.click('[data-sp-size="5"]');
    await until(r.page, () => /Your credit then covers/.test(document.querySelector('#sp-rcpt')?.textContent || '') && !document.querySelector('#sp-go').disabled, null, 120000).catch(() => {});
    const ethTyped = await r.page.inputValue('#sp-amt'), rcpt = await text(r.page, '#sp-rcpt');
    const covers = Number((/then covers\s*about (\d+) proofs/.exec(rcpt) || [])[1] || 0), least = Number((/At least\s*([\d.]+) PROVE/.exec(rcpt) || [])[1] || 0);
    ok(Number(ethTyped) > 0 && covers >= 5 && covers <= 6 && least >= 2.05, `selfeth: 5 proofs works the ETH out (${ethTyped} ETH: ${rcpt})`);
    const w0 = walletTxs.length;
    await r.page.click('#sp-go');
    await until(r.page, () => /Added|class="err"/.test(document.querySelector('#sp-status')?.innerHTML || ''), null, 300000).catch(() => {});
    const said = await text(r.page, '#sp-status'), sent = walletTxs.slice(w0);
    const swap = sent.find((x) => String(x.to).toLowerCase() === ZROUTER.toLowerCase()), dep = sent.find((x) => String(x.to).toLowerCase() === VAPP_ADDR);
    ok(/Added [\d.]+ PROVE/.test(said), `selfeth: the PROVE is added (${said.slice(0, 160)})`);
    const weiOf = (v) => { const [i, f = ''] = String(v).split('.'); return BigInt(i + (f + '0'.repeat(18)).slice(0, 18)); };
    ok(swap && BigInt(swap.value) === weiOf(ethTyped), `selfeth: the swap spends the ETH shown, through zRouter (${swap?.value})`);
    const d = (dep?.data || '').slice(10), wd = (i) => d.slice(i * 64, i * 64 + 64);
    ok(dep && dep.data.startsWith('0x58981c7e') && '0x' + wd(0).slice(24) === acct && BigInt('0x' + wd(1)) >= 205n * 10n ** 16n && (await proveOf(acct)) === 0n,
      `selfeth: and the vApp takes what it bought for the Tacit account (${dep ? BigInt('0x' + wd(1)) : 'no deposit'}; ${await proveOf(acct)} left in the account)`);
    if (r.errors.length) { fails++; console.log('FAIL selfeth page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// With the switch on, a withdrawal and a swap are proved on the holder's own credit (no submit reaches the relay) and their settles go from the
// paying account; Activity says so. Short credit says what is needed with Add PROVE; a request Succinct's prover did not take offers Try again
// or the relay; an op the credit cannot prove from here goes to the relay with a note; a pool that moved while it was proved says to re-quote.
await step('selfprove', async () => {
  const hex = '5e1f1'.padEnd(64, '8'), pub = Buffer.from(secp.getPublicKey(hex, true)).toString('hex');
  const r = await openPage({ account: A0, key: K0, init: { fn: SPN_INIT, arg: { credit: '0', delay: 4000, types: SP_TYPES.filter((x) => x !== 'stealthlock') } } });
  await stubSelfProver(r.page);
  // Private tETH notes of the key's own (wraps it never made, recovered as its scan would), one for each case below.
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      let made = null;
      ux.balance = async (priv, opts) => {
        const b = await balance(priv, opts);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        made ||= [['5', 0], ['6', 1], ['50', 2], ['40', 3], ['30', 4], ['20', 5]].map(([cents, index]) => {
          const w = ux.buildWrap({ walletPriv: hx, amountWei: (BigInt(cents) * 10n ** 16n).toString(), ticker: 'cETH', index });
          return ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        });
        b.notes = [...b.notes, ...made];
        for (const n of made) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
        return b;
      };
      ux.quoteOpFee = async () => '100000';
      return ux;
    }` }));
  const spn = () => r.page.evaluate(() => window.__spn);
  const said = () => text(r.page, '#v1-status').then((t) => t.replace(/\s+/g, ' '));
  const idle = () => until(r.page, () => !document.querySelector('#sheet-eth [aria-busy="true"]'), null, 600000);
  // A tab holds still while an action in the sheet still runs (its balance read after it): pressed again until it moves.
  const tab = async (m) => {
    await idle();
    for (let i = 0; i < 300; i++) {
      if (await r.page.$eval(`[data-v1="${m}"]`, (b) => b.getAttribute('aria-selected') === 'true').catch(() => false)) return;
      await r.page.click(`[data-v1="${m}"]`).catch(() => {});
      await sleep(2000);
    }
    throw new Error(`the ${m} tab did not open`);
  };
  const withdraw = async (amt) => {
    await tab('out');
    await r.page.fill('#o-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#o-amt', amt);
    await until(r.page, () => !document.querySelector('#o-rcpt')?.hidden && !document.querySelector('#o-go')?.disabled, null, QUOTE_WAIT);
    await r.page.click('#o-go');
  };
  const swap = async (amt) => {
    await tab('swap');
    await r.page.fill('#sw-amt', amt);
    await until(r.page, () => !document.querySelector('#sw-go').disabled || !!document.querySelector('#sw-ack input'), null, QUOTE_WAIT);
    if (await r.page.$('#sw-ack input[type="checkbox"]')) await r.page.check('#sw-ack input[type="checkbox"]');
    else if (await r.page.$('#sw-ack input')) await r.page.fill('#sw-ack input', (await text(r.page, '#sw-ack b')).trim());
    await until(r.page, () => !document.querySelector('#sw-go').disabled, null, 60000);
    await r.page.click('#sw-go');
  };
  const settles = (from) => walletTxs.slice(from).filter((x) => String(x.to).toLowerCase() === POOL_ADDR && x.data.startsWith('0x' + SETTLE_SEL));
  let restore = null;
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#hx-body .hx-h');
    await pasteKey(r.page, hex);
    await r.page.evaluate((p) => localStorage.setItem('tacit-lite-prove-self-v1:' + p, 'true'), pub);
    // The wallet pays, so what the page sends is seen here.
    await toWallet(r.page);
    await r.page.waitForSelector('[data-pay="wallet"]');
    await r.page.click('[data-pay="wallet"]');
    await until(r.page, () => document.querySelector('[data-pay="wallet"]')?.classList.contains('main'));
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await go(r.page, '#private');
    await r.page.waitForSelector('[data-v1="out"]', { timeout: 600000 });
    await until(r.page, () => /Private 1\.51 tETH/.test(document.querySelector('#sheet-eth')?.textContent || ''), null, 600000).catch(() => {});

    // (c) No credit yet: what it is and what this needs, with Add PROVE, which opens the sheet with the withdrawal waiting.
    await withdraw('0.4');
    await until(r.page, () => /Your prover credit is/.test(document.querySelector('#v1-status')?.textContent || ''), null, 300000).catch(() => {});
    ok(/Your prover credit is 0 PROVE; this needs 0\.45 on hand\./.test(await said()) && !!(await r.page.$('#v1-status [data-prove-add]')) && /Let the relay prove this one/.test(await said()),
      `selfprove: with too little credit it says what it is and what this needs, with Add PROVE (${await said()})`);
    await r.page.click('#v1-status [data-prove-add]');
    await r.page.waitForSelector('#sheet-prove[open]', { timeout: 30000 });
    ok(/Waiting to go on: Withdraw 0\.4 ETH/.test(await text(r.page, '#prove-body')), 'selfprove: Add PROVE opens the sheet with the withdrawal waiting to go on');
    await r.page.evaluate(() => document.querySelector('#sheet-prove').close());

    // (b) Credit enough: a whole-note withdrawal is proved on it, step by step on the sheet, and settled from the wallet; nothing reaches the relay.
    await r.page.evaluate(() => { window.__spn.credit = String(10n ** 19n); });
    restore = await stubPoolSettle('ok');
    const s0 = submits.length, w0 = walletTxs.length, q0 = (await spn()).requests.length;
    await withdraw('0.5');
    const stage = await until(r.page, () => /A prover took it/.test(document.querySelector('#v1-status')?.textContent || ''), null, 300000).then(() => true, () => false);
    await until(r.page, () => /Done\./.test(document.querySelector('#v1-status')?.textContent || '') || /class="err"/.test(document.querySelector('#v1-status')?.innerHTML || ''), null, 300000).catch(() => {});
    const one = settles(w0);
    ok(stage && /Done\./.test(await said()) && submits.length === s0 && (await spn()).requests.length === q0 + 1 && one.length === 1 && one[0].from.toLowerCase() === A0 && one[0].data.includes('02'.repeat(32)),
      `selfprove: a withdrawal is proved on the holder's credit (no submit to the relay) and settled from the wallet (${await said()}; submits ${submits.length - s0}, requests ${(await spn()).requests.length - q0}, settles ${one.length})`);
    await openActivity(r.page);
    const row = (await actRows(r.page)).find((x) => x.id.startsWith('op:') && /Withdraw 0\.5 ETH/.test(x.text)) || { text: '' };
    ok(/AskedSuccinctProvingProvedSent/.test(row.text.replace(/\s/g, '')) && /Done in .*proved with your own credit/.test(row.text) && !/public input/.test(row.text), `selfprove: Activity shows its steps and that it was proved with your own credit, privately (${row.text.slice(0, 160)})`);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await go(r.page, '#private');
    await r.page.waitForSelector('[data-v1="swap"]', { timeout: 60000 });

    // (b) A swap, the same: one route over a whole note, proved on the credit, settled from the wallet.
    const s1 = submits.length, w1 = walletTxs.length;
    await swap('0.05');
    await until(r.page, () => /Done\./.test(document.querySelector('#v1-status')?.textContent || '') || /class="err"/.test(document.querySelector('#v1-status')?.innerHTML || ''), null, 300000).catch(() => {});
    ok(/Done\./.test(await said()) && submits.length === s1 && settles(w1).length === 1, `selfprove: a swap is proved on the credit and settled from the wallet, nothing to the relay (${await said()})`);

    // (b2) Succinct's network refusing private inputs: a withdrawal goes with a public input, the sheet says so as it goes, Activity marks
    // it, and it still settles from the wallet with nothing sent to the relay.
    await r.page.evaluate(() => { window.__spn.privateOff = true; });
    const sP = submits.length, wP = walletTxs.length, qP = (await spn()).requests.length;
    const sawPublic = r.page.waitForFunction(() => /goes with a public input, which anyone can read/.test(document.querySelector('#v1-status')?.textContent || ''), null, { timeout: 120000, polling: 100 }).then(() => true, () => false);
    await withdraw('0.2');
    await until(r.page, () => /Done\./.test(document.querySelector('#v1-status')?.textContent || '') || /class="err"/.test(document.querySelector('#v1-status')?.innerHTML || ''), null, 300000).catch(() => {});
    const pubReqs = (await spn()).requests.slice(qP);
    ok(await sawPublic && /Done\./.test(await said()) && submits.length === sP && settles(wP).length === 1 && pubReqs.length === 1 && pubReqs[0].private === false && pubReqs[0].input === 'auto',
      `selfprove: with private inputs refused, a withdrawal goes with a public input, says so, and still settles from the wallet (${await said()}; ${JSON.stringify(pubReqs.map((x) => ({ private: x.private, input: x.input })))})`);
    await openActivity(r.page);
    const pubRow = (await actRows(r.page)).find((x) => x.id.startsWith('op:') && /Withdraw 0\.2 ETH/.test(x.text)) || { text: '' };
    ok(/proved with your own credit \(public input\)/.test(pubRow.text), `selfprove: Activity marks it as proved with a public input (${pubRow.text.slice(0, 160)})`);
    await r.page.evaluate(() => { window.__spn.privateOff = false; document.querySelectorAll('dialog[open]').forEach((d) => d.close()); });
    await go(r.page, '#private');
    await r.page.waitForSelector('[data-v1="swap"]', { timeout: 60000 });
    await restore(); restore = null;

    // (f) The pool moved while the swap was proved: the pool refuses it before anything is sent, and says to quote again.
    restore = await stubPoolSettle('29b3c833');
    const w2 = walletTxs.length;
    await swap('0.06');
    await until(r.page, () => /pool moved|class="err"/.test(document.querySelector('#v1-status')?.innerHTML || ''), null, 300000).catch(() => {});
    ok(/Nothing was sent\. The pool moved while it was being proved; press again for a fresh quote\./.test(await said()) && settles(w2).length === 0, `selfprove: a pool that moved while it was proved says to quote again, with nothing sent (${await said()})`);
    await restore(); restore = null;

    // (d) Succinct's prover did not take it: Try again, or let the relay prove this one, which then goes out from the wallet.
    await r.page.evaluate(() => { window.__spn.notProved = true; });
    await withdraw('0.3');
    await until(r.page, () => /did not take it in time/.test(document.querySelector('#v1-status')?.textContent || ''), null, 300000).catch(() => {});
    const np = await said();
    ok(/Succinct’s prover did not take it in time\. Nothing was sent; the network kept its base fee \(about 0\.39 PROVE\)\./.test(np) && /Try again/.test(np) && /Let the relay prove this one/.test(np), `selfprove: a request Succinct's prover did not take offers Try again or the relay (${np})`);
    proveStub = true; restore = await stubPoolSettle('ok');
    const s3 = submits.length, w3 = walletTxs.length;
    await r.page.click('#v1-status [data-selfdo]:last-of-type');
    // The offer's own line reads as an error until the relay's proof is sent: wait for the outcome.
    await until(r.page, () => /Done\./.test(document.querySelector('#v1-status')?.textContent || ''), null, 300000).catch(() => {});
    const asked = submits.slice(s3);
    ok(asked.length === 1 && asked[0].type === 'unwrap' && asked[0].mode === 'prove' && settles(w3).length === 1 && /Done\./.test(await said()), `selfprove: the relay proves that one, and it goes out from the wallet (${asked.map((x) => `${x.type}/${x.mode}`).join(', ')}; ${await said()})`);
    await restore(); restore = null; proveStub = false;
    await r.page.evaluate(() => { window.__spn.notProved = false; });

    // (e) A private send: the credit cannot prove that op from here, so the relay takes it, with a note.
    await tab('send');
    await r.page.fill('#s-to', tacit1('abd'.padEnd(64, '9')));
    await r.page.fill('#s-amt', '0.2');
    await until(r.page, () => /They get about/.test(document.querySelector('#s-rcpt')?.textContent || '') && !document.querySelector('#s-go').disabled, null, QUOTE_WAIT);
    const s4 = submits.length;
    await r.page.click('#s-go');
    await until(r.page, () => /can’t prove this one from here yet/.test(document.querySelector('#toast-container')?.textContent || ''), null, 120000).catch(() => {});
    await chainUntil(async () => submits.length > s4, 120000);
    ok(/Your own credit can’t prove this one from here yet, so Tacit’s relay proves it\./.test(await text(r.page, '#toast-container')) && submits.slice(s4).some((x) => x.type === 'stealthlock' && !x.mode),
      `selfprove: an op the credit cannot prove goes to the relay, with a note (${submits.slice(s4).map((x) => `${x.type}/${x.mode || 'settle'}`).join(', ')})`);
    if (r.errors.length) { fails++; console.log('FAIL selfprove page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { proveStub = false; if (restore) await restore(); await r.browser.close(); }
});

// What the relay says of itself decides how an action goes before anything is handed to it. Paused: nothing is submitted, and the sheet offers
// proving it yourself, and keeping it in line for an op that does not expire. Held: the wallet sends it (the relay proves it). In Activity, an
// exit in line while the relay is paused says why and offers proving it yourself.
await step('relaystate', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'ce1a'.padEnd(64, '6');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      let made = null;
      ux.balance = async (priv, opts) => {
        const b = await balance(priv, opts);
        const hx = typeof priv === 'string' ? priv : '0x' + [...priv].map((x) => x.toString(16).padStart(2, '0')).join('');
        made ||= [['50', 0], ['30', 1]].map(([cents, index]) => {
          const w = ux.buildWrap({ walletPriv: hx, amountWei: (BigInt(cents) * 10n ** 16n).toString(), ticker: 'cETH', index });
          return ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], hx)[0];
        });
        const n = made[0]; window.__stubKey = 'n:' + String(n.leaf || n.nullifier || (n.cx + ':' + n.cy)).toLowerCase();
        b.notes = [...b.notes, ...made];
        for (const x of made) { const g = b.byAsset[x.asset] ||= { asset: x.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(x.value); g.notes = [...g.notes, x]; }
        return b;
      };
      ux.quoteOpFee = async () => '100000';
      return ux;
    }` }));
  const said = () => text(r.page, '#v1-status').then((t) => t.replace(/\s+/g, ' '));
  const idle = () => until(r.page, () => !document.querySelector('#sheet-eth [aria-busy="true"]'), null, 600000);
  // A tab holds still while an action in the sheet still runs (its balance read after it): pressed again until it moves.
  const tab = async (m) => {
    await idle();
    for (let i = 0; i < 300; i++) {
      if (await r.page.$eval(`[data-v1="${m}"]`, (b) => b.getAttribute('aria-selected') === 'true').catch(() => false)) return;
      await r.page.click(`[data-v1="${m}"]`).catch(() => {});
      await sleep(2000);
    }
    throw new Error(`the ${m} tab did not open`);
  };
  const withdraw = async (amt) => {
    await tab('out');
    await r.page.fill('#o-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#o-amt', amt);
    await until(r.page, () => !document.querySelector('#o-rcpt')?.hidden && !document.querySelector('#o-go')?.disabled, null, QUOTE_WAIT);
    await r.page.click('#o-go');
  };
  let restore = null;
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#hx-body .hx-h');
    await pasteKey(r.page, hex);
    await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await go(r.page, '#private');
    await r.page.waitForSelector('[data-v1="out"]', { timeout: 600000 });
    await until(r.page, () => /Private 0\.8 tETH/.test(document.querySelector('#sheet-eth')?.textContent || ''), null, 600000).catch(() => {});

    // Paused at the press: a withdrawal (which expires) is not handed over; proving it yourself is offered, keeping it in line is not.
    relayStateNow = 'paused';
    const s0 = submits.length;
    await withdraw('0.1');
    await until(r.page, () => /isn’t proving right now/.test(document.querySelector('#v1-status')?.textContent || ''), null, 300000).catch(() => {});
    ok(/The relay isn’t proving right now, so nothing was sent to it\./.test(await said()) && !!(await r.page.$('#v1-status [data-prove-add]')) && !(await r.page.$('#v1-status [data-keepline]')) && submits.length === s0,
      `relaystate: paused at the press, a withdrawal offers proving it yourself, not the line, and nothing is submitted (${await said()})`);
    // A private send does not expire: it can wait its turn in line, and pressed, goes to the relay.
    await tab('send');
    await r.page.fill('#s-to', tacit1('abd'.padEnd(64, '5')));
    await r.page.fill('#s-amt', '0.3');
    await until(r.page, () => /They get about/.test(document.querySelector('#s-rcpt')?.textContent || '') && !document.querySelector('#s-go').disabled, null, QUOTE_WAIT);
    await r.page.click('#s-go');
    await until(r.page, () => !!document.querySelector('#v1-status [data-keepline]'), null, 300000).catch(() => {});
    ok(!!(await r.page.$('#v1-status [data-keepline]')) && !!(await r.page.$('#v1-status [data-prove-add]')) && submits.length === s0, `relaystate: a private send offers both, with nothing submitted yet (${await said()})`);
    if (await r.page.$('#v1-status [data-keepline]')) {
      await r.page.click('#v1-status [data-keepline]');
      await chainUntil(async () => submits.length > s0, 120000);
      ok(submits.slice(s0).some((x) => x.type === 'stealthlock' && !x.mode), `relaystate: Keep it in line hands it to the relay (${submits.slice(s0).map((x) => x.type).join(', ')})`);
    }
    // Held at the press: the withdrawal goes out from the paying account, the relay proving it.
    relayStateNow = 'held';
    await sleep(16000);                                                          // the page reads the relay's state at most every 15 seconds
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await go(r.page, '#private');
    await r.page.waitForSelector('[data-v1="out"]', { timeout: 60000 });
    await withdraw('0.5');
    await until(r.page, () => /can’t send this one right now/.test(document.querySelector('#v1-status')?.textContent || ''), null, 300000).catch(() => {});
    const held = await said();
    ok(/The relay can’t send this one right now\./.test(held) && /Send it from your Tacit account: the relay proves it, and your Tacit account pays the network fee/.test(held) && !/Keep it in line/.test(held),
      `relaystate: held at the press, the withdrawal is offered from the paying account, the relay proving it (${held})`);
    proveStub = true; restore = await stubPoolSettle('ok');
    const s1 = submits.length;
    if (await r.page.$('#v1-status [data-selfdo]')) await r.page.click('#v1-status [data-selfdo]');
    await until(r.page, () => /Done\./.test(document.querySelector('#v1-status')?.textContent || ''), null, 300000).catch(() => {});
    ok(/Done\./.test(await said()) && submits.slice(s1).some((x) => x.type === 'unwrap' && x.mode === 'prove'), `relaystate: and it goes out, proved by the relay (${submits.slice(s1).map((x) => `${x.type}/${x.mode || 'settle'}`).join(', ')}; ${await said()})`);
    await restore(); restore = null; proveStub = false;

    // Activity: an exit in line while the relay is paused says why, and offers proving it yourself.
    relayStateNow = 'paused';
    await r.ctx.route(/\/confidential\/status\?id=rs-exit/, (route) => json(route, { jobId: 'rs-exit', type: 'unwrap', mode: 'settle', status: 'pending', txHash: null, error: null, createdAt: Date.now() }));
    await r.page.evaluate(() => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k) || '{"items":[]}'), t = Date.now();
      s.items.unshift({ id: 'job:rs-exit', kind: 'job', type: 'unwrap', label: 'Withdraw 0.5 ETH', status: 'pending', at: t - 120e3, up: t - 120e3,
        self: { exit: { to: '0x000000000000000000000000000000000000dEaD', units: '50000000', note: window.__stubKey, from: 'eth', sheet: 'eth' } } });
      dispatchEvent(new StorageEvent('storage', { key: k, newValue: JSON.stringify(s) }));
    });
    await openActivity(r.page);
    const rowText = () => r.page.evaluate(() => (document.querySelector('[data-act="job:rs-exit"]')?.textContent || '').replace(/\s+/g, ' '));
    await until(r.page, () => /isn’t proving right now/.test(document.querySelector('[data-act="job:rs-exit"]')?.textContent || '') && !!document.querySelector('[data-act="job:rs-exit"] [data-prove-open]'), null, 90000).catch(() => {});
    const row = await rowText();
    ok(/In line: the relay isn’t proving right now\. It keeps its place and goes through once it is\./.test(row) && !!(await r.page.$('[data-act="job:rs-exit"] [data-prove-open]')) && !/gas|credit is low|out of/i.test(row),
      `relaystate: an exit in line while the relay is paused says why and offers proving it yourself (${row.slice(0, 260)})`);
    if (r.errors.length) { fails++; console.log('FAIL relaystate page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { relayStateNow = 'ok'; proveStub = false; if (restore) await restore(); await r.browser.close(); }
});

// A relayed harvest whose proof the relay could not make (it reaches the page as "settle failed: prove failed: …"): the sheet says so in plain
// words and offers proving it yourself.
await step('relayfail', async () => {
  const r = await openFarmKey('0fe2'.padEnd(64, '6'), { notes: [], positions: [farmPos(7, 150000000, 1234560000, '12.3456')], chain: true, held: true });
  const p = r.page, was = statusError;
  try {
    statusError = 'prove failed: insufficient balance';
    await go(p, '#farm');
    await p.waitForSelector('[data-harvest="0"]', { timeout: 300000 });
    await p.click('[data-harvest="0"]');
    await until(p, () => !!document.querySelector('#sf-act-0 [data-prove-add]'), null, 180000).catch(() => {});
    const line = (await text(p, '#sf-act-0')).replace(/\s+/g, ' ');
    ok(!!(await p.$('#sf-act-0 [data-prove-add]')) && /can’t prove this one right now/.test(line) && /Prove it yourself/.test(line) && !/insufficient|balance|credit is low/i.test(line),
      `relayfail: a relayed job whose proof failed offers proving it yourself, in plain words (${line})`);
    if (r.errors.length) { fails++; console.log('FAIL relayfail page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { statusError = was; await r.browser.close(); }
});

if (ACCT) await ACCT.r.browser.close();

if (main.errors.length) { fails++; console.log('FAIL page errors:\n  ' + main.errors.slice(0, 8).join('\n  ')); }
console.log(fails ? `${fails} failed` : 'all passed');
await main.browser.close(); server.close(); anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
