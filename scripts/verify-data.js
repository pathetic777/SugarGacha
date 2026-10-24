#!/usr/bin/env node
/**
 * Sanity checks for the 5 prompt pools:
 *  - each pool has 40 entries with ids 1..40
 *  - every entry has a non-empty "en" line, and only { id, en }
 *  - all 200 lines are unique (case/punctuation-insensitive)
 *  - no two lines share the same first 4 words
 *
 * Run: npm run verify
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const KEYS = ['mint', 'berry', 'volt', 'dark', 'royal'];
const NON_LATIN = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;
const sandbox = { window: { SUGAR_DATA: {} } };
vm.createContext(sandbox);
const errors = [];
for (const k of KEYS) {
  const file = path.join(__dirname, '..', 'data', `${k}.js`);
  const src = fs.readFileSync(file, 'utf8');
  if (NON_LATIN.test(src)) errors.push(`${k}.js: unexpected non-ASCII characters`);
  vm.runInContext(src, sandbox, { filename: file });
}

const data = sandbox.window.SUGAR_DATA;
const seen = new Map();
const heads = new Map();
let total = 0;

for (const k of KEYS) {
  const pool = data[k];
  if (!Array.isArray(pool)) {
    errors.push(`${k}: pool missing`);
    continue;
  }
  total += pool.length;
  const ids = pool.map((e) => e.id).join(',');
  const expected = Array.from({ length: 40 }, (_, i) => i + 1).join(',');
  if (ids !== expected) errors.push(`${k}: ids must be exactly 1..40 in order`);

  for (const e of pool) {
    const tag = `${k}#${e.id}`;
    if (typeof e.en !== 'string' || !e.en.trim()) {
      errors.push(`${tag}: empty "en"`);
      continue;
    }
    if (Object.keys(e).some((key) => !['id', 'en'].includes(key))) errors.push(`${tag}: only "id" and "en" fields are allowed`);
    const norm = e.en.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(norm)) errors.push(`${tag}: duplicate of ${seen.get(norm)}`);
    seen.set(norm, tag);
    const head = norm.split(' ').slice(0, 4).join(' ');
    if (heads.has(head)) errors.push(`${tag}: same first 4 words as ${heads.get(head)} ("${head}")`);
    heads.set(head, tag);
  }
  console.log(`  ${k.padEnd(6)} ${pool.length} lines`);
}

console.log(`  total  ${total} lines, ${seen.size} unique`);
if (errors.length || total !== 200) {
  console.error('\nFAILED:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log('\nOK: 200 lines, all unique.');
