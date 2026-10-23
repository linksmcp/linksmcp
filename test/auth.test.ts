import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuth, saveAuth } from '../src/auth.js';
import { cookieHeader, LinkedInClient } from '../src/linkedin/client.js';
import * as fx from './fixtures.js';
import { FakeLinkedIn, harness, type Harness } from './helpers.js';

const JAR = [
  { name: 'li_at', value: 'AQEDjar', domain: '.www.linkedin.com', path: '/' },
  { name: 'JSESSIONID', value: '"ajax:99"', domain: '.www.linkedin.com', path: '/' },
  { name: 'bcookie', value: '"v=2&abc"', domain: '.linkedin.com', path: '/' },
  { name: 'bscookie', value: '"v=1&def"', domain: '.www.linkedin.com', path: '/' },
  { name: 'lidc', value: '"b=VB12:s=V"', domain: '.linkedin.com', path: '/' },
  { name: 'li_rm', value: 'AQErm', domain: '.www.linkedin.com', path: '/' },
  { name: 'tracker', value: 'x', domain: '.example.com', path: '/' },
];
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

let h: Harness | undefined;
let dir: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('cookie header', () => {
  it('sends every stored cookie, JSESSIONID quoted', async () => {
    const li = new FakeLinkedIn().on('GET', /^\/me$/, fx.me);
    const cookies = JAR.slice(0, 6).map(({ name, value }) => ({ name, value: name === 'JSESSIONID' ? 'ajax:99' : value }));
    await new LinkedInClient({ liAt: 'AQEDjar', jsessionid: 'ajax:99', cookies }, li.fetch).request('/me');
    const header = li.calls[0].headers.cookie;
    expect(header.split('; ')).toHaveLength(6);
    expect(header).toBe('li_at=AQEDjar; JSESSIONID="ajax:99"; bcookie="v=2&abc"; bscookie="v=1&def"; lidc="b=VB12:s=V"; li_rm=AQErm');
    expect(li.calls[0].headers['csrf-token']).toBe('ajax:99');
  });

  it('is just li_at and JSESSIONID on the lone-cookie path', () => {
    expect(cookieHeader({ liAt: 'AQED', jsessionid: '"ajax:1"' })).toBe('li_at=AQED; JSESSIONID="ajax:1"');
    expect(cookieHeader({ liAt: 'AQED' })).toBe('li_at=AQED');
  });

  it('replaces the default user agent when one is set', async () => {
    const li = new FakeLinkedIn().on('GET', /^\/me$/, fx.me);
    await new LinkedInClient({ liAt: 'a', jsessionid: 'b', userAgent: UA }, li.fetch).request('/me');
    await new LinkedInClient({ liAt: 'a', jsessionid: 'b' }, li.fetch).request('/me');
    expect(li.calls[0].headers['user-agent']).toBe(UA);
    expect(li.calls[1].headers['user-agent']).toMatch(/Chrome\//);
  });
});

describe('auth.json', () => {
  it('round trips the cookie list, li_at, jsessionid and user agent with mode 600', () => {
    dir = mkdtempSync(join(tmpdir(), 'linksmcp-auth-'));
    const p = join(dir, 'auth.json');
    saveAuth(p, { li_at: 'AQEDjar', jsessionid: 'ajax:99', cookies: JAR, user_agent: UA });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    expect(raw.cookies.map((c: any) => c.name)).toEqual(['li_at', 'JSESSIONID', 'bcookie', 'bscookie', 'lidc', 'li_rm']);
    expect(raw.cookies[1].value).toBe('ajax:99');
    const a = loadAuth(p, {})!;
    expect(a).toMatchObject({ li_at: 'AQEDjar', jsessionid: 'ajax:99', user_agent: UA });
    expect(a.cookies).toHaveLength(6);
    expect(loadAuth(p, { LINKSMCP_USER_AGENT: 'Other/1.0' })!.user_agent).toBe('Other/1.0');
  });

  it('reads an older auth.json with only li_at and jsessionid', () => {
    dir = mkdtempSync(join(tmpdir(), 'linksmcp-auth-'));
    const p = join(dir, 'auth.json');
    writeFileSync(p, JSON.stringify({ li_at: 'AQEDold', jsessionid: 'ajax:7' }));
    const a = loadAuth(p, {})!;
    expect(a.cookies.map((c) => `${c.name}=${c.value}`)).toEqual(['li_at=AQEDold', 'JSESSIONID=ajax:7']);
  });

  it('builds the two-cookie list from LINKSMCP_LI_AT', () => {
    dir = mkdtempSync(join(tmpdir(), 'linksmcp-auth-'));
    const a = loadAuth(join(dir, 'auth.json'), { LINKSMCP_LI_AT: 'AQEDenv', LINKSMCP_JSESSIONID: '"ajax:8"' })!;
    expect(a.cookies.map((c) => `${c.name}=${c.value}`)).toEqual(['li_at=AQEDenv', 'JSESSIONID=ajax:8']);
  });
});

describe('connect with a full cookie jar', () => {
  it('keeps every linkedin.com cookie and sends them all on later requests', async () => {
    h = await harness({ auth: false });
    h.li.on('GET', /^\/me$/, fx.me).on('GET', /^\/messaging\/conversations\?keyVersion=LEGACY_INBOX$/, { elements: [] });
    const r = await h.call('connect_linkedin', { cookie_jar: JAR, country: 'NL' });
    expect(r.data.status).toBe('connected');
    expect(h.li.calls.some((c) => c.url.includes('/feed/'))).toBe(false);
    const saved = JSON.parse(readFileSync(h.paths.auth, 'utf8'));
    expect(saved.cookies).toHaveLength(6);
    expect(saved).toMatchObject({ li_at: 'AQEDjar', jsessionid: 'ajax:99' });
    await h.call('list_chats');
    const last = h.li.calls[h.li.calls.length - 1];
    expect(last.headers.cookie.split('; ')).toHaveLength(6);
    expect(last.headers.cookie).toContain('JSESSIONID="ajax:99"');
    expect(last.headers.cookie).not.toContain('tracker');
  });

  it('fetches JSESSIONID only when the jar has none, sending the jar to the feed', async () => {
    h = await harness({ auth: false });
    h.li
      .on('GET', /^\/feed\//, () => new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID="ajax:55"; Path=/' } }))
      .on('GET', /^\/me$/, fx.me);
    const noSession = JAR.filter((c) => c.name !== 'JSESSIONID');
    expect((await h.call('connect_linkedin', { cookie_jar: noSession })).data.status).toBe('connected');
    const feed = h.li.calls.find((c) => c.url.includes('/feed/'))!;
    expect(feed.headers.cookie.split('; ')).toHaveLength(5);
    expect(h.li.calls.find((c) => c.path === '/me')!.headers.cookie).toContain('JSESSIONID="ajax:55"');
  });

  it('still connects with a lone li_at', async () => {
    h = await harness({ auth: false });
    h.li.on('GET', /^\/feed\//, () => new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID="ajax:5"' } })).on('GET', /^\/me$/, fx.me);
    expect((await h.call('connect_linkedin', { li_at: 'AQEDlone' })).data.status).toBe('connected');
    expect(h.li.calls.find((c) => c.path === '/me')!.headers.cookie).toBe('li_at=AQEDlone; JSESSIONID="ajax:5"');
  });
});
