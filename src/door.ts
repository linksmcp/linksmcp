import type { Logger } from 'pino';
import { cleanCookie, deleteAuth, loadAuth, saveAuth, type Auth } from './auth.js';
import type { Config } from './config.js';
import { fetchJsessionid, LinkedInClient, type FetchLike } from './linkedin/client.js';
import { getDistance, getMe, getProfile } from './linkedin/profile.js';
import { getEvents, listConversations, type LiConversation, type LiEvent, type Person } from './linkedin/messaging.js';
import type { Paths } from './paths.js';
import {
  afterWrite,
  checkRead,
  checkWrite,
  localDay,
  restrictionUntil,
  workingHours,
  type ActionKind,
  type AccountSafety,
  type Counts,
  type ReadKind,
  type WriteRequest,
} from './safety.js';
import type { ChatRow, ContactRow, MessageRow, Store } from './store.js';
import { ACCOUNT_ID, CHANNEL, CONTRACT_VERSION, profileUrlFor, ToolError, type WireAccount, type WireChat, type WireLinkedinStatus, type WireMessage } from './wire.js';

export interface DoorDeps {
  store: Store;
  paths: Paths;
  config: () => Config;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
}

export interface ConnectInput {
  cookie_jar?: unknown;
  li_at?: string;
  jsessionid?: string;
  country?: string;
}

/**
 * Reads li_at and JSESSIONID from a cookie export: an array of {name, value, domain, ...}, an object
 * with a cookies array, or either as a JSON string. Cookies for other sites are ignored.
 */
export function cookiesFromJar(jar: unknown): { liAt: string | null; jsessionid: string | null } {
  let v = jar;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw new ToolError('invalid_request', 'cookie_jar is not valid JSON. Pass the cookie export as it was saved (an array of {name, value, domain}).');
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { cookies?: unknown }).cookies)) v = (v as { cookies: unknown[] }).cookies;
  if (!Array.isArray(v)) throw new ToolError('invalid_request', 'cookie_jar must be an array of cookies ({name, value, domain}) or that array as a JSON string.');
  const onLinkedIn = (d: unknown) => typeof d !== 'string' || d === '' || /(^|\.)linkedin\.com$/i.test(d.replace(/^\./, '').trim());
  const find = (name: string): string | null => {
    for (const c of v as unknown[]) {
      if (!c || typeof c !== 'object') continue;
      const o = c as Record<string, unknown>;
      if (o.name === name && typeof o.value === 'string' && o.value.trim() && onLinkedIn(o.domain)) return cleanCookie(o.value, name);
    }
    return null;
  };
  return { liAt: find('li_at'), jsessionid: find('JSESSIONID') };
}

const NO_ACCOUNT_HINT = 'No LinkedIn session is stored. Call connect_linkedin with the li_at cookie from your browser, or run "linksmcp login".';

/** Everything the tools share: the session, the store, the clock and the safety rules. */
export class Door {
  readonly store: Store;
  readonly paths: Paths;
  readonly config: () => Config;
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  private readonly env: NodeJS.ProcessEnv;
  readonly log?: Logger;
  private cachedClient: LinkedInClient | null = null;
  /** JSESSIONID fetched for an env-provided cookie; kept in memory only. */
  private envJsession: { liAt: string; id: string } | null = null;

  constructor(deps: DoorDeps) {
    this.store = deps.store;
    this.paths = deps.paths;
    this.config = deps.config;
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.env = deps.env ?? process.env;
    this.log = deps.log;
  }

  // ---------- session ----------

  auth(): Auth | null {
    return loadAuth(this.paths.auth, this.env);
  }

  private fromEnv(): boolean {
    return !!(this.env.LINKSMCP_LI_AT && this.env.LINKSMCP_LI_AT.trim());
  }

