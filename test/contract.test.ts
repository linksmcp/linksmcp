import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, type Harness } from './helpers.js';

const contract = JSON.parse(readFileSync(new URL('../contract/door-contract.json', import.meta.url), 'utf8'));
const expected: { name: string; input: any }[] = [...contract.shared_tools, ...contract.channels.linkedin.tools];

/**
 * The one documented relaxation: self-hosted connect_linkedin accepts li_at instead of cookie_jar
 * and does not need country (contract channels.linkedin.notes). Nothing else may differ.
 */
const RELAXED_REQUIRED: Record<string, string[]> = { connect_linkedin: ['cookie_jar', 'country'] };

let h: Harness;
let listed: { name: string; inputSchema: any }[];

beforeAll(async () => {
  h = await harness();
  listed = (await h.client.listTools()).tools as any;
});
afterAll(async () => h.close());

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('door-contract parity', () => {
  it('vendors contract 1.0 for the linksmcp server', () => {
    expect(contract.version).toBe('1.0');
    expect(contract.channels.linkedin.server).toBe('linksmcp');
  });

  it('registers exactly the shared tools plus the LinkedIn tools', () => {
    expect(listed.map((t) => t.name).sort()).toEqual(expected.map((t) => t.name).sort());
    expect(contract.shared_tools).toHaveLength(9);
    expect(contract.channels.linkedin.tools).toHaveLength(10);
    expect(listed).toHaveLength(19);
  });

  for (const tool of expected) {
    it(`${tool.name}: same input properties, required list and enums`, () => {
      const got = listed.find((t) => t.name === tool.name);
      expect(got, `${tool.name} is not registered`).toBeTruthy();
      const want = tool.input;
      const props = Object.keys(want.properties ?? {}).sort();
      expect(Object.keys(got!.inputSchema.properties ?? {}).sort()).toEqual(props);
      const relaxed = RELAXED_REQUIRED[tool.name] ?? [];
      const wantRequired = (want.required ?? []).filter((r: string) => !relaxed.includes(r)).sort();
      expect([...(got!.inputSchema.required ?? [])].sort()).toEqual(wantRequired);
      for (const p of props) {
        const w = want.properties[p];
        const g = got!.inputSchema.properties[p];
        if (w.enum) expect(g.enum, `${tool.name}.${p} enum`).toEqual(w.enum);
        if (typeof w.type === 'string' && w.type !== 'object') expect(g.type, `${tool.name}.${p} type`).toBe(w.type);
      }
    });
  }

  it('relaxes only fields the contract requires', () => {
    for (const [name, fields] of Object.entries(RELAXED_REQUIRED)) {
      const want = expected.find((t) => t.name === name)!.input.required;
      for (const f of fields) expect(want).toContain(f);
    }
  });

  it('every error code thrown in src/ is defined by the contract', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const used = new Set<string>();
    for (const f of srcFiles(root)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:ToolError\(\s*|refuse\(\s*|super\(\s*|error_code:\s*)'([a-z_]+)'/g)) used.add(m[1]);
      for (const m of text.matchAll(/enumArg\([^)]*?'(invalid_[a-z_]+)'/g)) used.add(m[1]);
    }
    const defined = Object.keys(contract.error_codes);
    for (const code of used) expect(defined, `unknown error code ${code}`).toContain(code);
    expect(used.size).toBeGreaterThan(20);
  });
});
