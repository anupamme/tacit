// Airdrop and points for one account: a 0x address, or a .eth, .wei or .gwei name that points to one. All of it is read and nothing is sent;
// a claim goes through the dapp, where the account connects (the links below), so this page never asks for a wallet.
import { secp, keccak_256 } from '/vendor/tacit-deps.min.js';
import { makeConfidentialNames, makeMainnetCall, MAINNET_RPCS, NameError } from '/confidential-names.js?cb=7bb10833';
import { makeTacAirdrop, makeRpcCall } from '/tac-airdrop.js?cb=02ef61b4';

const API = 'https://api.tacit.finance', DISTRIBUTOR = '0x000000C918e44A3a443937fA7594eA4f7C95D6b9', BOARD = 500;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const names = makeConfidentialNames({ call: makeMainnetCall({}), secp, keccak256: keccak_256 });
const call = makeRpcCall({ rpcs: MAINNET_RPCS });
const air = makeTacAirdrop({ call, keccak256: keccak_256 });
const get = (path) => fetch(`${API}/${path}`, { signal: AbortSignal.timeout(20e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// An amount of TAC (18 decimals) to `dp` places, grouped, trailing zeros dropped; under the smallest place it says so.
function tac(wei, dp = 2) {
  const v = BigInt(wei), unit = 10n ** BigInt(18 - dp), r = (v + unit / 2n) / unit;
  if (v > 0n && r === 0n) return `< ${(0.1 ** dp).toFixed(dp)}`;
  const s = r.toString().padStart(dp + 1, '0'), int = s.slice(0, s.length - dp), frac = s.slice(s.length - dp).replace(/0+$/, '');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
}
const day = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// EIP-55: an address in mixed case has to match its checksum; one in a single case carries none.
function checksumOk(a) {
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const h = Array.from(keccak_256(new TextEncoder().encode(body.toLowerCase())), (x) => x.toString(16).padStart(2, '0')).join('');
  return [...body.toLowerCase()].every((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c) === body[i]);
}

// Who was asked for: the address, and the name it came from when it was a name. Throws what the person should read.
async function identify(raw) {
  const s = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    if (!checksumOk(s)) throw new Error('That address has a bad checksum. Check it for typos.');
    return { address: s.toLowerCase(), name: null };
  }
  if (/^\S+\.\S+$/.test(s)) {
    let r;
    try { r = await names.resolveAddress(s.toLowerCase()); } catch (e) { throw new Error(e instanceof NameError ? e.message : 'Could not read that name just now. Try again.'); }
    if (!r) throw new Error(`${s.toLowerCase()} has no address set.`);
    return { address: r.address, name: r.name };
  }
  throw new Error('Enter a 0x address, or a name ending in .eth, .wei or .gwei.');
}

// The points service's reading of the address, what the distributor says it can claim, and its place on the board.
async function readPoints(address) {
  const [p, c, board] = await Promise.all([get(`points/${address}`), get(`claim/${address}`), get(`leaderboard?limit=${BOARD}`)]);
  if (!p) return { error: true };
  let owed = 0n, unread = false;
  if (c?.proof && c.cumulativeAmount) {                                              // the distributor's own figure, not the service's copy of it
    try { owed = BigInt(await call({ to: DISTRIBUTOR, data: `0x787eef2e${address.slice(2).padStart(64, '0')}${BigInt(c.cumulativeAmount).toString(16).padStart(64, '0')}` })); } catch { unread = true; }
  }
  const i = Array.isArray(board) ? board.findIndex((e) => String(e.address).toLowerCase() === address) : -1;
  return {
    points: Number(p.points) || 0, earned: BigInt(c?.cumulativeAmount || 0), claimed: BigInt(c?.claimedWei || 0), owed, unread,
    rank: i >= 0 ? i + 1 : Array.isArray(board) && board.length >= BOARD ? 0 : null,
  };
}

const card = (title, body) => `<section class="card"><h2>${title}</h2>${body}</section>`;
function airdropCard(s) {
  if (s.reason === 'error') return card('Airdrop', '<p class="st warn">Could not read the airdrop just now. Look up again in a moment.</p>');
  if (!s.eligible) return card('Airdrop', '<p class="big">—</p><p class="st mute">Not on the airdrop list.</p>');
  const by = day(s.deadline);
  const [cls, line] = s.claimed ? ['ok', 'Claimed'] : s.claimable ? ['ok', `Claim by ${by}`] : s.reason === 'closed' ? ['mute', `Closed ${by}`] : ['warn', s.message];
  return card('Airdrop', `<p class="big num">${tac(s.amountWei)}<small>TAC</small></p><p class="st ${cls}">${esc(line)}</p>${s.claimable ? `<a class="act" href="/#airdrop">Claim ${tac(s.amountWei)} TAC</a>` : ''}`);
}
function pointsCard(p) {
  if (p.error) return card('Points', '<p class="st warn">Could not read points just now. Look up again in a moment.</p>');
  const rank = p.points <= 0 ? '' : p.rank > 0 ? `Rank #${p.rank.toLocaleString('en-US')}` : p.rank === 0 ? `Outside the top ${BOARD}` : '';
  const rows = p.earned > 0n ? [['Earned on settled days', `${tac(p.earned)} TAC`], ['Claimed', `${tac(p.claimed)} TAC`], ['To claim', p.unread ? 'not read' : `${tac(p.owed)} TAC`]] : [];
  return card('Points', `<p class="big num">${Math.round(p.points).toLocaleString('en-US')}<small>points</small></p>${rank ? `<p class="st mute">${rank}</p>` : p.points <= 0 ? '<p class="st mute">No points yet.</p>' : ''}`
    + (rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd class="num">${v}</dd></div>`).join('')}</dl>` : '')
    + (p.owed > 0n ? `<a class="act" href="/#points">Claim ${tac(p.owed)} TAC</a>` : ''));
}
const whoLine = (who) => `<p class="who"><b>${esc(who.name || short(who.address))}</b><a href="https://etherscan.io/address/${who.address}" target="_blank" rel="noopener noreferrer">${who.name ? short(who.address) : 'Etherscan ↗'}</a></p>`;
const SKELETON = `<p class="who"><b><span class="sk"></span></b></p>${card('Airdrop', '<p class="big"><span class="sk"></span></p>')}${card('Points', '<p class="big"><span class="sk"></span></p>')}`;

let seq = 0;
async function run(raw) {
  const my = ++seq, out = $('#out'), input = $('#q'), go = $('#go'), q = raw.trim();
  input.setAttribute('aria-invalid', 'false');
  if (!q) { out.innerHTML = ''; return; }
  go.disabled = true; out.innerHTML = SKELETON;
  try {
    const who = await identify(q);
    if (my !== seq) return;
    const [a, p] = await Promise.all([air.status(who.address), readPoints(who.address)]);
    if (my !== seq) return;
    out.innerHTML = whoLine(who) + airdropCard(a) + pointsCard(p);
    try { history.replaceState(null, '', `?q=${encodeURIComponent(q)}`); } catch { /* the address bar is a convenience */ }
  } catch (e) {
    if (my !== seq) return;
    input.setAttribute('aria-invalid', 'true');
    out.innerHTML = `<p class="err" role="alert">${esc(e.message || 'Something went wrong. Try again.')}</p>`;
  } finally { if (my === seq) go.disabled = false; }
}

$('#f').addEventListener('submit', (e) => { e.preventDefault(); run($('#q').value); });
const asked = new URLSearchParams(location.search).get('q');
if (asked) { $('#q').value = asked; run(asked); } else if (matchMedia('(pointer: fine)').matches) $('#q').focus({ preventScroll: true });
