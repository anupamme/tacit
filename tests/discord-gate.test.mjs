// Discord TAC gate: the signed /verify interaction hands back a link to the Discord page, a bad signature is
// refused, a holder's Ethereum signature earns the role if the account holds 100 TAC in the public ERC-20, and the
// role is granted before the link is consumed. The Bitcoin ZK proof verifier is not exercised here (it needs live
// TAC outpoints); this drives everything around it.
//
// Run: `node tests/discord-gate.test.mjs`

import { generateKeyPairSync, sign } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { readFileSync } from 'node:fs';
import { discordGateMessage, DISCORD_MIN_TAC_BASE_UNITS, DISCORD_MIN_TAC_ERC20 } from '../dapp/discord/message.js';
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });
const { buildEnv, createCtxFactory, createTacitServer } = await import('../server/harness.mjs');
const workerMod = await import('../worker/src/index.js');
const workerModule = workerMod.default;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

const driver = createMemDriver();
const env = buildEnv(driver);
env.DISCORD_PUBLIC_KEY = pubHex;
const server = createTacitServer({ workerModule, env, driver, ctxFactory: createCtxFactory() });
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

function post(interaction, { badSig = false } = {}) {
  const body = JSON.stringify(interaction);
  const ts = String(Math.floor(Date.now() / 1000));
  let sig = sign(null, Buffer.from(ts + body), privateKey).toString('hex');
  if (badSig) sig = sig.replace(/^../, (b) => (b === '00' ? '01' : '00'));
  return fetch(`${base}/discord/interaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts },
    body,
  });
}

const U = '123456789012345678', G = '223456789012345678';

// Discord's endpoint check
const ping = await post({ type: 1 });
ok('PING is answered with PONG', ping.status === 200 && (await ping.json()).type === 1);
const bad = await post({ type: 1 }, { badSig: true });
ok('bad signature is refused', bad.status === 401);
const unsigned = await fetch(`${base}/discord/interaction`, { method: 'POST', body: '{"type":1}' });
ok('unsigned request is refused', unsigned.status === 401);

// /verify in a server
const cmd = await post({ type: 2, data: { name: 'verify' }, guild_id: G, member: { user: { id: U } }, token: 't' });
const cmdBody = await cmd.json();
ok('/verify replies inline and ephemeral', cmd.status === 200 && cmdBody.type === 4 && cmdBody.data.flags === 64, cmdBody);
const m = /https:\/\/tacit\.finance\/discord\/#gate=([0-9a-f]{32})/.exec(cmdBody.data?.content || '');
ok('link goes to the Discord page', !!m, cmdBody.data?.content);
const rec = m && await env.REGISTRY_KV.get(`dgate:${m[1]}`, 'json');
ok('nonce is stored pending for that member and server',
  rec && rec.status === 'pending' && rec.discord_user_id === U && rec.guild_id === G, rec);

// /verify in a DM
const dm = await post({ type: 2, data: { name: 'verify' }, user: { id: U }, token: 't' });
ok('/verify outside a server says so', (await dm.json()).data?.content === 'This command only works in a server.');

// role grant: refused until configured, and the nonce survives a refused grant
const noCfg = await fetch(`${base}/discord/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nonce: m[1], envelope_hex: 'a'.repeat(120) }),
});
ok('verify refuses before checking a proof when the role grant is not configured', noCfg.status === 500);

env.DISCORD_BOT_TOKEN = 'bot-token';
env.TAC_ROLE_ID = '323456789012345678';
const realFetch = globalThis.fetch;
let call = null, reply = () => new Response(null, { status: 204 });
// The worker reads balanceOf(address) through these nodes: each holder's TAC (18 decimals) is answered here, an unknown address holds none.
const TAC = 10n ** 18n;
const balances = new Map();
let rpcDown = false;
globalThis.fetch = (url, init) => {
  if (String(url).startsWith('https://discord.com/')) { call = { url: String(url), init }; return Promise.resolve(reply()); }
  if (/^https:\/\/(ethereum-rpc\.publicnode\.com|rpc\.mevblocker\.io|eth\.merkle\.io)/.test(String(url))) {
    if (rpcDown) return Promise.resolve(new Response('down', { status: 503 }));
    const { params } = JSON.parse(init.body);
    const who = '0x' + params[0].data.slice(-40);
    const result = '0x' + (balances.get(who) ?? 0n).toString(16).padStart(64, '0');
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } }));
  }
  return realFetch(url, init);
};

