import { existsSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';

/** The LinkedIn session the user gave us: the li_at cookie and, once known, JSESSIONID. */
export interface Auth {
  li_at: string;
  jsessionid?: string;
  saved_at?: string;
}

/** Strips quotes, a "li_at=" prefix and whitespace a user may paste along with the value. */
export function cleanCookie(v: string, name: string): string {
  let s = v.trim();
  if (s.toLowerCase().startsWith(`${name.toLowerCase()}=`)) s = s.slice(name.length + 1);
  s = s.replace(/;.*$/, '').trim();
  return s.replace(/^"+|"+$/g, '');
}

/**
 * Reads the session: LINKSMCP_LI_AT (and LINKSMCP_JSESSIONID) win over auth.json.
 * Returns null when there is none.
 */
export function loadAuth(path: string, env: NodeJS.ProcessEnv = process.env): Auth | null {
  if (env.LINKSMCP_LI_AT && env.LINKSMCP_LI_AT.trim()) {
    const a: Auth = { li_at: cleanCookie(env.LINKSMCP_LI_AT, 'li_at') };
    if (env.LINKSMCP_JSESSIONID && env.LINKSMCP_JSESSIONID.trim()) a.jsessionid = cleanCookie(env.LINKSMCP_JSESSIONID, 'JSESSIONID');
    else {
      const saved = readFile(path);
      if (saved && saved.li_at === a.li_at && saved.jsessionid) a.jsessionid = saved.jsessionid;
    }
    return a;
  }
  return readFile(path);
}

function readFile(path: string): Auth | null {
  if (!existsSync(path)) return null;
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<Auth>;
    if (typeof o.li_at !== 'string' || !o.li_at) return null;
    return { li_at: o.li_at, jsessionid: typeof o.jsessionid === 'string' && o.jsessionid ? o.jsessionid : undefined, saved_at: o.saved_at };
  } catch {
    return null;
  }
}

/** Writes auth.json with mode 600. */
export function saveAuth(path: string, auth: Auth): void {
  const body: Auth = { li_at: auth.li_at, jsessionid: auth.jsessionid, saved_at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function deleteAuth(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
