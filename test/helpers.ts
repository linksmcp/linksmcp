import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { saveAuth } from '../src/auth.js';
import { normaliseConfig, type Config } from '../src/config.js';
import { Door } from '../src/door.js';
import { ensureHome, resolvePaths, type Paths } from '../src/paths.js';
import { createMcpServer } from '../src/server.js';
import { Store } from '../src/store.js';

export const TZ = 'Europe/Amsterdam';

export interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: Call) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fake LinkedIn: routes "METHOD /path-regex" to handlers and records every call. */
export class FakeLinkedIn {
  calls: Call[] = [];
  private routes: { method: string; re: RegExp; h: Handler }[] = [];

  on(method: string, re: RegExp, h: Handler | unknown): this {
    const handler: Handler = typeof h === 'function' ? (h as Handler) : () => jsonResponse(h);
    this.routes.unshift({ method, re, h: handler });
    return this;
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: input,
      path: u.pathname.replace(/^\/voyager\/api/, '') + u.search,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    const r = this.routes.find((x) => x.method === call.method && x.re.test(call.path));
    if (!r) return new Response(`no route for ${call.method} ${call.path}`, { status: 404 });
    return r.h(call);
  };

  posts(re?: RegExp): Call[] {
    return this.calls.filter((c) => c.method === 'POST' && (!re || re.test(c.path)));
  }
}

export class FakeClock {
  constructor(public t: number) {}
  now = () => new Date(this.t);
  sleeps: number[] = [];
  onSleep: ((ms: number) => void) | null = null;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
    this.onSleep?.(ms);
  };
  /** Local wall clock time in TZ. */
  static at(iso: string): number {
    return new Date(iso).getTime();
  }
}

export interface Harness {
  dir: string;
  paths: Paths;
  store: Store;
  door: Door;
  li: FakeLinkedIn;
  clock: FakeClock;
  client: Client;
  config: Config;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any; text: string }>;
  close: () => Promise<void>;
}

export async function harness(opts: { start?: string; auth?: boolean; config?: Record<string, unknown> } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'linksmcp-test-'));
  const env = { LINKSMCP_HOME: dir } as NodeJS.ProcessEnv;
  const paths = resolvePaths(env);
  ensureHome(paths);
  if (opts.auth !== false) saveAuth(paths.auth, { li_at: 'AQEDtestcookie', jsessionid: 'ajax:123456789' });
  const config = normaliseConfig({ timezone: TZ, ...(opts.config ?? {}) }, {});
  const store = new Store(paths.db);
  const li = new FakeLinkedIn();
  // Amsterdam is UTC+1 in early March: 10:00 local.
  const clock = new FakeClock(FakeClock.at(opts.start ?? '2026-03-10T09:00:00Z'));
  const door = new Door({ store, paths, config: () => config, fetch: li.fetch, now: clock.now, sleep: clock.sleep, random: () => 0, env });
  const server = createMcpServer({ door, pollIntervalS: 15 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    const text = r.content?.[0]?.text ?? '';
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { isError: !!r.isError, data, text };
  };
  return {
    dir,
    paths,
    store,
    door,
    li,
    clock,
    client,
    config,
    call,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
