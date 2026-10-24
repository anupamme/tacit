// Discord TAC gate: the signed /verify interaction hands back a link to the page that hosts the gate,
// a bad signature is refused, and the role is granted before the nonce is consumed. The ZK proof
// verifier is not exercised here (it needs live TAC outpoints); this drives everything around it.
//
// Run: `node tests/discord-gate.test.mjs`

import { generateKeyPairSync, sign } from 'node:crypto';
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
const m = /https:\/\/tacit\.finance\/classic\.html#gate=([0-9a-f]{32})/.exec(cmdBody.data?.content || '');
ok('link goes to the page that hosts the gate modal', !!m, cmdBody.data?.content);
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
globalThis.fetch = (url, init) => {
  if (String(url).startsWith('https://discord.com/')) { call = { url: String(url), init }; return Promise.resolve(reply()); }
  return realFetch(url, init);
};

reply = () => new Response(JSON.stringify({ message: 'Missing Permissions', code: 50013 }), { status: 403 });
const refused = await workerMod.completeDiscordGate(env, m[1], rec, 'ab'.repeat(33));
ok('a refused grant is reported with Discord\'s reason', !refused.ok && refused.status === 502
  && /403/.test(refused.reason) && /Missing Permissions/.test(refused.reason), refused);
ok('a refused grant leaves the nonce pending', (await env.REGISTRY_KV.get(`dgate:${m[1]}`, 'json')).status === 'pending');

reply = () => { throw new Error('socket hang up'); };
const down = await workerMod.completeDiscordGate(env, m[1], rec, 'ab'.repeat(33));
ok('an unreachable Discord is reported, nonce still pending', !down.ok && /socket hang up/.test(down.reason)
  && (await env.REGISTRY_KV.get(`dgate:${m[1]}`, 'json')).status === 'pending', down);

reply = () => new Response(null, { status: 204 });
const good = await workerMod.completeDiscordGate(env, m[1], rec, 'ab'.repeat(33));
ok('an accepted grant succeeds', good.ok === true, good);
ok('the grant is a PUT of the holder role on that member',
  call.init.method === 'PUT' && call.url === `https://discord.com/api/v10/guilds/${G}/members/${U}/roles/${env.TAC_ROLE_ID}`, call);
ok('the grant authenticates as the bot', call.init.headers.Authorization === 'Bot bot-token');
const after = await env.REGISTRY_KV.get(`dgate:${m[1]}`, 'json');
ok('the nonce is consumed only after the grant', after.status === 'verified' && after.pubkey_hex === 'ab'.repeat(33), after);

globalThis.fetch = realFetch;
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
