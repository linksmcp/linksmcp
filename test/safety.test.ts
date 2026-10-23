import { describe, expect, it } from 'vitest';
import { normaliseConfig } from '../src/config.js';
import {
  afterWrite,
  checkRead,
  checkWrite,
  containsLink,
  localDay,
  nextLocalMidnight,
  restrictionUntil,
  workingHours,
  ZERO_COUNTS,
  type AccountSafety,
  type Counts,
  type WriteRequest,
} from '../src/safety.js';

const TZ = 'Europe/Amsterdam';
const cfg = normaliseConfig({ timezone: TZ }, {});
/** Local Amsterdam wall clock in March 2026 before the DST switch (UTC+1). */
const at = (hhmm: string, day = '2026-03-10') => new Date(`${day}T${hhmm}:00+01:00`);
const clean: AccountSafety = { sessionExpired: false, restrictedUntil: null, restrictedReason: null, nextWriteAt: null, nextInviteAt: null };
const counts = (c: Partial<Counts> = {}): Counts => ({ ...ZERO_COUNTS, ...c });

function check(req: WriteRequest, o: { now?: Date; counts?: Partial<Counts>; account?: Partial<AccountSafety> } = {}) {
  return checkWrite(req, { cfg, counts: counts(o.counts), account: { ...clean, ...o.account }, now: o.now ?? at('10:00') });
}
const code = (d: ReturnType<typeof check>) => (d.ok ? null : d.refusal.error_code);
const retry = (d: ReturnType<typeof check>) => (d.ok ? null : d.refusal.retry_after_s);

