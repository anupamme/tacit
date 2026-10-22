// The bridge page moving the holder's bridges on, with the key opened here: the same pass the front page makes every minute (bridge-tick.js),
// and the two presses that need only the relay (the burn of a moved bridge, the mint of a recorded one). Nothing is loaded until the holder asks:
// this module, the key sheet and tacit.js (four megabytes) all come in on that press. Starting a bridge, moving one back, recovering one, paying
// the mint from a wallet and proving it oneself stay on the front page, which these rows link to.
import { makeKeySession, signInSheet } from '/trade/key.js?cb=149c5b79';
import { makeTacitSession } from '/tacit-session.js?cb=a2d34bb2';
import { stepIn, stepOut, outPubs } from '/bridge-tick.js?cb=84475d9e';
import { secp, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';

const TACIT_URL = '/tacit.js?cb=c69646c8';
const PLAN_KEY = 'tacit-lite-bridge-plan-v1', SELF_PROVE = 'tacit-lite-prove-self-v1:';
const EVERY = 75e3;                                                                  // as often as the front page's pass
const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const refused = (e) => e?.code === 'relay_held' || e?.code === 'relay_paused' || e?.httpStatus === 429 || /relay (4\d\d|held|paused)|can’t take this one|free (relayed )?settles/i.test(String(e?.message || ''));
const BURN_SENT = ['burn-submitted', 'burn-mined', 'registered', 'folded', 'minted'];

// `repaint()` reads the journals again; `say(text, front)` writes the status line (`front`: the text ends with the way to the front page).
export function mountMover({ pick, repaint = () => {}, say = () => {}, onState = () => {} } = {}) {
  const key = makeKeySession({ moved: (why) => { stop(); key.lock(); say(why); } });
  const TS = makeTacitSession({ url: TACIT_URL, key: () => (key.unlocked ? { pubHex: key.key.pubHex, priv: bytesToHex(key.priv()) } : null), secp, bytesToHex, hexToBytes });
  let timer = null, busy = false, last = 0;

  const journaledIn = (pub) => { try { return /"stage":"(?!minted"|reclaimed")/.test(localStorage.getItem(`tacit-burndep-bridge-v1:mainnet:${pub}`) || ''); } catch { return false; } };
  const planOf = (pub) => (rec) => read(PLAN_KEY)?.[pub]?.[rec.id] || null;

  // One pass: the way in for the open key, the way out for every key with a journal here (only the Bitcoin step needs the open key).
  async function tick(force = false) {
    if (busy || !key.unlocked || (!force && Date.now() - last < EVERY - 1000)) return;
    busy = true; last = Date.now();
    const pub = key.key.pubHex;
    try {
      const T = await TS.load();
      if (journaledIn(pub)) await stepIn({ ux: T.bridgeUx(), pub, withKey: TS.withKey, priv: () => key.priv(), planOf: planOf(pub), alive: () => key.key?.pubHex === pub });
      const pubs = outPubs();
      if (pubs.length) {
        const out = T.crossoutUx();
        await stepOut({ ux: out, pubs, records: (p) => out.list(p).filter((r) => r.stage !== 'minted'), keyPub: () => key.key?.pubHex, withKey: TS.withKey, priv: () => key.priv() });
      }
    } catch { /* a pass that fails is tried again on the next */ } finally { busy = false; }
    repaint();
  }
  function start() {
    stop();
    timer = setInterval(() => { if (!document.hidden) tick(); }, 15e3);
    document.addEventListener('visibilitychange', onVisible);
    onState(true);
    tick(true);
  }
  const onVisible = () => { if (!document.hidden) tick(); };
  function stop() { clearInterval(timer); timer = null; document.removeEventListener('visibilitychange', onVisible); TS.drop(); onState(false); }

  // The key opened here, then the pass running while the page is open. A second press locks the key again.
  async function toggle() {
    if (key.unlocked) { stop(); key.lock(); say(''); return false; }
    try { await signInSheet(key, { pick, why: 'Open your Tacit wallet to move your bridges on from this page. This page never stores the key.' }); }
    catch (e) { if (e?.unlockCancelled) return false; say(String(e?.message || e)); return false; }
    start();
    return true;
  }

  // The two presses: the burn of a bridge that is moved and traced (it waits for the holder), and the mint of a recorded one. Anything the relay
  // will not take, and the holder who proves their own mints, is sent to the front page.
  async function press(kind, row) {
    if (!key.unlocked) return say('Open your Tacit wallet first.');
    const pub = key.key.pubHex;
    if (row.pub && row.pub !== pub) return say('That bridge belongs to another Tacit key. Open that one to move it on.');
    if (busy) return say('Checking your bridges: press again in a moment.');
    busy = true;
    try {
      const T = await TS.load(), ux = T.bridgeUx(), rec = ux.list(pub).find((r) => r.id === row.id);
      if (!rec) return say('That bridge is not in this browser’s record any more. Reload the page.');
      if (kind === 'mint' && read(SELF_PROVE + pub) === true) return say('You prove your own mints, which the front page does.', true);
      if (kind === 'burn') {
        say('Signing the burn and sending it to a miner…');
        let after = await TS.withKey(() => ux.advance(pub, row.id, { walletPriv: key.priv(), go: true }), pub);
        if (after.stage === 'burn-signed') after = await ux.advance(pub, row.id).catch(() => ux.list(pub).find((r) => r.id === row.id) || after);
        say(BURN_SENT.includes(after.stage) ? '✓ Burn sent.'
          : after.stage === 'traced' && after.checkWait ? 'Its history is being checked before the burn. This page sends the burn once the check is done, while it is open with your key.'
          : after.stage === 'traced' ? 'Not yet: it waits for Bitcoin’s proof to reach the move. Try again later.'
          : after.stage === 'burn-signed' ? 'Signed, but the miner did not take it yet. It is tried again on its own.' : 'Checked.');
      } else {
        say('Minting: the relay proves it, about a minute…');
        const after = await TS.withKey(() => ux.advance(pub, row.id, { walletPriv: key.priv() }), pub);
        say(after.stage === 'minted' ? '✓ Minted: it is in your private balance.'
          : after.mintJob && !after.lastError ? 'Its mint is with the relay and lands on its own, usually within minutes. It is not sent twice.' : 'Checked.');
      }
    } catch (e) {
      say(refused(e) ? 'The relay can’t take this one right now.' : String(e?.message || e).slice(0, 200), refused(e));
    } finally { busy = false; repaint(); }
  }

  return { toggle, press, tick, get open() { return key.unlocked; }, get pub() { return key.key?.pubHex || null; } };
}