  /** A client for the stored session, fetching JSESSIONID once when it is missing. */
  async client(): Promise<LinkedInClient> {
    const auth = this.auth();
    if (!auth) throw new ToolError('no_connected_account', NO_ACCOUNT_HINT);
    if (this.cachedClient && this.cachedClient.session.liAt === auth.li_at) return this.cachedClient;
    let jsessionid = auth.jsessionid;
    if (!jsessionid && this.envJsession?.liAt === auth.li_at) jsessionid = this.envJsession.id;
    if (!jsessionid) {
      jsessionid = await this.guard(() => fetchJsessionid(auth.li_at, this.fetch));
      if (this.fromEnv()) this.envJsession = { liAt: auth.li_at, id: jsessionid };
      else saveAuth(this.paths.auth, { ...auth, jsessionid });
    }
    const c = new LinkedInClient({ liAt: auth.li_at, jsessionid }, this.fetch);
    this.cachedClient = c;
    if (!this.store.account().urn_id) await this.refreshMe(c);
    return c;
  }

  private async refreshMe(c: LinkedInClient): Promise<void> {
    const me = await this.guard(() => getMe(c));
    const acc = this.store.account();
    this.store.updateAccount({
      status: 'connected',
      identifier: me.linkedin_username,
      urn_id: me.urn_id,
      name: me.name,
      connected_at: acc.connected_at ?? this.now().getTime(),
    });
  }

