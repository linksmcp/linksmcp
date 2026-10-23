import type { Cookie } from '../auth.js';
import { ToolError } from '../wire.js';

export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';
export const API_BASE = `${LINKEDIN_ORIGIN}/voyager/api`;
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const NORMALIZED_JSON = 'application/vnd.linkedin.normalized+json+2.1';
export const REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRY_AFTER_S = 900;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Session {
  liAt: string;
  jsessionid: string;
  /** Every linkedin.com cookie of the browser session; when absent only li_at and JSESSIONID are sent. */
  cookies?: Cookie[];
  /**
   * User agent of the browser the cookies came from. LinkedIn ties a session to the browser that
   * created it; the same cookies arriving with a different browser fingerprint look like a stolen
   * session and get signed out. Sending the original browser's user agent keeps them consistent.
   */
  userAgent?: string;
}

/**
 * The Cookie header for a session: every stored cookie as name=value joined by "; ", with li_at
 * and JSESSIONID always present and JSESSIONID quoted the way LinkedIn sets it.
 */
export function cookieHeader(s: Pick<Session, 'liAt' | 'cookies'> & { jsessionid?: string }): string {
  const parts: string[] = [`li_at=${s.liAt}`];
  if (s.jsessionid) parts.push(`JSESSIONID="${s.jsessionid.replace(/^"+|"+$/g, '')}"`);
  const seen = new Set(parts);
  for (const c of s.cookies ?? []) {
    if (c.name === 'li_at' || c.name === 'JSESSIONID') continue;
    const p = `${c.name}=${c.value}`;
    if (!seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  }
  return parts.join('; ');
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  /** Query string already encoded (LinkedIn's rest.li syntax must not be re-encoded). */
  query?: string;
  body?: unknown;
  accept?: string;
}

function setCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one ? one.split(/,(?=\s*[A-Za-z0-9_-]+=)/) : [];
}

/** Reads JSESSIONID from Set-Cookie headers, without quotes. */
export function jsessionFromSetCookie(cookies: string[]): string | null {
  for (const c of cookies) {
    const m = /(?:^|\s)JSESSIONID=("?)([^";]+)\1/.exec(c);
    if (m) return m[2];
  }
  return null;
}

/** Maps a redirect target to the error it means, or null for an ordinary redirect. */
export function classifyRedirect(location: string): ToolError | null {
  const l = location.toLowerCase();
  if (l.includes('checkpoint/challenge')) {
    return new ToolError('security_challenge', 'LinkedIn asked for a security check. Open linkedin.com in your browser and finish it. Writes are paused for 48 hours.');
  }
  if (l.includes('restricted')) {
    return new ToolError('account_suspended', 'LinkedIn restricted this account. Writes are paused for 48 hours; check linkedin.com in your browser.');
  }
  if (l.includes('login') || l.includes('authwall') || l.includes('/uas/') || l.includes('checkpoint')) {
    return new ToolError('session_expired', 'The LinkedIn cookie no longer signs in. Copy a fresh li_at cookie and call connect_linkedin (or run linksmcp login).');
  }
  return null;
}

/** A 403 is a dead session when the body is empty or names the session; a 403 with another reason is a refused action. */
function looksSignedOut(body: string): boolean {
  return !body.trim() || /csrf|not authenticated|unauthenticated|unauthorized|login|session/i.test(body);
}

function looksRestricted(body: string): boolean {
  return /\b(account (has been |is )?restricted|restricted your account|RESTRICTED_MEMBER|MEMBER_RESTRICTED)\b/i.test(body);
}

/** Turns a non-2xx LinkedIn response into a ToolError. */
export async function mapError(res: Response): Promise<ToolError> {
  const status = res.status;
  const location = res.headers.get('location') ?? '';
  if (status >= 300 && status < 400) {
    return classifyRedirect(location) ?? new ToolError('send_failed', `LinkedIn answered with an unexpected redirect (${status}).`);
  }
  if (status === 999) {
    return new ToolError('security_challenge', 'LinkedIn blocked the request and wants a security check (HTTP 999). Open linkedin.com in your browser. Writes are paused for 48 hours.');
  }
  if (status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    const s = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : DEFAULT_RETRY_AFTER_S;
    return new ToolError('rate_limited', 'LinkedIn is rate limiting this account. Wait before the next request.', s);
  }
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '';
  }
  if (looksRestricted(body)) {
    return new ToolError('account_suspended', 'LinkedIn restricted this account. Writes are paused for 48 hours; check linkedin.com in your browser.');
  }
  if (status === 401 || (status === 403 && looksSignedOut(body))) {
    return new ToolError('session_expired', 'The LinkedIn cookie no longer signs in. Copy a fresh li_at cookie and call connect_linkedin (or run linksmcp login).');
  }
  if (status >= 500) return new ToolError('send_failed', `LinkedIn had a server error (${status}). Try again later.`);
  return new LinkedInHttpError(`LinkedIn refused the request (${status}).`, status, body);
}

/** A 4xx LinkedIn answered that is not one of the mapped cases; callers may inspect it. */
export class LinkedInHttpError extends ToolError {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super('send_failed', message);
  }
}

/** Gets a JSESSIONID for an li_at cookie by loading the feed once, without following redirects. */
export async function fetchJsessionid(
  liAt: string,
  fetchImpl: FetchLike = fetch,
  opts: { cookies?: Cookie[]; userAgent?: string } = {},
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`${LINKEDIN_ORIGIN}/feed/`, {
      method: 'GET',
      redirect: 'manual',
      headers: { cookie: cookieHeader({ liAt, cookies: opts.cookies }), 'user-agent': opts.userAgent || USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ToolError('no_connected_account', `Could not reach LinkedIn: ${(err as Error).message}`);
  }
  const id = jsessionFromSetCookie(setCookies(res));
  if (id) return id;
  const loc = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && loc) {
    const e = classifyRedirect(loc);
    if (e) throw e;
  }
  if (res.status === 999) throw await mapError(res);
  throw new ToolError(
    'no_connected_account',
    'LinkedIn did not return a JSESSIONID for this cookie. Copy the JSESSIONID cookie from the same browser (without quotes) and pass it as jsessionid.',
  );
}

/** A small client for LinkedIn's web API. One instance per session. */
export class LinkedInClient {
  constructor(
    readonly session: Session,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private headers(accept: string, hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      cookie: cookieHeader(this.session),
      'csrf-token': this.session.jsessionid,
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
      accept,
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': this.session.userAgent || USER_AGENT,
    };
    if (hasBody) h['content-type'] = 'application/json; charset=UTF-8';
    return h;
  }

  /** Sends one request to the API. Returns parsed JSON ({} for an empty body); throws ToolError otherwise. */
  async request(path: string, opts: RequestOptions = {}): Promise<any> {
    const url = `${API_BASE}${path}${opts.query ? (path.includes('?') ? '&' : '?') + opts.query : ''}`;
    const hasBody = opts.body !== undefined;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method ?? 'GET',
        redirect: 'manual',
        headers: this.headers(opts.accept ?? NORMALIZED_JSON, hasBody),
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      const msg = e.name === 'TimeoutError' ? 'LinkedIn did not answer within 20 s.' : `Could not reach LinkedIn: ${e.message}`;
      throw new ToolError('send_failed', msg);
    }
    if (res.status < 200 || res.status >= 300) throw await mapError(res);
    const text = await res.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolError('send_failed', 'LinkedIn returned a response that is not JSON.');
    }
  }
}
