// The width-8 Poseidon the holding claim's signature message needs (dapp/holding-claim.js), as its own small bundle so the
// Poseidon bundle every pool page loads does not grow. Run: node build/build-poseidon8.mjs
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'dapp', 'vendor', 'tacit-poseidon8.min.js');
const tmp = mkdtempSync(join(tmpdir(), 'poseidon8-'));
const entry = join(tmp, 'entry.mjs');
writeFileSync(entry, "// Poseidon over BN254 (circomlib parameters), eight inputs: the holding claim's signature message.\nexport { poseidon8 } from 'poseidon-lite/poseidon8';\n");
try {
  await build({ entryPoints: [entry], bundle: true, format: 'esm', target: 'es2020', minify: true, legalComments: 'inline', outfile: OUT, logLevel: 'warning', platform: 'neutral', nodePaths: [join(HERE, 'node_modules'), join(HERE, '..', 'node_modules')] });
} finally { rmSync(tmp, { recursive: true, force: true }); }
const out = readFileSync(OUT);
console.log(`${OUT}\n  ${out.length} bytes  sha256 ${createHash('sha256').update(out).digest('hex')}`);
