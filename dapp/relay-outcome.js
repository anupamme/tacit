// What the relay said about a request, the same on every page: whether it turned the request down or is holding it (nothing was spent, or it will
// go through on its own), whether a wait ran out (the request may still land: it is not sent again), and the words for each. The front page's
// definitions, so a page that sends through the relay answers a refusal as the front page does.
//   if (relayRefused(e)) say(relayWords(e).text)
export const relayCode = (e) => (typeof e?.code === 'string' ? e.code : '');
// the relay has made all the proofs it can for today
export const proveCapped = (e) => relayCode(e) === 'prove_budget' || /\bprove_budget\b|prove capacity for today|as many proofs as it can/i.test(String(e?.message || e || ''));
// the relay proved the request and holds it for a sender (settle held): it can be sent from any account
export const proved = (e) => relayCode(e) === 'open' && !!e?.open?.proof && Array.isArray(e.open.memos);
// turned down or held, not failed: nothing was spent, or it goes through when the relay can
export const relayRefused = (e) => !proveCapped(e) && relayCode(e) !== 'relay_paused' && relayCode(e) !== 'prove_reserved'
  && (proved(e) || ['relay_held', 'free_budget'].includes(relayCode(e))
    || /fee below the current floor|FEE_MOVED|can.t take this one|free relayed settles|relay (5\d\d|429)\b|temporarily unavailable/i.test(`${relayCode(e)} ${e?.message || e || ''}`));
// the wait for the relay ran out: the request may still go through, so it is not sent again (the same test is bridge-tick.js's)
export const waitRanOut = (e) => /settle timed out|status polling for job/i.test(e?.message || '');
// the relay reported the job failed or lost it
export const jobSaid = (e) => /^(settle|prove) failed:|relay lost the job/i.test(e?.message || '');

// The words for what the relay said, or null when it said none of these: { text, front }, `front` when the front page can do more (it can send
// a held request from the Tacit account).
export function relayWords(e) {
  const m = String(e?.message || e || ''), code = relayCode(e);
  if (proveCapped(e)) return { text: 'The relay has made as many proofs as it can for today. Try again after midnight UTC; nothing was spent.', front: false };
  if (code === 'open' || /^settle held: proved/i.test(m)) {
    return { text: proved(e) ? 'It is proved and waiting to be sent: it goes through when a relay sends it (follow it in Activity on the front page), or send it yourself from the front page.'
      : 'It is proved and waiting for a relay to send it. It goes through when one does; follow it in Activity on the front page.', front: true };
  }
  if (code === 'relay_paused') return { text: e?.queued ? 'The relay isn’t proving right now. It keeps its place in line and goes through once it is.' : 'The relay isn’t proving right now. Nothing was spent.', front: false };
  if (code === 'free_budget' || /free relayed settles for today are used up/i.test(m)) return { text: 'The relay’s free settles for today are used up. They open again at midnight UTC.', front: true };
  if (code === 'relay_held') return { text: e?.queued ? (e.slow ? 'It is taking longer than usual. It keeps its place in line.' : 'The relay can’t send this one right now. It keeps its place in line.') : 'The relay can’t take this one right now.', front: true };
  if (/fee below the current floor/i.test(m)) return { text: 'The network fee rose while this was being sent. Nothing was spent. Try again in a minute; the fee is worked out again each time.', front: false };
  if (waitRanOut(e)) return { text: 'Still in the relay’s queue. It goes through on its own; follow it in Activity on the front page, and do not send it again.', front: false };
  if (/prove timed out/i.test(m)) return { text: 'The relay is taking longer than usual to prove this, and this page stopped waiting for it. Try again in a few minutes.', front: false };
  if (/relay lost the job/i.test(m)) return { text: 'The relay lost track of this request. Check Activity on the front page before sending it again.', front: false };
  if (relayRefused(e)) return { text: 'The relay can’t take this one right now.', front: true };
  return null;
}
