// The holder's own positions in the private farms (/rewards/): what each holds and has earned, and from here a harvest (paid as a wTAC note),
// an unbond, an exit (harvest, unbond and the liquidity taken out), and the rewards turned into TAC (the relay unwraps each note to the
// connected wallet, which turns the wTAC into TAC). Joining, and what only an unwrap sent yourself can do, are the front page's: they link there.
// Nothing here is loaded until the holder asks: this module, the key and the pool all come in on that press.
import { makeKeySession, signInSheet } from '/trade/key.js?cb=149c5b79';
import { getUx, forgetUx } from '/trade/poolux.js?cb=e792b253';
import { makeRunner } from '/activity.js?cb=532a162f';
import { canHarvest, canUnbond, unharvested, locked, harvest, unbond, rewardNotes, relayable, redeem, wtacWithdrawCall, wtacBalanceCall, worthHarvesting, lpNotes, takeOut, HARVEST_WORTH } from '/farm-ops.js?cb=3d2c0c30';
import { esc, wordAt } from '/trade/util.js?cb=509d6618';

const API = 'https://api.tacit.finance';
const day = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const tacTxt = (wei) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 4 });
const noteTxt = (units) => (Number(units) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 4 });
const noteKey = (n) => String(n.leaf || n.nullifier || `${n.cx}:${n.cy}`).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refused = (e) => e?.code === 'relay_held' || e?.code === 'relay_paused' || e?.httpStatus === 429 || /relay (4\d\d|held|paused)|can’t take this one/i.test(String(e?.message || ''));

