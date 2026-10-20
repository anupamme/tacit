// What the Bridge tab's two list-wide presses do with the notes it lists.
//   Merge: the tracked notes, packed into as few notes as the bridge takes (each up to the cap), each pack sent to this key's own
//          address in one transaction.
//   All:   a burn now for every tracked note that can burn as it is; one send first for the tracked notes in an older form (packed the
//          same way, so one send covers many), then their burns; a note received privately sent on its own; a note the proof does not
//          track through its own check, one at a time.
// A pack never holds an untracked note. The reflection's fold counts only the inputs it tracks, so one untracked input in a pack makes
// the whole transfer fail conservation and drops the tracked ones with it. And untracked notes are never packed with each other: a
// merged note's history is the union of its inputs', so it could pass the history cap each of them is under.

// Ten inputs in one transfer is the most seen folded on mainnet (an older ten-note merge), so a pack stops there.
export const MAX_MERGE_INPUTS = 10;

const rawOf = (n) => BigInt(n?.amount ?? 0);
const idOf = (n) => `${n.txid}:${n.vout}`;
const bigger = (a, b) => (rawOf(a) > rawOf(b) ? -1 : rawOf(a) < rawOf(b) ? 1 : idOf(a) < idOf(b) ? -1 : 1);

// First-fit decreasing: each pack holds at most `capRaw` and `maxInputs` notes; the biggest pack first.
export function packNotes(notes, capRaw, maxInputs = MAX_MERGE_INPUTS) {
  const cap = BigInt(capRaw), packs = [];
  for (const n of [...notes].sort(bigger)) {
    const pack = packs.find((p) => p.notes.length < maxInputs && p.total + rawOf(n) <= cap);
    if (pack) { pack.notes.push(n); pack.total += rawOf(n); } else packs.push({ notes: [n], total: rawOf(n) });
  }
  return packs.sort((a, b) => (a.total > b.total ? -1 : a.total < b.total ? 1 : 0));
}

// Splits the list into what each press can touch. `tracking` is 'tracked' | 'untracked' | 'new' (burndep-ux noteTracking); a note whose
// tracking is not known is left alone, never treated as tracked.
function sort(notes) {
  const out = { tracked: [], untracked: [], skipped: [] };
  for (const n of notes) {
    if (!n.eligible) out.skipped.push({ note: n, why: 'unavailable' });
    else if (rawOf(n) <= 0n) out.skipped.push({ note: n, why: 'empty' });
    else if (n.tracking === 'tracked') out.tracked.push(n);
    else if (n.tracking === 'untracked') out.untracked.push(n);
    else out.skipped.push({ note: n, why: n.tracking === 'new' ? 'recent' : n.tracking === 'bound' ? 'bound' : 'unknown' });
  }
  return out;
}
const isPrivate = (n) => !!n.stealthTweakedSk || n.form === 'private';

export function planMerge(notes, { capRaw, maxInputs = MAX_MERGE_INPUTS }) {
  const s = sort(notes), mergeable = s.tracked.filter((n) => !isPrivate(n));
  const packs = packNotes(mergeable, capRaw, maxInputs);
  return {
    groups: packs.filter((p) => p.notes.length > 1),
    left: [...packs.filter((p) => p.notes.length === 1).flatMap((p) => p.notes), ...s.tracked.filter(isPrivate), ...s.untracked],
    skipped: s.skipped,
  };
}

export function planAll(notes, { capRaw, maxInputs = MAX_MERGE_INPUTS }) {
  const s = sort(notes), plain = s.tracked.filter((n) => !isPrivate(n));
  return {
    burns: plain.filter((n) => n.form !== 'old').sort(bigger),
    sends: packNotes(plain.filter((n) => n.form === 'old'), capRaw, maxInputs),
    privates: s.tracked.filter(isPrivate).sort(bigger),
    checks: s.untracked.sort(bigger),
    skipped: s.skipped,
  };
}

// How many notes a Bridge all would take on.
export const countAll = (plan) => plan.burns.length + plan.sends.reduce((n, g) => n + g.notes.length, 0) + plan.privates.length + plan.checks.length;

// Bitcoin transactions to get every tracked, non-private note bridged: by Bridge all (a burn for each ready note, a send then a burn for each pack
// of older-form notes), and by Merge notes then bridging (a transfer then a burn for each pack, and for each note left alone a burn, or a send
// then a burn if it is in the older form). Notes received privately and notes the proof does not track cost the same either way and are left out.
export function opsCompared(mergePlan, allPlan) {
  const alone = mergePlan.left.filter((n) => n.tracking === 'tracked' && !isPrivate(n));
  return {
    all: allPlan.burns.length + 2 * allPlan.sends.length,
    merge: 2 * mergePlan.groups.length + alone.reduce((s, n) => s + (n.form === 'old' ? 2 : 1), 0),
  };
}
