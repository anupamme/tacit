// lib/scan-lag.js: the monitor's verdict on the API's Bitcoin block scan.
// Run: node worker-relay/tests/scan-lag.test.mjs
import assert from 'node:assert/strict';
import { scanLagVerdict } from '../src/lib/scan-lag.js';

assert.equal(scanLagVerdict(971711, 971711).level, 'ok');
assert.equal(scanLagVerdict(971706, 971711).level, 'ok');
assert.equal(scanLagVerdict(971705, 971711).level, 'warning');
assert.equal(scanLagVerdict(971675, 971711).level, 'critical');
assert.equal(scanLagVerdict(971712, 971711).lag, 0, 'a scan ahead of a lagging tip source is not negative');
assert.equal(scanLagVerdict(null, 971711).level, 'unknown');
assert.equal(scanLagVerdict(971700, 971711, { warn: 20, critical: 50 }).level, 'ok');
console.log('ok - scan lag: ok under the warning line, warning under the critical one, critical past it, unknown when unread');