describe('days and time zones', () => {
  it('counts per local calendar day in the configured zone', () => {
    expect(localDay(new Date('2026-03-10T22:59:59Z'), TZ)).toBe('2026-03-10');
    expect(localDay(new Date('2026-03-10T23:00:00Z'), TZ)).toBe('2026-03-11');
    expect(localDay(new Date('2026-03-10T23:00:00Z'), 'UTC')).toBe('2026-03-10');
  });
  it('finds the next local midnight, also on a 23 hour day', () => {
    expect(nextLocalMidnight(at('10:00'), TZ).toISOString()).toBe('2026-03-10T23:00:00.000Z');
    // 2026-03-29: Amsterdam moves to UTC+2, midnight after is 22:00Z.
    expect(nextLocalMidnight(new Date('2026-03-29T10:00:00Z'), TZ).toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });
});

describe('working hours 08:00 to 20:00', () => {
  it('is closed at 07:59 and points to 08:00 the same day', () => {
    const h = workingHours(at('07:59'), cfg);
    expect(h.open).toBe(false);
    expect(h.nextStart?.toISOString()).toBe('2026-03-10T07:00:00.000Z');
  });
  it('is open from 08:00 up to 19:59', () => {
    expect(workingHours(at('08:00'), cfg).open).toBe(true);
    expect(workingHours(at('19:59'), cfg).open).toBe(true);
  });
  it('is closed at 20:00 and points to 08:00 the next day', () => {
    const h = workingHours(at('20:00'), cfg);
    expect(h.open).toBe(false);
    expect(h.nextStart?.toISOString()).toBe('2026-03-11T07:00:00.000Z');
  });
  it('supports a window across midnight', () => {
    const night = normaliseConfig({ timezone: TZ, working_hours: '22:00-06:00' }, {});
    expect(workingHours(at('23:30'), night).open).toBe(true);
    expect(workingHours(at('05:59'), night).open).toBe(true);
    expect(workingHours(at('06:00'), night).open).toBe(false);
  });
  it('refuses writes outside hours with retry_after_s to the window start', () => {
    const d = check({ kind: 'message', text: 'hi' }, { now: at('07:00') });
    expect(code(d)).toBe('outside_working_hours');
    expect(retry(d)).toBe(3600);
  });
  it('beats the caps in order', () => {
    expect(code(check({ kind: 'message', text: 'hi' }, { now: at('21:00'), counts: { message: 100 } }))).toBe('outside_working_hours');
  });
});

describe('daily caps', () => {
  const toMidnight = 14 * 3600; // 10:00 local -> 24:00 local
  it('messages: 99 sent is fine, 100 is the cap', () => {
    expect(check({ kind: 'message', text: 'hi' }, { counts: { message: 99 } }).ok).toBe(true);
    const d = check({ kind: 'message', text: 'hi' }, { counts: { message: 100 } });
    expect(code(d)).toBe('daily_send_cap');
    expect(retry(d)).toBe(toMidnight);
  });
  it('new threads: 50 is the cap, replies still go', () => {
    expect(code(check({ kind: 'message', newThread: true, text: 'hi' }, { counts: { message: 50, new_thread: 50 } }))).toBe('new_contact_cap');
    expect(check({ kind: 'message', newThread: false, text: 'hi' }, { counts: { message: 50, new_thread: 50 } }).ok).toBe(true);
    expect(check({ kind: 'message', newThread: true, text: 'hi' }, { counts: { new_thread: 49 } }).ok).toBe(true);
  });
  it('invitations: 20 is the cap', () => {
    expect(check({ kind: 'invite' }, { counts: { invite: 19 } }).ok).toBe(true);
    const d = check({ kind: 'invite' }, { counts: { invite: 20 } });
    expect(code(d)).toBe('daily_invite_cap');
    expect(retry(d)).toBe(toMidnight);
  });
  it('accepts: 20 is the cap', () => {
    expect(check({ kind: 'accept' }, { counts: { accept: 19 } }).ok).toBe(true);
    expect(code(check({ kind: 'accept' }, { counts: { accept: 20 } }))).toBe('daily_invite_cap');
  });
  it('profile views 250 and searches 30 are read caps, not bound to working hours', () => {
    const night = at('23:00');
    expect(checkRead('profile_view', counts({ profile_view: 249 }), cfg, night)).toBeNull();
    expect(checkRead('profile_view', counts({ profile_view: 250 }), cfg, night)?.error_code).toBe('daily_read_cap');
    expect(checkRead('search', counts({ search: 29 }), cfg, at('10:00'))).toBeNull();
    const r = checkRead('search', counts({ search: 30 }), cfg, at('10:00'));
    expect(r?.error_code).toBe('daily_read_cap');
    expect(r?.retry_after_s).toBe(14 * 3600);
  });
});

describe('links', () => {
  it.each([
    ['see https://example.com', true],
    ['see http://x.io/a', true],
    ['go to www.example.org', true],
    ['example.com has it', true],
    ['short link lnkd.in/abc', true],
    ['Visit Acme.Co today', true],
    ['mail me at sam@example.com', false],
    ['I use Node.js and e.g. TypeScript', false],
    ['version 2.5 is out. Next week more', false],
    ['no links here', false],
  ])('%s -> %s', (text, want) => {
    expect(containsLink(text)).toBe(want);
  });
  it('refuses any link in a connection note', () => {
    expect(code(check({ kind: 'invite', text: 'Hi, see example.com' }))).toBe('link_not_allowed');
    expect(check({ kind: 'invite', text: 'Hi, great talk yesterday' }).ok).toBe(true);
  });
  it('refuses a link to a person who has not written back in the thread', () => {
    expect(code(check({ kind: 'message', newThread: true, text: 'https://example.com', thread: { theyWrote: false, last: null } }))).toBe('link_not_allowed');
    const ours = { theyWrote: false, last: { direction: 'outbound' as const, at: at('08:00', '2026-03-05') } };
    expect(code(check({ kind: 'message', text: 'see www.example.com', thread: ours }))).toBe('link_not_allowed');
  });
  it('allows a link once they have written back', () => {
    const theirs = { theyWrote: true, last: { direction: 'inbound' as const, at: at('09:59') } };
    expect(check({ kind: 'message', text: 'here: https://example.com', thread: theirs }).ok).toBe(true);
  });
});

describe('24 h floor when your message is the last one', () => {
  it('holds a second message sent less than 24 h after ours', () => {
    const thread = { theyWrote: true, last: { direction: 'outbound' as const, at: new Date(at('10:00').getTime() - 24 * 3600_000 + 60_000) } };
    const d = check({ kind: 'message', text: 'following up', thread });
    expect(code(d)).toBe('rate_limited');
    expect(retry(d)).toBe(60);
  });
  it('lets it go at exactly 24 h', () => {
    const thread = { theyWrote: true, last: { direction: 'outbound' as const, at: new Date(at('10:00').getTime() - 24 * 3600_000) } };
    expect(check({ kind: 'message', text: 'following up', thread }).ok).toBe(true);
  });
  it('never holds a reply when they wrote last', () => {
    const thread = { theyWrote: true, last: { direction: 'inbound' as const, at: at('09:59') } };
    expect(check({ kind: 'message', text: 'thanks!', thread }).ok).toBe(true);
  });
});

describe('pacing', () => {
  const now = at('10:00');
  const plus = (s: number) => new Date(now.getTime() + s * 1000);
  it('waits itself up to 45 s', () => {
    const d = check({ kind: 'message', text: 'hi' }, { account: { nextWriteAt: plus(30) } });
    expect(d).toEqual({ ok: true, waitMs: 30_000 });
    expect(check({ kind: 'message', text: 'hi' }, { account: { nextWriteAt: plus(45) } })).toEqual({ ok: true, waitMs: 45_000 });
  });
  it('returns rate_limited beyond 45 s', () => {
    const d = check({ kind: 'message', text: 'hi' }, { account: { nextWriteAt: plus(46) } });
    expect(code(d)).toBe('rate_limited');
    expect(retry(d)).toBe(46);
  });
  it('uses the invitation gap for connection requests only', () => {
    expect(code(check({ kind: 'invite' }, { account: { nextInviteAt: plus(300) } }))).toBe('rate_limited');
    expect(check({ kind: 'message', text: 'hi' }, { account: { nextInviteAt: plus(300) } }).ok).toBe(true);
  });
  it('draws a 20 to 60 s write gap and a 5 to 8 min invitation gap', () => {
    expect(afterWrite('message', now, cfg, () => 0).nextWriteAt.getTime() - now.getTime()).toBe(20_000);
    expect(afterWrite('message', now, cfg, () => 1).nextWriteAt.getTime() - now.getTime()).toBe(60_000);
    const inv = afterWrite('invite', now, cfg, () => 0.5);
    expect(inv.nextInviteAt!.getTime() - now.getTime()).toBe(390_000);
    expect(afterWrite('accept', now, cfg, () => 0).nextInviteAt).toBeUndefined();
  });
});

describe('account state', () => {
  it('refuses writes after session_expired', () => {
    expect(code(check({ kind: 'message', text: 'hi' }, { account: { sessionExpired: true } }))).toBe('session_expired');
  });
  it('pauses writes for 48 h after a security check or restriction', () => {
    const now = at('10:00');
    const until = restrictionUntil(now, cfg);
    expect(until.getTime() - now.getTime()).toBe(48 * 3600_000);
    const d = check({ kind: 'invite' }, { account: { restrictedUntil: until, restrictedReason: 'security_challenge' } });
    expect(code(d)).toBe('security_challenge');
    expect(retry(d)).toBe(48 * 3600);
    expect(code(check({ kind: 'message', text: 'x' }, { account: { restrictedUntil: until, restrictedReason: 'account_suspended' } }))).toBe('account_suspended');
    expect(check({ kind: 'message', text: 'x' }, { now: new Date(until.getTime() + 1000), account: { restrictedUntil: until, restrictedReason: 'account_suspended' } }).ok).toBe(true);
  });
  it('lifts the pause once it is over', () => {
    const until = at('09:00');
    expect(check({ kind: 'message', text: 'x' }, { account: { restrictedUntil: until, restrictedReason: 'security_challenge' } }).ok).toBe(true);
  });
});

describe('config', () => {
  it('reads env overrides and falls back on bad values', () => {
    const c = normaliseConfig({ caps: { messages: 'x' }, working_hours: 'bad' }, { LINKSMCP_TZ: 'UTC', LINKSMCP_INVITES_PER_DAY: '5', LINKSMCP_SEARCH_QUERY_ID: 'q.1' });
    expect(c.caps.messages).toBe(100);
    expect(c.caps.invitations).toBe(5);
    expect(c.working_hours).toEqual({ start: '08:00', end: '20:00' });
    expect(c.timezone).toBe('UTC');
    expect(c.search_query_id).toBe('q.1');
  });
});
