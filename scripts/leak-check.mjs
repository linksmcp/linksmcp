#!/usr/bin/env node
// Fails when a word from the private list appears in the published tree, or a long dash appears in
// README.md / llms.txt. The list is stored encoded so this file does not match itself.
// Usage: node scripts/leak-check.mjs [rootDir]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORDS = JSON.parse(Buffer.from('WyJkbSBjaGFtcCIsImRtY2hhbXAiLCJzZHIgcGlsb3QiLCJzZHJwaWxvdCIsImRtd2lyZSIsImxlYWRmaW5kciIsImxpbmt1bml0eSIsImlwcm95YWwiLCJwcm94eS1zZWxsZXIiLCJub2NvZGVpZnkiLCJzb2hhaWIiLCJzdXBhYmFzZSIsImhldHpuZXIiLCJsaW5rZG1jcCIsImFudGhyb3BpYyIsIm9wZW5haSIsInF3ZW4iLCJnZW1pbmkiLCJtZW50aW9uZWRpbiIsIm9uZWdsaW1wc2UiLCJnb2xvZ2luIiwieW91ciBhaSBjb25uZWN0b3IiLCJjaGFtcGlvbnMgY2lyY2xlIiwiZG0gY2hhbXBpb25zIiwicmVudGVkIiwicmVudGFsIiwiYmFuLXNhZmUiLCJ1bmRldGVjdGFibGUiLCJsc21fbGl2ZV8iLCJsc21fdGVzdF8iXQ==', 'base64').toString('utf8'));

const root = resolve(process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const TARGETS = ['src', 'test', 'scripts', 'README.md', 'llms.txt', 'package.json', 'server.json', 'Dockerfile', '.github', 'dist'];
const EXEMPT = new Set(['contract/door-contract.json']);
const DASH_FILES = new Set(['README.md', 'llms.txt']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const TEXT = /\.(ts|mts|js|mjs|cjs|json|md|txt|ya?ml|sh|toml)$|^Dockerfile$/;

function* walk(p) {
  if (!existsSync(p)) return;
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) if (!SKIP_DIRS.has(name)) yield* walk(join(p, name));
  } else if (st.isFile()) yield p;
}

const problems = [];
let files = 0;
for (const t of TARGETS) {
  for (const file of walk(join(root, t))) {
    const rel = relative(root, file).split('\\').join('/');
    const base = rel.split('/').pop();
    if (EXEMPT.has(rel) || !TEXT.test(base)) continue;
    files++;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const lower = line.toLowerCase();
      for (const w of WORDS) if (lower.includes(w)) problems.push(`${rel}:${i + 1}: private word "${w}"`);
      if (DASH_FILES.has(rel) && /[–—]/.test(line)) problems.push(`${rel}:${i + 1}: long dash`);
    });
  }
}

if (problems.length) {
  console.error(`leak check failed (${problems.length}):\n` + problems.join('\n'));
  process.exit(1);
}
console.log(`leak check passed (${files} files)`);
