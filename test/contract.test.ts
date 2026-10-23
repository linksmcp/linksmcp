import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, type Harness } from './helpers.js';

const contract = JSON.parse(readFileSync(new URL('../contract/door-contract.json', import.meta.url), 'utf8'));
const expected: { name: string; input: any }[] = [...contract.shared_tools, ...contract.channels.linkedin.tools];

let h: Harness;
let listed: { name: string; inputSchema: any }[];

beforeAll(async () => {
  h = await harness();
  listed = (await h.client.listTools()).tools as any;
});
afterAll(async () => h.close());

describe('door-contract parity', () => {
  it('vendors contract 1.0 for the linksmcp server', () => {
    expect(contract.version).toBe('1.0');
    expect(contract.channels.linkedin.server).toBe('linksmcp');
  });

  it('registers exactly the shared tools plus the LinkedIn tools', () => {
    expect(listed.map((t) => t.name).sort()).toEqual(expected.map((t) => t.name).sort());
    expect(listed).toHaveLength(18);
  });

  for (const tool of expected) {
    it(`${tool.name}: same input properties, required list and enums`, () => {
      const got = listed.find((t) => t.name === tool.name);
      expect(got, `${tool.name} is not registered`).toBeTruthy();
      const want = tool.input;
      const props = Object.keys(want.properties ?? {}).sort();
      expect(Object.keys(got!.inputSchema.properties ?? {}).sort()).toEqual(props);
      expect([...(got!.inputSchema.required ?? [])].sort()).toEqual([...(want.required ?? [])].sort());
      for (const p of props) {
        const w = want.properties[p];
        const g = got!.inputSchema.properties[p];
        if (w.enum) expect(g.enum, `${tool.name}.${p} enum`).toEqual(w.enum);
        if (w.type && w.type !== 'object') expect(g.type, `${tool.name}.${p} type`).toBe(w.type);
      }
    });
  }

  it('uses only error codes the contract defines', async () => {
    const src = ['tools/messaging.ts', 'tools/people.ts', 'tools/account.ts', 'tools/types.ts', 'door.ts', 'safety.ts', 'linkedin/client.ts', 'linkedin/ids.ts']
      .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    const used = new Set<string>();
    for (const m of src.matchAll(/(?:ToolError\(|refuse\(|error_code: )'([a-z_]+)'/g)) used.add(m[1]);
    for (const code of used) expect(Object.keys(contract.error_codes), `unknown error code ${code}`).toContain(code);
    expect(used.size).toBeGreaterThan(10);
  });
});