reply = () => new Response(JSON.stringify({ message: 'Missing Permissions', code: 50013 }), { status: 403 });
const refused = await workerMod.completeDiscordGate(env, m[1], rec, 'eth:0x' + 'ab'.repeat(20));
ok('a refused grant is reported with Discord\'s reason', !refused.ok && refused.status === 502
  && /403/.test(refused.reason) && /Missing Permissions/.test(refused.reason), refused);
ok('a refused grant leaves the nonce pending', (await env.REGISTRY_KV.get(`dgate:${m[1]}`, 'json')).status === 'pending');

reply = () => { throw new Error('socket hang up'); };
const down = await workerMod.completeDiscordGate(env, m[1], rec, 'eth:0x' + 'ab'.repeat(20));
ok('an unreachable Discord is reported, nonce still pending', !down.ok && /socket hang up/.test(down.reason)
  && (await env.REGISTRY_KV.get(`dgate:${m[1]}`, 'json')).status === 'pending', down);

reply = () => new Response(null, { status: 204 });
const good = await workerMod.completeDiscordGate(env, m[1], rec, 'eth:0x' + 'ab'.repeat(20));
ok('an accepted grant succeeds', good.ok === true, good);
ok('the grant is a PUT of the holder role on that member',
  call.init.method === 'PUT' && call.url === `https://discord.com/api/v10/guilds/${G}/members/${U}/roles/${env.TAC_ROLE_ID}`, call);
ok('the grant authenticates as the bot', call.init.headers.Authorization === 'Bot bot-token');
const after = await env.REGISTRY_KV.get(`dgate:${m[1]}`, 'json');
ok('the nonce is consumed only after the grant', after.status === 'verified' && after.holder === 'eth:0x' + 'ab'.repeat(20), after);