export function mountFarms(root, { pick, names = () => new Map(), program = () => null, wallet = null, W = null, connect = null } = {}) {
  let D = null, seq = 0, runner = null;
  const key = makeKeySession({ moved: () => forget() });
  const run = () => (runner ||= makeRunner({ api: API, base: async () => (await import('/confidential-deployments.js')).getConfidentialDeployment('mainnet')?.relayBase || API, pub: () => key.key?.pubHex || null }));
  const settled = (r) => { if (r?.jobId) run().journal.put('job:' + r.jobId, { status: 'settled', hash: r.txHash || undefined }); };
  function forget() { key.lock(); forgetUx(); seq++; D = null; paint(); }

  async function read() {
    if (!key.unlocked) return paint();
    const pub = key.key.pubHex, my = ++seq, priv = key.priv(), was = D?.pub === pub ? D : null;
    D = { pub, loading: !was, ...(was ? { ...was } : {}) }; paint();
    try {
      const ux = await getUx(), [list, bal, wt] = await Promise.all([ux.farmPositions({ walletPriv: priv }), ux.balance(priv).catch(() => null), walletWtac(ux)]);
      if (my !== seq || key.key?.pubHex !== pub) return;
      D = { pub, list: Array.isArray(list) ? list : [], notes: bal?.notes || [], wtac: wt, said: was?.said || null };
    } catch (e) { if (my === seq) D = { pub, err: String(e?.message || e).slice(0, 160) }; }
    paint();
  }

  function say(text, kind = '') { if (D) { D.said = { text, kind }; paint(); } }
  async function act(name, fn) {
    if (D.busy) return;
    D.busy = name; say('');
    try { say(await fn(), 'ok'); D.busy = null; read(); }
    catch (e) { D.busy = null; say(refused(e) ? 'The relay can’t take this one right now.' : /locked until/.test(String(e?.message || '')) ? 'The bond is not over yet.' : String(e?.message || e), refused(e) || e?.front ? 'front' : 'err'); }
  }
  const walletWtac = async (ux) => (W?.account ? wordAt(await ux.ethCall(wtacBalanceCall(W.account).to, wtacBalanceCall(W.account).data).catch(() => '0x'), 0) : 0n);
  const name = (pos) => names().get(Number(pos.pid)) || `Farm ${pos.pid}`;

  async function doHarvest(i) {
    const pos = D.list[i];
    if (!pos || !canHarvest(pos)) throw new Error('Nothing to harvest yet.');
    const t = await getUx(), label = 'Harvest farm rewards';
    say('The relay is proving your harvest…');
    settled(await harvest(t, key.priv(), pos, run().wait(label, 15 * 60e3)));
    return 'Harvested to a wTAC note, one for one with TAC.';
  }
  async function doUnbond(i) {
    const pos = D.list[i];
    if (!pos) throw new Error('That position is not listed any more. Read again.');
    if (locked(pos)) throw new Error(`The bond is over on ${day(Number(pos.unlockAt))}.`);
    if (unharvested(pos)) throw new Error('Harvest first: unbonding now would give up what it has earned.');
    const t = await getUx(), label = 'Unbond from a farm';
    say('The relay is proving your unbond…');
    settled(await unbond(t, key.priv(), pos, run().wait(label, 15 * 60e3)));
    return 'Unbonded. Your liquidity is a private note again.';
  }

  // The rewards, turned into TAC: each note the relay can unwrap for something goes to the connected wallet as wTAC, and the wallet turns all
  // its wTAC into TAC. A note worth less than the relay's fee is left, for the front page, which can send the unwrap from the Tacit account.
  async function toTac() {
    const prog = program(), rid = prog?.rewardAsset, notes = rewardNotes(D.notes, rid);
    if (!wallet || !W) throw Object.assign(new Error('Turning rewards into TAC needs a wallet.'), { front: true });
    if (!W.account) await connect();
    const to = W.account;
    if (!to) throw new Error('Connect a wallet to receive the TAC.');
    const t = await getUx(), priv = key.priv(), mine = notes.filter((n) => relayable(t, n, rid)), small = notes.length - mine.length;
    if (!mine.length && !(D.wtac > 0n)) throw Object.assign(new Error(notes.length ? 'Your rewards are each worth less than the relay charges to unwrap them.' : 'Nothing to turn into TAC yet.'), { front: notes.length > 0 });
    for (const [i, n] of mine.entries()) {
      say(`The relay is unwrapping your rewards${mine.length > 1 ? ` (${i + 1} of ${mine.length})` : ''}…`);
      settled(await redeem(t, priv, n, to, run().wait(`Unwrap ${noteTxt(n.value)} wTAC of farm rewards`, 15 * 60e3)));
    }
    const balOf = async () => wordAt(await t.ethCall(wtacBalanceCall(to).to, wtacBalanceCall(to).data), 0);
    let bal = await balOf();
    for (let i = 0; !bal && mine.length && i < 10; i++) { await sleep(3000); bal = await balOf(); }
    if (!bal) throw new Error('The unwrap landed, but the wTAC is not visible yet. Press again in a minute: it picks up from here.');
    if (W.account?.toLowerCase() !== to.toLowerCase()) throw new Error('Your wallet account changed while this ran. Switch back to the account that holds the wTAC and press again.');
    say('Confirm turning the wTAC into TAC in your wallet…');
    const hash = await wallet.sendTx({ ...wtacWithdrawCall(bal, to), from: to }), J = run().journal, id = `tx:1:${String(hash).toLowerCase()}`;
    J.put(id, { kind: 'tx', label: `Turn ${tacTxt(bal)} wTAC into TAC`, chain: 1, hash, status: 'pending' });
    const rc = await wallet.receipt(hash);
    J.put(id, rc?.status === '0x1' ? { status: 'confirmed' } : { status: 'failed', err: 'The transaction reverted.' });
    if (rc?.status !== '0x1') throw new Error('Turning the wTAC into TAC did not go through.');
    return `Turned ${tacTxt(bal)} wTAC into TAC, in your wallet.${small ? ` ${small} smaller reward${small === 1 ? ' is' : 's are'} worth less than the relay’s fee to unwrap: the front page can send ${small === 1 ? 'it' : 'them'} from your Tacit account.` : ''}`;
  }

  // Out of a farm: the reward harvested if it is worth it through the relay, the position unbonded, and the liquidity it gives back taken out
  // as the pool's two assets. A reward worth having that only an unwrap sent yourself would turn is not given up: that exit is the front page's.
  async function exit(i) {
    const pos = D.list[i], prog = program(), pool = (prog?.pools || []).find((p) => Number(p.pid) === Number(pos?.pid));
    if (!pos) throw new Error('That position is not listed any more. Read again.');
    if (!pool?.reserves) throw new Error('The farm’s pool could not be read. Try again in a moment.');
    if (locked(pos)) throw new Error(`The bond is over on ${day(Number(pos.unlockAt))}.`);
    const t = await getUx(), priv = key.priv(), rid = prog.rewardAsset, pending = BigInt(pos.pendingUnits || 0);
    const worth = worthHarvesting(t, pending, rid);
    if (pending > HARVEST_WORTH && !worth) throw Object.assign(new Error('Its reward is worth turning into TAC only by sending the unwrap yourself.'), { front: true });
    const n = worth ? 3 : 2;
    let k = 0;
    if (worth) { say(`Step ${++k} of ${n} · the relay is proving your harvest…`); settled(await harvest(t, priv, pos, run().wait('Harvest farm rewards', 15 * 60e3))); }
    const lpOf = async () => lpNotes((await t.balance(priv)).notes, pool);
    const had = new Set((await lpOf()).map(noteKey));
    say(`Step ${++k} of ${n} · the relay is proving your unbond…`);
    const [now] = (await t.farmPositions({ walletPriv: priv })).filter((p) => p.receiptLeaf === pos.receiptLeaf);
    settled(await unbond(t, priv, now || pos, run().wait('Unbond from a farm', 15 * 60e3)));
    let fresh = [];
    for (let j = 0; !fresh.length && j < 8; j++) { fresh = (await lpOf()).filter((x) => !had.has(noteKey(x))); if (!fresh.length) await sleep(5000); }
    if (!fresh.length) throw new Error('Unbonded. The liquidity note is not showing yet: Read again in a minute and take it out from the front page.');
    for (const [j, note] of fresh.entries()) {
      say(`Step ${n} of ${n} · the relay is taking your liquidity out${fresh.length > 1 ? ` (${j + 1} of ${fresh.length})` : ''}…`);
      try { settled(await takeOut(t, priv, pool, note, run().wait(`Take out ${name(pos)} liquidity`, 15 * 60e3))); }
      catch (e) { if (/not covered by this withdrawal/.test(String(e?.message || ''))) throw Object.assign(new Error('Unbonded. This liquidity is worth less than the relay’s fee to take it out.'), { front: true }); throw e; }
    }
    return `Out. Your liquidity is back as private ${name(pos)} notes.`;
  }

  function paint() {
    let h;
    if (!key.unlocked) h = '<p class="more">Your positions in the private farms.</p><button class="act" type="button" data-pf="open">Show mine</button>';
    else if (!D || D.loading) h = '<p class="more">Reading your positions…</p>';
    else if (D.err) h = `<p class="more err">${esc(D.err)} <button class="linkbtn" type="button" data-pf="again">Try again</button></p>`;
    else {
      const rows = D.list.map((pos, i) => {
        const b = D.busy, tac = Number(pos.pendingTac || 0), lk = locked(pos);
        return `<dl class="kv"><div><dt>${esc(name(pos))}</dt><dd class="num">${esc(tac.toLocaleString('en-US', { maximumFractionDigits: 4 }))} TAC earned</dd></div>${lk ? `<div><dt>Bonded until</dt><dd>${esc(day(Number(pos.unlockAt)))}</dd></div>` : ''}</dl>
          <div class="acts">
            <button type="button" data-pf="harvest" data-i="${i}"${b || !canHarvest(pos) ? ' disabled' : ''}>${b === `harvest:${i}` ? 'Harvesting…' : 'Harvest'}</button>
            <button type="button" data-pf="unbond" data-i="${i}"${b || !canUnbond(pos) ? ' disabled' : ''}>${b === `unbond:${i}` ? 'Unbonding…' : 'Unbond'}</button>
            <button type="button" data-pf="exit" data-i="${i}"${b || lk ? ' disabled' : ''}>${b === `exit:${i}` ? 'Exiting…' : 'Exit'}</button>
          </div>`;
      }).join('');
      const s = D.said, said = s?.text ? `<p class="more${s.kind === 'ok' ? ' ok' : s.kind ? ' err' : ''}" role="status" id="pf-said">${esc(s.text)}${s.kind === 'front' ? ' <a href="/#farm">Do it on the front page →</a>' : ''}</p>` : '<p class="more" role="status" id="pf-said"></p>';
      const rn = rewardNotes(D.notes, program()?.rewardAsset), rsum = rn.reduce((a, x) => a + BigInt(x.value), 0n);
      const rewards = rn.length || D.wtac > 0n ? `<dl class="kv"><div><dt>Rewards to turn into TAC</dt><dd class="num">${rn.length ? `${esc(noteTxt(rsum))} wTAC private` : ''}${rn.length && D.wtac > 0n ? ' · ' : ''}${D.wtac > 0n ? `${esc(tacTxt(D.wtac))} wTAC in your wallet` : ''}</dd></div></dl>
        <div class="acts"><button type="button" data-pf="totac"${D.busy ? ' disabled' : ''}>${D.busy === 'totac' ? 'Turning…' : 'Turn into TAC'}</button></div>` : '';
      h = `${rows || '<p class="more">No private farm positions yet.</p>'}${rewards}${said}<div class="acts"><button type="button" data-pf="again"${D.busy ? ' disabled' : ''}>Read again</button><button type="button" data-pf="lock"${D.busy ? ' disabled' : ''}>Lock your key</button></div>`;
    }
    if (root.__h !== h) { root.__h = h; root.innerHTML = h; }
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pf]');
    if (!b || b.disabled) return;
    const what = b.dataset.pf, i = Number(b.dataset.i);
    if (what === 'lock') return forget();
    if (what === 'again') return read();
    if (what === 'harvest') return act(`harvest:${i}`, () => doHarvest(i));
    if (what === 'unbond') return act(`unbond:${i}`, () => doUnbond(i));
    if (what === 'exit') return act(`exit:${i}`, () => exit(i));
    if (what === 'totac') return act('totac', toTac);
    signInSheet(key, { pick, why: 'Open your Tacit wallet to see your private farm positions. Nothing is stored or sent.' }).then(() => read(), () => {});
  });
  key.onChange(() => { if (key.unlocked && D?.pub !== key.key.pubHex) read(); else paint(); });
  paint();
  return { read, forget };
}
