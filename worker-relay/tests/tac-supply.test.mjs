// lib/tac-supply.js: the TAC-on-Ethereum verdict the monitor pages on, and the pool's local EVM asset id.
// Run: node worker-relay/tests/tac-supply.test.mjs
import assert from 'node:assert/strict';
import { tacSupplyVerdict, evmAssetId, TAC_ETCH_SUPPLY } from '../src/lib/tac-supply.js';

const E18 = 10n ** 18n;
let n = 0;
const ok = (label) => { console.log(`  ok - ${label}`); n++; };

// The mainnet TAC token's local id, as ConfidentialPool._evmAssetId(token) computes it on chain 1.
assert.equal(evmAssetId(1, '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279'), '0x5e3e1bd6fb29a21d0bb0a3a5e6095493ed0ff5f7f5405ae1c5261f191b4ea04b');
ok('evmAssetId matches the pool\'s derivation for the mainnet TAC token');

const healthy = { supply: 2_514_394n * E18, wtac: { supply: 85_469n * E18, backing: 85_469n * E18 }, legacy: [{ token: '0xD7D7', supply: 100n * E18, expected: 100n * E18 }] };
assert.equal(tacSupplyVerdict(healthy).level, 'ok');
ok('a supply under the etch, wTAC fully backed and an unchanged legacy token is ok');

assert.equal(tacSupplyVerdict({ ...healthy, supply: TAC_ETCH_SUPPLY }).level, 'ok');
assert.equal(tacSupplyVerdict({ ...healthy, supply: TAC_ETCH_SUPPLY + 1n }).level, 'critical');
ok('one wei over 21,000,000 TAC is critical; exactly the etch is not');

assert.equal(tacSupplyVerdict({ ...healthy, wtac: { supply: 10n * E18, backing: 10n * E18 - 1n } }).level, 'critical');
assert.equal(tacSupplyVerdict({ ...healthy, wtac: { supply: 10n * E18, backing: 11n * E18 } }).level, 'ok');
ok('wTAC under one TAC per wTAC is critical; over-backed is fine');

const shadow = tacSupplyVerdict({ ...healthy, shadowRegistered: [{ token: '0xA131', assetId: '0x5e3e' }] });
assert.equal(shadow.level, 'warning');
const legacyMoved = tacSupplyVerdict({ ...healthy, legacy: [{ token: '0xD7D7', supply: 101n * E18, expected: 100n * E18 }] });
assert.equal(legacyMoved.level, 'warning');
ok('a second registration over a canonical token, or a legacy TAC token changing supply, warns');

const both = tacSupplyVerdict({ ...healthy, supply: TAC_ETCH_SUPPLY + 1n, shadowRegistered: [{ token: '0xA131', assetId: '0x5e3e' }] });
assert.equal(both.level, 'critical');
assert.equal(both.why.length, 2);
ok('a warning never lowers a critical, and every issue is listed');

console.log(`\n${n}/6 tac-supply checks passed`);