  /** Runs a LinkedIn call and records what its failure means for the account. */
  async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ToolError) this.applyError(err);
      throw err;
    }
  }

  applyError(err: ToolError): void {
    const now = this.now();
    if (err.code === 'session_expired') {
      this.store.updateAccount({ status: 'session_expired' });
      this.cachedClient = null;
    } else if (err.code === 'security_challenge' || err.code === 'account_suspended') {
      const until = restrictionUntil(now, this.config());
      this.store.updateAccount({ restricted_until: until.getTime(), restricted_reason: err.code });
      this.log?.warn({ code: err.code, until: until.toISOString() }, 'writes paused');
    }
  }

  /**
   * Checks the cookies with /me and stores them. A cookie LinkedIn refuses is a "failed" status with
   * the reason (nothing stored); a request without any li_at is refused with invalid_request.
   */
  async connect(input: ConnectInput): Promise<WireLinkedinStatus> {
    let liAt = typeof input.li_at === 'string' ? cleanCookie(input.li_at, 'li_at') : '';
    let jsessionid = typeof input.jsessionid === 'string' ? cleanCookie(input.jsessionid, 'JSESSIONID') : '';
    if (input.cookie_jar !== undefined && input.cookie_jar !== null && input.cookie_jar !== '') {
      const jar = cookiesFromJar(input.cookie_jar);
      if (!jar.liAt && !liAt) throw new ToolError('invalid_request', 'cookie_jar has no li_at cookie for linkedin.com. Export the cookies while signed in to linkedin.com.');
      liAt = liAt || jar.liAt || '';
      jsessionid = jsessionid || jar.jsessionid || '';
    }
    if (!liAt) throw new ToolError('invalid_request', 'Pass cookie_jar (your linkedin.com cookie export) or li_at.');
    const country = typeof input.country === 'string' && input.country.trim() ? input.country.trim().toUpperCase() : null;
    try {
      if (!jsessionid) jsessionid = await fetchJsessionid(liAt, this.fetch);
      const c = new LinkedInClient({ liAt, jsessionid }, this.fetch);
      const me = await getMe(c);
      if (!me.urn_id && !me.linkedin_username) throw new ToolError('session_expired', 'LinkedIn did not return your profile for these cookies. Sign in to linkedin.com again and export fresh cookies.');
      saveAuth(this.paths.auth, { li_at: liAt, jsessionid });
      this.cachedClient = c;
      this.store.updateAccount({
        status: 'connected',
        identifier: me.linkedin_username,
        urn_id: me.urn_id,
        name: me.name,
        connected_at: this.now().getTime(),
        ...(country ? { country } : {}),
      });
    } catch (err) {
      return {
        account_id: ACCOUNT_ID,
        status: 'failed',
        step: null,
        error: err instanceof ToolError ? err.message : `Could not check the cookies: ${(err as Error).message}`,
        profile_name: null,
        profile_url: null,
      };
    }
    return this.linkedinStatus(false);
  }

  /** The hosted lane's status object; with extras = true it adds limits and hint (get_linkedin_status). */
  linkedinStatus(extras = true): WireLinkedinStatus {
    const a = this.store.account();
    const acc = this.wireAccount();
    const hasAuth = !!this.auth();
    let status: WireLinkedinStatus['status'] = 'connected';
    let error: string | null = null;
    if (!hasAuth) status = 'disconnected';
    else if (a.status === 'session_expired') {
      status = 'failed';
      error = 'LinkedIn no longer accepts the stored cookies. Sign in to linkedin.com and connect again with fresh cookies.';
    }
    const out: WireLinkedinStatus = {
      account_id: ACCOUNT_ID,
      status,
      step: null,
      error,
      profile_name: hasAuth ? a.name : null,
      profile_url: hasAuth && a.identifier ? profileUrlFor(a.identifier) : null,
    };
    if (extras) {
      out.limits = acc.limits;
      if (acc.hint) out.hint = acc.hint;
    }
    return out;
  }

  /** Forgets the stored cookie. The 48 h pause, if any, stays in force. */
  disconnect(): void {
    deleteAuth(this.paths.auth);
    this.cachedClient = null;
    this.envJsession = null;
    this.store.updateAccount({ status: 'disconnected', connected_at: null });
  }

  // ---------- account and usage ----------

  safety(): AccountSafety {
    const a = this.store.account();
    return {
      sessionExpired: a.status === 'session_expired',
      restrictedUntil: a.restricted_until ? new Date(a.restricted_until) : null,
      restrictedReason: a.restricted_reason === 'account_suspended' || a.restricted_reason === 'security_challenge' ? a.restricted_reason : null,
      nextWriteAt: a.next_write_at ? new Date(a.next_write_at) : null,
      nextInviteAt: a.next_invite_at ? new Date(a.next_invite_at) : null,
    };
  }

  today(): string {
    return localDay(this.now(), this.config().timezone);
  }

  counts(): Counts {
    return this.store.countsForDay(this.today());
  }

  wireAccount(): WireAccount {
    const a = this.store.account();
    const cfg = this.config();
    const counts = this.counts();
    const now = this.now();
    const hasAuth = !!this.auth();
    let status: WireAccount['status'] = 'connected';
    let hint: string | undefined;
    if (!hasAuth) {
      status = 'disconnected';
      hint = NO_ACCOUNT_HINT;
    } else if (a.status === 'session_expired') {
      status = 'disconnected';
      hint = 'LinkedIn no longer accepts the stored cookie. Copy a fresh li_at cookie and call connect_linkedin.';
    } else if (a.restricted_until && a.restricted_until > now.getTime()) {
      status = 'restricted';
      hint = `Writes are paused until ${new Date(a.restricted_until).toISOString()} after LinkedIn ${a.restricted_reason === 'account_suspended' ? 'restricted the account' : 'asked for a security check'}. Reading still works.`;
    }
    const w: WireAccount = {
      id: ACCOUNT_ID,
      channel: CHANNEL,
      connect_kind: 'cookie',
      identifier: hasAuth ? a.identifier : null,
      status,
      connected_at: hasAuth && a.connected_at ? new Date(a.connected_at).toISOString() : null,
      limits: {
        sends_today: counts.message,
        sends_cap: cfg.caps.messages,
        new_contacts_today: counts.new_thread,
        new_contacts_cap: cfg.caps.new_threads,
        ramp_day: null,
      },
    };
    if (hint) w.hint = hint;
    return w;
  }

  usage(): Record<string, unknown> {
    const cfg = this.config();
    const c = this.counts();
    const now = this.now();
    const s = this.safety();
    const hours = workingHours(now, cfg);
    let next = s.nextWriteAt && s.nextWriteAt > now ? s.nextWriteAt : now;
    if (s.restrictedUntil && s.restrictedUntil > next) next = s.restrictedUntil;
    if (!hours.open && hours.nextStart && hours.nextStart > next) next = hours.nextStart;
    const hasAuth = !!this.auth();
    const restricted = !!(s.restrictedUntil && s.restrictedUntil > now);
    const suspendedReason = s.sessionExpired ? 'session_expired' : restricted ? (s.restrictedReason ?? 'security_challenge') : null;
    return {
      plan: 'self-hosted',
      day: this.today(),
      sends: c.message,
      sends_cap: cfg.caps.messages,
      new_contacts: c.new_thread,
      new_contacts_cap: cfg.caps.new_threads,
      status: suspendedReason ? 'suspended' : 'active',
      ...(suspendedReason ? { suspended_reason: suspendedReason } : {}),
      accounts_total: hasAuth ? 1 : 0,
      accounts_connected: hasAuth && !s.sessionExpired ? 1 : 0,
      accounts_cap: 1,
      ramp_day: null,
      contract_version: CONTRACT_VERSION,
      linkedin: {
        invites: c.invite,
        invites_cap: cfg.caps.invitations,
        profile_views: c.profile_view,
        profile_views_cap: cfg.caps.profile_views,
        searches: c.search,
        searches_cap: cfg.caps.searches,
        accepts: c.accept,
        accepts_cap: cfg.caps.accepts,
        working_hours: { start: cfg.working_hours.start, end: cfg.working_hours.end, timezone: cfg.timezone, open_now: hours.open },
        next_write_allowed_at: s.sessionExpired ? null : next.toISOString(),
      },
    };
  }

  // ---------- safety gates ----------

  checkRead(kind: ReadKind): void {
    const r = checkRead(kind, this.counts(), this.config(), this.now());
    if (r) throw new ToolError(r.error_code, r.error, r.retry_after_s);
  }

  /**
   * Refuses a write that cannot happen today or now (account state, hours, caps, links) before the
   * reads it needs. Pacing is left to gateWrite, right before the write itself.
   */
  precheckWrite(req: WriteRequest): void {
    const d = checkWrite(req, { cfg: this.config(), counts: this.counts(), account: { ...this.safety(), nextWriteAt: null, nextInviteAt: null }, now: this.now() });
    if (!d.ok) throw new ToolError(d.refusal.error_code, d.refusal.error, d.refusal.retry_after_s);
  }

  /** Refuses or waits (at most 45 s) before a write. */
  async gateWrite(req: WriteRequest): Promise<void> {
    const d = checkWrite(req, { cfg: this.config(), counts: this.counts(), account: this.safety(), now: this.now() });
    if (!d.ok) throw new ToolError(d.refusal.error_code, d.refusal.error, d.refusal.retry_after_s);
    if (d.waitMs > 0) await this.sleep(d.waitMs);
  }

  record(kinds: ActionKind[], target: string | null): void {
    const now = this.now();
    const day = localDay(now, this.config().timezone);
    for (const k of kinds) this.store.recordAction(k, now.getTime(), day, target);
  }

  /** Records a successful write and draws the next pacing gap. */
  recordWrite(kind: 'message' | 'invite' | 'accept', extra: ActionKind[], target: string | null): void {
    const now = this.now();
    this.record([kind, ...extra], target);
    const next = afterWrite(kind, now, this.config(), this.random);
    this.store.updateAccount({ next_write_at: next.nextWriteAt.getTime(), ...(next.nextInviteAt ? { next_invite_at: next.nextInviteAt.getTime() } : {}) });
  }

  // ---------- people ----------

  /** Member id and degree for a public id, from the local cache or LinkedIn (not counted as a profile view). */
  async person(username: string, opts: { needDistance?: boolean } = {}): Promise<ContactRow> {
    let row = this.store.contactByUsername(username);
    const fresh = row && this.now().getTime() - row.updated_at < 24 * 3_600_000;
    if (row && fresh && row.id && (!opts.needDistance || row.distance !== null)) return row;
    const c = await this.client();
    const profile = await this.guard(() => getProfile(c, username));
    if (!profile.urn_id) throw new ToolError('invalid_recipient', `LinkedIn has no profile for "${username}".`);
    const distance = await this.guard(() => getDistance(c, profile.linkedin_username));
    this.store.upsertContact({
      id: profile.urn_id,
      username: profile.linkedin_username,
      name: profile.name,
      headline: profile.headline,
      distance,
      thread_id: row?.thread_id ?? null,
      updated_at: this.now().getTime(),
    });
    row = this.store.contact(profile.urn_id)!;
    return row;
  }

  // ---------- messages ----------

  private isSelf(p: Person | null): boolean {
    if (!p) return false;
    const a = this.store.account();
    return (!!p.urn_id && p.urn_id === a.urn_id) || (!!p.linkedin_username && !!a.identifier && p.linkedin_username.toLowerCase() === a.identifier.toLowerCase());
  }

  /** Stores one event. Returns true when it was new. */
  storeEvent(e: LiEvent): boolean {
    const outbound = this.isSelf(e.from);
    return this.store.upsertMessage({
      id: e.id,
      chat_id: e.thread_id,
      direction: outbound ? 'outbound' : 'inbound',
      text: e.text,
      status: outbound ? 'sent' : 'received',
      ts: e.created_at,
      sender_id: e.from?.urn_id ?? null,
      sender_username: e.from?.linkedin_username ?? null,
      sender_name: e.from?.name ?? null,
      raw: JSON.stringify(e),
    });
  }

  storeConversation(conv: LiConversation): void {
    const other = conv.participants.find((p) => !this.isSelf(p)) ?? null;
    const row: ChatRow = {
      id: conv.thread_id,
      name: conv.name ?? (conv.group ? null : other?.name ?? null),
      type: conv.group ? 'group' : 'user',
      unread_count: conv.unread_count,
      last_message_at: conv.last_activity_at,
      participant_id: conv.group ? null : other?.urn_id ?? null,
      participant_username: conv.group ? null : other?.linkedin_username ?? null,
      participant_name: conv.group ? null : other?.name ?? null,
      raw: null,
    };
    this.store.upsertChat(row);
    if (other?.urn_id && !conv.group) {
      this.store.upsertContact({ id: other.urn_id, username: other.linkedin_username, name: other.name, headline: null, distance: null, thread_id: conv.thread_id, updated_at: this.now().getTime() });
    }
    for (const e of conv.events) this.storeEvent(e);
  }

  /** One inbox request. Stores chats and the newest events LinkedIn includes. */
  async syncInbox(): Promise<LiConversation[]> {
    const c = await this.client();
    const convs = await this.guard(() => listConversations(c));
    for (const conv of convs) this.storeConversation(conv);
    return convs;
  }

  /** Reads one thread from LinkedIn and stores it. */
  async syncThread(threadId: string): Promise<LiEvent[]> {
    const c = await this.client();
    const events = await this.guard(() => getEvents(c, threadId));
    for (const e of events) this.storeEvent(e);
    const last = events[events.length - 1];
    if (last && !this.store.getChat(threadId)) {
      const other = events.find((e) => !this.isSelf(e.from))?.from ?? null;
      this.store.upsertChat({
        id: threadId,
        name: other?.name ?? null,
        type: 'user',
        unread_count: 0,
        last_message_at: last.created_at,
        participant_id: other?.urn_id ?? null,
        participant_username: other?.linkedin_username ?? null,
        participant_name: other?.name ?? null,
        raw: null,
      });
    }
    return events;
  }

  toWireMessage(m: MessageRow): WireMessage {
    const chat = this.store.getChat(m.chat_id);
    const contact: WireMessage['contact'] = { id: m.chat_id, linkedin_url: null };
    const username = m.direction === 'inbound' ? m.sender_username : chat?.participant_username;
    const name = m.direction === 'inbound' ? m.sender_name : (chat?.participant_name ?? chat?.name);
    if (name) contact.name = name;
    if (username) {
      contact.linkedin_username = username;
      contact.linkedin_url = profileUrlFor(username);
    }
    const w: WireMessage = {
      id: m.id,
      account_id: ACCOUNT_ID,
      channel: CHANNEL,
      direction: m.direction,
      text: m.text,
      status: m.status,
      timestamp: new Date(m.ts).toISOString(),
      contact,
      chat_id: m.chat_id,
      media: null,
      error: null,
    };
    if (m.status === 'failed') w.error = { code: 0, message: 'LinkedIn did not accept this message.' };
    return w;
  }

  toWireChat(c: ChatRow): WireChat {
    return {
      chat_id: c.id,
      channel: CHANNEL,
      name: c.name ?? c.participant_name ?? null,
      type: c.type === 'group' ? 'group' : 'user',
      unread_count: c.unread_count,
      last_message_at: c.last_message_at ? new Date(c.last_message_at).toISOString() : null,
    };
  }

  checkAccountId(id: unknown): void {
    if (id !== undefined && id !== ACCOUNT_ID) {
      throw new ToolError('account_not_found', `Unknown account_id "${String(id)}". This server has one account: "${ACCOUNT_ID}".`);
    }
  }
}