// ── an Ethereum holder, through the route the page uses ──
env.GOV_TAC_ERC20_MAINNET = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
const holderOf = (seed) => {
  const priv = sha256(new TextEncoder().encode(seed));
  return { priv, addr: '0x' + bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12)) };
};
async function personalSign(priv, text) {
  const m = new TextEncoder().encode(text);
  const sig = await secp.signAsync(keccak_256(concatBytes(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${m.length}`), m)), priv);
  return '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
}
async function newNonce() {
  const r = await post({ type: 2, data: { name: 'verify' }, guild_id: G, member: { user: { id: U } }, token: 't' });
  return /#gate=([0-9a-f]{32})/.exec((await r.json()).data.content)[1];
}
const verify = (body) => fetch(`${base}/discord/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const status = async (n) => (await env.REGISTRY_KV.get(`dgate:${n}`, 'json')).status;
reply = () => new Response(null, { status: 204 });

const rich = holderOf('discord-holder-250tac'), poor = holderOf('discord-holder-99tac'), exact = holderOf('discord-holder-100tac'), nobody = holderOf('discord-holder-none');
balances.set(rich.addr, 250n * TAC); balances.set(poor.addr, 100n * TAC - 1n); balances.set(exact.addr, 100n * TAC);

let n1 = await newNonce(); call = null;
let res = await verify({ nonce: n1, eth_sig: await personalSign(rich.priv, discordGateMessage(n1)) });
ok('an account holding 250 TAC in the ERC-20 gets the role', res.status === 200 && (await res.json()).ok === true);
ok('the role went to the member the link was made for', call?.init.method === 'PUT' && call.url.endsWith(`/guilds/${G}/members/${U}/roles/${env.TAC_ROLE_ID}`), call);
const held = await env.REGISTRY_KV.get(`dgate:${n1}`, 'json');
ok('the link is used and names the Ethereum holder', held.status === 'verified' && held.holder === `eth:${rich.addr}`, held);
res = await verify({ nonce: n1, eth_sig: await personalSign(rich.priv, discordGateMessage(n1)) });
ok('a used link is refused', res.status === 409);

let n2 = await newNonce(); call = null;
res = await verify({ nonce: n2, eth_sig: await personalSign(poor.priv, discordGateMessage(n2)) });
ok('a wei under 100 TAC is not enough', res.status === 403 && /less than the TAC required/.test((await res.json()).error));
ok('and no role is asked for, the link stays good', call === null && await status(n2) === 'pending');

let nx = await newNonce(); call = null;
res = await verify({ nonce: nx, eth_sig: await personalSign(exact.priv, discordGateMessage(nx)) });
ok('exactly 100 TAC is enough', res.status === 200 && call?.init.method === 'PUT', res.status);

// a signature made for one link is worth nothing on another: it recovers a different account, which holds nothing
let n3 = await newNonce(); call = null;
const stolen = await personalSign(rich.priv, discordGateMessage(n2));
res = await verify({ nonce: n3, eth_sig: stolen });
ok('a signature made for another link is refused', res.status === 403 && call === null && await status(n3) === 'pending');

res = await verify({ nonce: n3, eth_sig: await personalSign(nobody.priv, discordGateMessage(n3)) });
ok('an account with no TAC is refused', res.status === 403);
res = await verify({ nonce: n3, eth_sig: '0x1234' });
ok('a malformed signature is refused', res.status === 400);
res = await verify({ nonce: n3 });
ok('neither a signature nor a proof is refused', res.status === 400);

rpcDown = true;
res = await verify({ nonce: n3, eth_sig: await personalSign(rich.priv, discordGateMessage(n3)) });
ok('a balance that cannot be read is a retry, not a refusal of the holder', res.status === 502 && await status(n3) === 'pending', res.status);
rpcDown = false;

const saved = env.GOV_TAC_ERC20_MAINNET; delete env.GOV_TAC_ERC20_MAINNET;
res = await verify({ nonce: n3, eth_sig: await personalSign(rich.priv, discordGateMessage(n3)) });
ok('without a configured ERC-20 the route says so', res.status === 501);
env.GOV_TAC_ERC20_MAINNET = saved;

reply = () => new Response(JSON.stringify({ message: 'Missing Permissions', code: 50013 }), { status: 403 });
res = await verify({ nonce: n3, eth_sig: await personalSign(rich.priv, discordGateMessage(n3)) });
ok('a holder whose role Discord refuses is told why and can try again', res.status === 502 && /Missing Permissions/.test((await res.json()).error) && await status(n3) === 'pending');
reply = () => new Response(null, { status: 204 });
res = await verify({ nonce: n3, eth_sig: await personalSign(rich.priv, discordGateMessage(n3)) });
ok('and the retry on the same link gets the role', res.status === 200 && await status(n3) === 'verified');

// the figure is one: the page's ERC-20 reading, the API's two checks and the Classic modal's Bitcoin proof all ask for the same TAC
ok('100 TAC in base units, and the ERC-20 figure is the same TAC at 18 decimals', DISCORD_MIN_TAC_BASE_UNITS === 10_000_000_000n && DISCORD_MIN_TAC_ERC20 === 100n * TAC);
const engine = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8');
const engineMin = /const DISCORD_GATE_MIN_TAC_BASE_UNITS = ([^;]+);/.exec(engine)?.[1];
ok('tacit.js proves the Bitcoin threshold at the same figure', engineMin && Function(`return ${engineMin}`)() === DISCORD_MIN_TAC_BASE_UNITS, engineMin);
ok('and builds its envelope at that threshold', /thresholdX: DISCORD_GATE_MIN_TAC_BASE_UNITS/.test(engine));

globalThis.fetch = realFetch;
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
