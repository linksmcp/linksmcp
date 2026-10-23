import type { Config, Range } from './config.js';

/**
 * The safety rules. Pure functions only: the clock (`now`) and the random source are passed in,
 * so every rule can be read and tested on its own.
 */

export type WriteKind = 'message' | 'invite' | 'accept';
export type ReadKind = 'profile_view' | 'search';
export type ActionKind = WriteKind | ReadKind | 'new_thread';

export interface Refusal {
  error_code: string;
  error: string;
  retry_after_s?: number;
}

/** Seconds the server waits itself before acting; longer gaps are returned as rate_limited. */
export const MAX_INLINE_WAIT_S = 45;

// ---------- time zone helpers ----------

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(at: Date, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(at)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function offsetMs(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a local wall clock time happens in the zone (the later one if the clock skips it). */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

/** YYYY-MM-DD of the local calendar day in the zone. */
export function localDay(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.m)}-${z(p.d)}`;
}

function addDays(p: Parts, n: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function nextLocalMidnight(at: Date, tz: string): Date {
  const n = addDays(zonedParts(at, tz), 1);
  return zonedTime(n.y, n.m, n.d, 0, 0, tz);
}

export function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

// ---------- working hours ----------

function hm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export interface HoursState {
  open: boolean;
  /** Start of the next window when closed. */
  nextStart: Date | null;
}

/** Working hours are [start, end) in local time, every day. start === end means always open. */
export function workingHours(now: Date, cfg: Pick<Config, 'working_hours' | 'timezone'>): HoursState {
  const start = hm(cfg.working_hours.start);
  const end = hm(cfg.working_hours.end);
  if (start === end) return { open: true, nextStart: null };
  const p = zonedParts(now, cfg.timezone);
  const cur = p.h * 60 + p.mi;
  const open = start < end ? cur >= start && cur < end : cur >= start || cur < end;
  if (open) return { open, nextStart: null };
  const sh = Math.floor(start / 60);
  const sm = start % 60;
  const day = cur < start ? { y: p.y, m: p.m, d: p.d } : addDays(p, 1);
  return { open, nextStart: zonedTime(day.y, day.m, day.d, sh, sm, cfg.timezone) };
}

// ---------- caps ----------

export interface Counts {
  message: number;
  new_thread: number;
  invite: number;
  accept: number;
  profile_view: number;
  search: number;
}

export const ZERO_COUNTS: Counts = { message: 0, new_thread: 0, invite: 0, accept: 0, profile_view: 0, search: 0 };

export function capFor(kind: ActionKind, cfg: Pick<Config, 'caps'>): number {
  switch (kind) {
    case 'message':
      return cfg.caps.messages;
    case 'new_thread':
      return cfg.caps.new_threads;
    case 'invite':
      return cfg.caps.invitations;
    case 'accept':
      return cfg.caps.accepts;
    case 'profile_view':
      return cfg.caps.profile_views;
    case 'search':
      return cfg.caps.searches;
  }
}

/** Read caps: profile views and searches. Reads are not bound to working hours. */
export function checkRead(kind: ReadKind, counts: Counts, cfg: Pick<Config, 'caps' | 'timezone'>, now: Date): Refusal | null {
  const cap = capFor(kind, cfg);
  if (counts[kind] < cap) return null;
  const what = kind === 'profile_view' ? 'profile views' : 'searches';
  return {
    error_code: 'daily_read_cap',
    error: `Daily limit of ${cap} ${what} reached. The limit resets at midnight local time.`,
    retry_after_s: secondsUntil(nextLocalMidnight(now, cfg.timezone), now),
  };
}

// ---------- links ----------

const TLDS =
  'com|net|org|io|ai|co|in|me|app|dev|ly|gl|to|us|uk|de|nl|fr|es|it|eu|info|biz|xyz|so|gg|tv|cc|link|site|online|tech|page|sh|be|ca|au|ch|se|no|dk|fi|pl|pt|br|mx|jp|ai|ws|ru|za|ae|sg|hk|nz|ie|at|cz|tr|id|my|ph|vn|kr|tw|il|ar|cl|store|shop|blog|news|live|cloud|digital|agency|studio|works|team|tools|email|ventures';
const BARE_DOMAIN = new RegExp(`(^|[^a-z0-9@._-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?=$|[^a-z0-9-])`, 'i');

/** True when the text carries a link: http://, https://, www. or a bare domain such as example.com or lnkd.in. */
export function containsLink(text: string): boolean {
  if (/https?:\/\//i.test(text)) return true;
  if (/(^|[^a-z0-9])www\./i.test(text)) return true;
  return BARE_DOMAIN.test(text);
}

// ---------- the write check ----------

export interface AccountSafety {
  /** True after LinkedIn stopped accepting the cookie, until a new one is stored. */
  sessionExpired: boolean;
  /** Writes are paused until this instant after a security check or a restriction. */
  restrictedUntil: Date | null;
  restrictedReason: 'security_challenge' | 'account_suspended' | null;
  /** Earliest instant the next write may happen (jitter already drawn). */
  nextWriteAt: Date | null;
  /** Earliest instant the next connection request may happen (jitter already drawn). */
  nextInviteAt: Date | null;
}

/** What we know about the thread a message goes to. Null fields = new thread. */
export interface ThreadState {
  /** True when the other person has written at least once in this thread. */
  theyWrote: boolean;
  /** Direction and time of the newest message in the thread, if any. */
  last: { direction: 'inbound' | 'outbound'; at: Date } | null;
}

export interface WriteRequest {
  kind: WriteKind;
  /** For messages: true when this opens a new thread. */
  newThread?: boolean;
  /** Message text or connection note. */
  text?: string;
  /** For messages: the thread the text goes into. */
  thread?: ThreadState;
}

export type WriteDecision = { ok: true; waitMs: number } | { ok: false; refusal: Refusal };

function refuse(error_code: string, error: string, retry_after_s?: number): WriteDecision {
  const r: Refusal = { error_code, error };
  if (retry_after_s !== undefined) r.retry_after_s = retry_after_s;
  return { ok: false, refusal: r };
}

/**
 * Decides whether one write may happen now. Order: account state, working hours, daily caps,
 * the link rule, the 24 h follow-up floor, then pacing. A refusal means nothing is sent.
 * An allowed write may carry a short wait (at most MAX_INLINE_WAIT_S) the caller sleeps first.
 */
export function checkWrite(req: WriteRequest, ctx: { cfg: Config; counts: Counts; account: AccountSafety; now: Date }): WriteDecision {
  const { cfg, counts, account, now } = ctx;
  const midnight = () => secondsUntil(nextLocalMidnight(now, cfg.timezone), now);

  if (account.sessionExpired) {
    return refuse('session_expired', 'LinkedIn no longer accepts the stored cookie. Sign in again with connect_linkedin or linksmcp login.');
  }
  if (account.restrictedUntil && account.restrictedUntil > now) {
    const code = account.restrictedReason ?? 'security_challenge';
    const why = code === 'account_suspended' ? 'LinkedIn restricted this account' : 'LinkedIn asked for a security check';
    return refuse(code, `${why}. Writes are paused until ${account.restrictedUntil.toISOString()}; reading the inbox still works.`, secondsUntil(account.restrictedUntil, now));
  }

  const hours = workingHours(now, cfg);
  if (!hours.open && hours.nextStart) {
    return refuse(
      'outside_working_hours',
      `Outside working hours (${cfg.working_hours.start} to ${cfg.working_hours.end}, ${cfg.timezone}). Nothing was sent.`,
      secondsUntil(hours.nextStart, now),
    );
  }

  if (req.kind === 'message') {
    if (counts.message >= cfg.caps.messages) {
      return refuse('daily_send_cap', `Daily limit of ${cfg.caps.messages} messages reached. The limit resets at midnight local time.`, midnight());
    }
    if (req.newThread && counts.new_thread >= cfg.caps.new_threads) {
      return refuse(
        'new_contact_cap',
        `Daily limit of ${cfg.caps.new_threads} new threads reached. Replies in existing threads still work. The limit resets at midnight local time.`,
        midnight(),
      );
    }
  } else if (req.kind === 'invite') {
    if (counts.invite >= cfg.caps.invitations) {
      return refuse('daily_invite_cap', `Daily limit of ${cfg.caps.invitations} connection requests reached. The limit resets at midnight local time.`, midnight());
    }
  } else if (req.kind === 'accept') {
    if (counts.accept >= cfg.caps.accepts) {
      return refuse('daily_invite_cap', `Daily limit of ${cfg.caps.accepts} accepted invitations reached. The limit resets at midnight local time.`, midnight());
    }
  }

  if (req.text && containsLink(req.text)) {
    if (req.kind === 'invite') {
      return refuse('link_not_allowed', 'Connection notes may not contain links. The note was refused, not edited; remove the link and try again.');
    }
    if (req.kind === 'message' && !(req.thread && req.thread.theyWrote)) {
      return refuse(
        'link_not_allowed',
        'Links are only allowed once the other person has written back in this thread. The message was refused, not edited; remove the link and try again.',
      );
    }
  }

  if (req.kind === 'message' && req.thread?.last && req.thread.last.direction === 'outbound') {
    const floorMs = cfg.follow_up_floor_hours * 3_600_000;
    const until = new Date(req.thread.last.at.getTime() + floorMs);
    if (until > now) {
      return refuse(
        'rate_limited',
        `Your message is the last one in this thread. The next message to this person can go after ${until.toISOString()} (${cfg.follow_up_floor_hours} h after your last one) or as soon as they reply.`,
        secondsUntil(until, now),
      );
    }
  }

  let readyAt = account.nextWriteAt?.getTime() ?? 0;
  if (req.kind === 'invite' && account.nextInviteAt) readyAt = Math.max(readyAt, account.nextInviteAt.getTime());
  const waitMs = Math.max(0, readyAt - now.getTime());
  if (waitMs > MAX_INLINE_WAIT_S * 1000) {
    const what = req.kind === 'invite' && account.nextInviteAt && account.nextInviteAt.getTime() === readyAt ? 'connection requests' : 'writes';
    return refuse('rate_limited', `Pacing gap between ${what}. Try again in ${Math.ceil(waitMs / 1000)} s.`, Math.ceil(waitMs / 1000));
  }
  return { ok: true, waitMs };
}

/** Random number of milliseconds within a range given in seconds. */
export function jitterMs(range: Range, rnd: () => number): number {
  return Math.round((range.min + (range.max - range.min) * rnd()) * 1000);
}

/** The pacing state after a write at `at`. */
export function afterWrite(kind: WriteKind, at: Date, cfg: Config, rnd: () => number): { nextWriteAt: Date; nextInviteAt?: Date } {
  const out: { nextWriteAt: Date; nextInviteAt?: Date } = { nextWriteAt: new Date(at.getTime() + jitterMs(cfg.write_gap_seconds, rnd)) };
  if (kind === 'invite') out.nextInviteAt = new Date(at.getTime() + jitterMs(cfg.invite_gap_seconds, rnd));
  return out;
}

/** The pause after LinkedIn flagged the account. */
export function restrictionUntil(at: Date, cfg: Pick<Config, 'restriction_pause_hours'>): Date {
  return new Date(at.getTime() + cfg.restriction_pause_hours * 3_600_000);
}
