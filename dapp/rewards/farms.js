// The holder's own positions in the private farms (/rewards/): what each holds and has earned, and from here a harvest (paid as a wTAC note)
// and an unbond, both relayed. Turning wTAC into TAC, exiting and joining are still the front page's, and each position links there.
// Nothing here is loaded until the holder asks: this module, the key and the pool all come in on that press.
import { makeKeySession, signInSheet } from '/trade/key.js?cb=149c5b79';
import { getUx, forgetUx } from '/trade/poolux.js?cb=e792b253';
import { makeRunner } from '/activity.js?cb=532a162f';
import { canHarvest, canUnbond, unharvested, locked, harvest, unbond } from '/farm-ops.js?cb=b3befd27';
import { esc } from '/trade/util.js?cb=509d6618';

const API = 'https://api.tacit.finance';
const day = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const refused = (e) => e?.code === 'relay_held' || e?.code === 'relay_paused' || e?.httpStatus === 429 || /relay (4\d\d|held|paused)|can’t take this one/i.test(String(e?.message || ''));

export function mountFarms(root, { pick, names = () => new Map() } = {}) {
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
      const ux = await getUx(), list = await ux.farmPositions({ walletPriv: priv });
      if (my !== seq || key.key?.pubHex !== pub) return;
      D = { pub, list: Array.isArray(list) ? list : [], said: was?.said || null };
    } catch (e) { if (my === seq) D = { pub, err: String(e?.message || e).slice(0, 160) }; }
    paint();
  }

  function say(text, kind = '') { if (D) { D.said = { text, kind }; paint(); } }
  async function act(name, fn) {
    if (D.busy) return;
    D.busy = name; say('');
    try { say(await fn(), 'ok'); D.busy = null; read(); }
    catch (e) { D.busy = null; say(refused(e) ? 'The relay can’t take this one right now.' : /locked until/.test(String(e?.message || '')) ? 'The bond is not over yet.' : String(e?.message || e), refused(e) ? 'front' : 'err'); }
  }
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
            <a href="/#farm/private-${esc(String(pos.pid))}">Exit or turn into TAC</a>
          </div>`;
      }).join('');
      const s = D.said, said = s?.text ? `<p class="more${s.kind === 'ok' ? ' ok' : s.kind ? ' err' : ''}" role="status" id="pf-said">${esc(s.text)}${s.kind === 'front' ? ' <a href="/#farm">Do it on the front page →</a>' : ''}</p>` : '<p class="more" role="status" id="pf-said"></p>';
      h = `${rows || '<p class="more">No private farm positions yet.</p>'}${said}<div class="acts"><button type="button" data-pf="again"${D.busy ? ' disabled' : ''}>Read again</button><button type="button" data-pf="lock"${D.busy ? ' disabled' : ''}>Lock your key</button></div>`;
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
    signInSheet(key, { pick, why: 'Open your Tacit wallet to see your private farm positions. Nothing is stored or sent.' }).then(() => read(), () => {});
  });
  key.onChange(() => { if (key.unlocked && D?.pub !== key.key.pubHex) read(); else paint(); });
  paint();
  return { read, forget };
}
