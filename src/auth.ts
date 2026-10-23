import { existsSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';

/** One browser cookie as a cookie export holds it. */
export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

/**
 * The LinkedIn session the user gave us. `cookies` is the primary session: every linkedin.com
 * cookie of the signed-in browser, sent whole on each request (a lone li_at tends to get revoked,
 * a full browser session holds up). `li_at` and `jsessionid` stay for older auth.json files and
 * for the lone-cookie path, where `cookies` is just those two.
 */
export interface Auth {
  li_at: string;
  jsessionid?: string;
  cookies: Cookie[];
  /** User agent of the browser the cookies came from; replaces the default when set. */
  user_agent?: string;
  saved_at?: string;
}

/** Strips quotes, a "li_at=" prefix and whitespace a user may paste along with the value. */
export function cleanCookie(v: string, name: string): string {
  let s = v.trim();
  if (s.toLowerCase().startsWith(`${name.toLowerCase()}=`)) s = s.slice(name.length + 1);
  s = s.replace(/;.*$/, '').trim();
  return s.replace(/^"+|"+$/g, '');
}

/** True for a cookie LinkedIn should get: domain ending with linkedin.com (or no domain at all). */
export function isLinkedInCookie(domain: unknown): boolean {
  if (domain === undefined || domain === null || domain === '') return true;
  return typeof domain === 'string' && /(^|\.)linkedin\.com$/i.test(domain.trim().replace(/^\./, ''));
}

/**
 * The cookie list with li_at and JSESSIONID set to the given values (added when missing, replaced
 * when different). JSESSIONID is stored without quotes; the client quotes it on the wire.
 */
export function withSessionCookies(cookies: Cookie[], liAt: string, jsessionid?: string): Cookie[] {
  const out = cookies.filter((c) => c.name !== 'li_at' && (!jsessionid || c.name !== 'JSESSIONID'));
  const keptLiAt = cookies.find((c) => c.name === 'li_at');
  out.unshift({ ...(keptLiAt ?? { domain: '.www.linkedin.com', path: '/' }), name: 'li_at', value: liAt });
  if (jsessionid) {
    const kept = cookies.find((c) => c.name === 'JSESSIONID');
    out.splice(1, 0, { ...(kept ?? { domain: '.www.linkedin.com', path: '/' }), name: 'JSESSIONID', value: jsessionid });
  }
  return out;
}

function cookieList(v: unknown): Cookie[] {
  if (!Array.isArray(v)) return [];
  const out: Cookie[] = [];
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name || typeof o.value !== 'string' || !isLinkedInCookie(o.domain)) continue;
    const k: Cookie = { name: o.name, value: o.name === 'JSESSIONID' ? cleanCookie(o.value, 'JSESSIONID') : o.value };
    if (typeof o.domain === 'string' && o.domain) k.domain = o.domain;
    if (typeof o.path === 'string' && o.path) k.path = o.path;
    out.push(k);
  }
  return out;
}

const envUa = (env: NodeJS.ProcessEnv) => (env.LINKSMCP_USER_AGENT && env.LINKSMCP_USER_AGENT.trim() ? env.LINKSMCP_USER_AGENT.trim() : undefined);

/**
 * Reads the session: LINKSMCP_LI_AT (and LINKSMCP_JSESSIONID) win over auth.json, and
 * LINKSMCP_USER_AGENT wins over a stored user agent. Returns null when there is none.
 */
export function loadAuth(path: string, env: NodeJS.ProcessEnv = process.env): Auth | null {
  const ua = envUa(env);
  if (env.LINKSMCP_LI_AT && env.LINKSMCP_LI_AT.trim()) {
    const liAt = cleanCookie(env.LINKSMCP_LI_AT, 'li_at');
    let jsessionid = env.LINKSMCP_JSESSIONID && env.LINKSMCP_JSESSIONID.trim() ? cleanCookie(env.LINKSMCP_JSESSIONID, 'JSESSIONID') : undefined;
    const saved = readFile(path);
    if (!jsessionid && saved && saved.li_at === liAt && saved.jsessionid) jsessionid = saved.jsessionid;
    const a: Auth = { li_at: liAt, jsessionid, cookies: withSessionCookies([], liAt, jsessionid) };
    const agent = ua ?? (saved && saved.li_at === liAt ? saved.user_agent : undefined);
    if (agent) a.user_agent = agent;
    return a;
  }
  const a = readFile(path);
  if (a && ua) a.user_agent = ua;
  return a;
}

function readFile(path: string): Auth | null {
  if (!existsSync(path)) return null;
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const cookies = cookieList(o.cookies);
    const liAt = (typeof o.li_at === 'string' && o.li_at) || cookies.find((c) => c.name === 'li_at')?.value || '';
    if (!liAt) return null;
    const jsessionid = (typeof o.jsessionid === 'string' && o.jsessionid) || cookies.find((c) => c.name === 'JSESSIONID')?.value || undefined;
    const a: Auth = { li_at: liAt, jsessionid, cookies: withSessionCookies(cookies, liAt, jsessionid) };
    if (typeof o.user_agent === 'string' && o.user_agent.trim()) a.user_agent = o.user_agent.trim();
    if (typeof o.saved_at === 'string') a.saved_at = o.saved_at;
    return a;
  } catch {
    return null;
  }
}

/** Writes auth.json with mode 600: the cookie list plus li_at and jsessionid. */
export function saveAuth(path: string, auth: Omit<Auth, 'cookies'> & { cookies?: Cookie[] }): void {
  const cookies = withSessionCookies(cookieList(auth.cookies ?? []), auth.li_at, auth.jsessionid);
  const body: Auth = { li_at: auth.li_at, jsessionid: auth.jsessionid, cookies, saved_at: new Date().toISOString() };
  if (auth.user_agent) body.user_agent = auth.user_agent;
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function deleteAuth(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
