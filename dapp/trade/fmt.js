// Numbers and dates for the trade pages. `toLocaleString(locale, options)` builds a new Intl formatter on every call, which costs tens of microseconds:
// a page that draws an order book formats thousands of numbers in a render (and a phone is several times slower than a laptop), so each formatter
// is made once and kept. Every function here gives what the toLocaleString call it replaces gave.
// They are made when first used, not when the module loads: the first one loads the locale data (tens of milliseconds), which should not stand in front
// of a page's first request. `warm()` makes the usual ones while the page waits on the network.
const NF = {}, fixed = [], sigs = [];
let dayF = null, zoneF = null;
const intF = () => (NF.int ||= new Intl.NumberFormat('en-US')), oneF = () => (NF.one ||= new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }));
export function warm() { intF(); oneF(); grp(0, 2); grp(0, 0); grp(0, 4); sig(0.5); day(0); }
// An integer or bigint with thousands separators.
export const group = (n) => intF().format(n);
// A number to at most `max` decimal places.
export const grp = (n, max = 2) => (fixed[max] ||= new Intl.NumberFormat('en-US', { maximumFractionDigits: max })).format(Number(n));
// Three significant digits below 1, the number's own scale above it.
export const sig = (x, n = 3) => (x >= 1 ? grp(x, x >= 100 ? 0 : 2) : (sigs[n] ||= new Intl.NumberFormat('en-US', { maximumSignificantDigits: n, maximumFractionDigits: 20 })).format(x));
// A price in sats: whole above a hundred, one decimal below.
export const satsFmt = (n) => (n >= 100 ? intF().format(Math.round(n)) : oneF().format(Number(n)));
// A day as "Dec 20, 2026".
export const day = (t) => (dayF ||= new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })).format(new Date(t * 1000));
// The short name of the reader's time zone at a date ("GMT+7", "EST").
export const zone = (d) => { try { return (zoneF ||= new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
