import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/leak-check.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (dir: string) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });

describe('leak check', () => {
  it('passes on this tree', () => {
    const r = run(root);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails on a private word and on a long dash in the README', () => {
    const dir = mkdtempSync(join(tmpdir(), 'linksmcp-leak-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.ts'), `// built by ${'ban'}-safe tooling\n`);
      writeFileSync(join(dir, 'README.md'), 'one — two\n');
      writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/src\/a\.ts:1/);
      expect(r.stderr).toMatch(/README\.md:1: long dash/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exempts the vendored contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'linksmcp-leak-'));
    try {
      mkdirSync(join(dir, 'contract'));
      writeFileSync(join(dir, 'contract', 'door-contract.json'), '{"server":"x"}');
      expect(run(dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
