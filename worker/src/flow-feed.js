// What the Bitcoin <-> Ethereum visualizer draws, kept to what is really known and small enough for a widget (the full stats reading is
// ~800 KB). Everything here is built from the shared stats reading and the reflection's status, which are public already, so the feed
// adds no new reading of any chain.
//
// Two rules the picture is held to:
//   * Only real events. An event is a timestamp the chain gave (an attestation, a settle, a deposit, a mint of the TAC token). Where
//     only a counter is known (bridge burns recorded, bridge mints) the feed keeps the counter's history and the picture shows the
//     counter moving, at the granularity it was read, never a made-up time for each burn.
//   * Nothing private. No address, no transaction, no amount of a private flow: counts and times. A public figure (the TAC token's
//     supply) is a figure; who made which transfer is not carried.

export const FLOW_WINDOW_SEC = 24 * 3600;
export const FLOW_SERIES_MAX = 700;            // a week of the stats reading's quarter hours
export const FLOW_SERIES_MIN_GAP_SEC = 3600;
export const FLOW_EVENTS_MAX = 400;             // newest events kept per list: a hard ceiling on the payload however busy a day is   // an unchanged point is kept this seldom, so the series still shows time passing

// A number, or null: an absent figure (null, undefined, an empty string) is null, never the zero Number() would make of it.
const finite = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const tsOf = (p) => (Array.isArray(p) ? finite(p[0]) : finite(p));
const decimal = (v) => (v && typeof v === 'object' && v.$n != null ? String(v.$n) : v == null ? null : String(v));

// The times in `xs` (bare times, or [time, value] pairs) inside the window, oldest first.
export function recentTimes(xs, since, now, max = FLOW_EVENTS_MAX) {
  return (Array.isArray(xs) ? xs : []).map(tsOf).filter((t) => t != null && t > since && t <= now + 60).sort((a, b) => a - b).slice(-max);
}

// One point of the counters' history, from the stats reading and the reflection's status. Missing parts are null, never zero.
export function flowPoint({ reading, status, now }) {
  const link = (reading && reading.link) || {};
  const st = status || (link.status) || {};
  return {
    t: Math.floor(now),
    burns: finite(st.bridgeBurns),
    minted: finite(st.bridgeMinted),
    out: finite(link.crossOuts),
    att: finite(st.attestedHeight ?? link.attestedHeight),
    relay: finite(link.tip),
    btc: finite(link.btcTip),
  };
}

// Add a point to the history: kept when something a picture draws changed, or when it has been long enough that the series should
// show time passing. Oldest points beyond the cap fall away. Returns a new array.
export function appendSeries(series, point, { max = FLOW_SERIES_MAX, minGapSec = FLOW_SERIES_MIN_GAP_SEC } = {}) {
  const list = Array.isArray(series) ? series.filter((p) => p && finite(p.t) != null) : [];
  const last = list[list.length - 1];
  const same = last && ['burns', 'minted', 'out', 'att'].every((k) => last[k] === point[k]);
  if (last && point.t <= last.t) return list;                       // never out of order
  if (same && point.t - last.t < minGapSec) return list;
  return [...list, point].slice(-max);
}

// The feed: the counters now, their history inside the window, and the real events inside the window.
export function buildFlow({ reading, status, series, now = Date.now() / 1000, windowSec = FLOW_WINDOW_SEC }) {
  const since = now - windowSec;
  const r = reading || {}, link = r.link || {}, times = link.times || {};
  const deposits = [
    ...((r.eth && r.eth.series && r.eth.series.ins) || []),
    ...(Array.isArray(r.dev) ? r.dev : []).flatMap((d) => (d && d.series && d.series.ins) || []),
  ];
  const tacTimes = (r.tac && r.tac.times) || {};
  const pt = flowPoint({ reading: r, status, now });
  return {
    asOf: Math.floor(now),
    windowSec,
    now: {
      btc: pt.btc, relay: pt.relay, attested: pt.att,
      burns: pt.burns, minted: pt.minted, crossOuts: pt.out,
      burnDeposits: finite((status || link.status || {}).burnDeposits),
      tacSupply: decimal(r.tac && r.tac.supply),
    },
    series: (Array.isArray(series) ? series : []).filter((p) => p && p.t > since - FLOW_SERIES_MIN_GAP_SEC),
    events: {
      attests: recentTimes(times.attests, since, now),
      settles: recentTimes(times.settles, since, now),
      deposits: recentTimes(deposits, since, now),
      tacOut: recentTimes(tacTimes.out, since, now),
      tacIn: recentTimes(tacTimes.in, since, now),
    },
  };
}
