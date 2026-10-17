#!/usr/bin/env node
// dapp/trade/fmt.js gives exactly what the toLocaleString calls it replaces gave, over a spread of values (the cached formatters are the point: a
// render of the order book formats thousands of numbers), and dapp/btc-book.js's own formatters were made once without changing a character.
import assert from 'node:assert';
import { grp, sig, group, satsFmt, day, zone } from '../dapp/trade/fmt.js';
import { fmtUnit, fmtSats, fmtAmount } from '../dapp/btc-book.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const values = [0, 0.000012345, 0.0004, 0.05, 0.9999, 1, 1.005, 2.5, 9.995, 10, 99.999, 100, 123.456, 999.5, 1000, 1234.5678, 15012.4, 99999.99, 1e6, 4.2e6, 2.1e7, 123456789.123, -3.14159, -1500.5];
const refGrp = (x, max) => Number(x).toLocaleString('en-US', { maximumFractionDigits: max });
for (const v of values) for (const max of [0, 1, 2, 4, 6]) assert.equal(grp(v, max), refGrp(v, max), `grp(${v}, ${max})`);
ok('grp matches toLocaleString at 0 to 6 decimals');
const refSig = (x, k) => (x >= 1 ? refGrp(x, x >= 100 ? 0 : 2) : x.toLocaleString('en-US', { maximumSignificantDigits: k, maximumFractionDigits: 20 }));
for (const v of values.filter((x) => x > 0)) for (const k of [2, 3, 4]) assert.equal(sig(v, k), refSig(v, k), `sig(${v}, ${k})`);
ok('sig matches (three significant digits below 1, grouped above)');
const refSats = (x) => (x >= 100 ? Math.round(x).toLocaleString('en-US') : Number(x).toLocaleString('en-US', { maximumFractionDigits: 1 }));
for (const v of [...values, 99.95, 100.4, 100.5, 5339999, 176, 295.55]) assert.equal(satsFmt(v), refSats(v), `satsFmt(${v})`);
ok('satsFmt matches (whole above 100, one decimal below)');
for (const v of [0n, 5n, 1234n, 10n ** 12n + 7n, 123456789012345678901234567890n]) assert.equal(group(v), v.toLocaleString('en-US'));
ok('group matches for numbers and bigints');
for (const t of [0, 1700000000, 1766188800, 1798761599]) assert.equal(day(t), new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
ok('day matches toLocaleDateString');
const refZone = (d) => new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value || '';
for (const t of [1700000000, 1720000000, 1750000000]) assert.equal(zone(new Date(t * 1000)), refZone(new Date(t * 1000)));
ok('zone names the reader\'s time zone as before');

// the Bitcoin book's formatters, against the expressions they replaced
const refUnit = (u) => (u == null || !Number.isFinite(u) ? '—' : u >= 1000 ? u.toLocaleString('en-US', { maximumFractionDigits: 0 }) : u >= 10 ? u.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : u >= 1 ? u.toLocaleString('en-US', { maximumFractionDigits: 3 }) : u > 0 ? Number(u.toPrecision(3)).toString() : '0');
for (const u of [...values, null, NaN, Infinity]) assert.equal(fmtUnit(u), refUnit(u), `fmtUnit(${u})`);
for (const v of [0, 1.5, 150.4, 2099993.7, null, NaN]) assert.equal(fmtSats(v), v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US'));
assert.equal(fmtAmount(1234567890123n, 8), '12,345.67890123'); assert.equal(fmtAmount(-5n, 0), '-5'); assert.equal(fmtAmount(10n ** 20n, 8, 2), '1,000,000,000,000');
ok('btc-book\'s fmtUnit, fmtSats and fmtAmount give what they gave');

// speed: the reason for the change
const N = 20000, t0 = performance.now();
for (let i = 0; i < N; i++) grp(i * 1.37, 2), satsFmt(i * 3.1);
const fast = performance.now() - t0, t1 = performance.now();
for (let i = 0; i < N; i++) refGrp(i * 1.37, 2), refSats(i * 3.1);
const slow = performance.now() - t1;
assert.ok(fast * 3 < slow, `cached ${fast.toFixed(1)} ms against ${slow.toFixed(1)} ms for ${N * 2} numbers`);
ok(`${N * 2} numbers format ${(slow / fast).toFixed(0)}x faster (${fast.toFixed(0)} ms against ${slow.toFixed(0)} ms)`);
console.log(`\n${n} trade-fmt checks passed`);
