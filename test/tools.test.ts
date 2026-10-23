import { afterEach, describe, expect, it } from 'vitest';
import { localDay } from '../src/safety.js';
import * as fx from './fixtures.js';
import { harness, jsonResponse, TZ, type Harness } from './helpers.js';

const NOW = Date.parse('2026-03-10T09:00:00Z'); // 10:00 in Amsterdam
const HOUR = 3_600_000;

let h: Harness;
afterEach(async () => h?.close());

/** A LinkedIn with Jane (wrote last), Dana (never wrote back), Bob (1st degree, no thread), Carl (2nd degree). */
async function world(opts: { start?: string } = {}) {
  h = await harness(opts);
  const { li } = h;
  const janeEvents = [fx.event('2-JANE', '5-J1', fx.people.self, 'Hi Jane, how is pricing going at Acme?', NOW - 3 * HOUR), fx.event('2-JANE', '5-J2', fx.people.jane, 'Pricing is fine, send me details', NOW - 2 * HOUR)];
  const danaEvents = [fx.event('2-DANA', '5-D1', fx.people.self, 'Hi Dana', NOW - 30 * HOUR)];
  const inbox = { elements: [fx.conversation('2-JANE', fx.people.jane, { unread: 1, lastActivityAt: NOW - 2 * HOUR, events: [janeEvents[1]] }), fx.conversation('2-DANA', fx.people.dana, { lastActivityAt: NOW - 30 * HOUR, events: danaEvents })] };
  li.on('GET', /^\/me$/, fx.me)
    .on('GET', /^\/messaging\/conversations\?keyVersion=LEGACY_INBOX$/, () => jsonResponse(inbox))
    .on('GET', /^\/messaging\/conversations\/2-JANE\/events/, { elements: janeEvents })
    .on('GET', /^\/messaging\/conversations\/2-DANA\/events/, { elements: danaEvents })
    .on('GET', /q=participants&recipients=List\(ACoBOB\)/, { elements: [] })
    .on('GET', /q=participants&recipients=List\(ACoCARL\)/, { elements: [] })
    .on('POST', /^\/messaging\/conversations\/2-JANE\/events\?action=create$/, fx.sendEvent('2-JANE', '5-J3', NOW))
    .on('POST', /^\/messaging\/conversations\?action=create$/, fx.createConversation('2-BOB', '5-B1', NOW))
    .on('POST', /^\/messaging\/conversations\/2-JANE$/, {})
    .on('POST', /verifyQuotaAndCreateV2/, fx.inviteCreated)
    .on('GET', /^\/relationships\/invitationViews/, fx.invitationViews)
    .on('POST', /^\/relationships\/invitations\/7001\?action=accept$/, {})
    .on('GET', /^\/graphql\?/, fx.search);
  for (const [key, dist] of [['jane', 'DISTANCE_1'], ['bob', 'DISTANCE_1'], ['carl', 'DISTANCE_2'], ['dana', 'DISTANCE_1']] as const) {
    const p = fx.people[key];
    li.on('GET', new RegExp(`^/identity/profiles/${p.publicIdentifier}/profileView$`), fx.profileView(p));
    li.on('GET', new RegExp(`^/identity/profiles/${p.publicIdentifier}/networkinfo$`), fx.networkinfo(dist));
  }
  li.on('GET', /^\/identity\/profiles\/me-self\/profileView$/, fx.profileView(fx.people.self));
  await h.call('list_chats');
  return h;
}

describe('accounts', () => {
  it('reports no account without a cookie', async () => {
    h = await harness({ auth: false });
    const r = await h.call('get_linkedin_status');
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ id: 'local', channel: 'linkedin', connect_kind: 'cookie', status: 'disconnected', identifier: null });
    expect(r.data.hint).toMatch(/connect_linkedin/);
    const s = await h.call('send_message', { to: { contact_id: 'x' }, text: 'hi' });
    expect(s.data.error_code).toBe('contact_not_found');
    const l = await h.call('list_chats');
    expect(l.data.error_code).toBe('no_connected_account');
  });

  it('connect_linkedin validates with /me and stores the cookie with mode 600', async () => {
    h = await harness({ auth: false });
    h.li.on('GET', /^\/feed\//, () => new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID="ajax:5"; Path=/' } })).on('GET', /^\/me$/, fx.me);
    const r = await h.call('connect_linkedin', { li_at: '"AQEDfresh"' });
    expect(r.data).toMatchObject({ status: 'connected', identifier: 'me-self' });
    const { statSync, readFileSync } = await import('node:fs');
    expect(statSync(h.paths.auth).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(h.paths.auth, 'utf8'))).toMatchObject({ li_at: 'AQEDfresh', jsessionid: 'ajax:5' });
    const d = await h.call('disconnect_linkedin');
    expect(d.data).toEqual({ disconnected: true });
    expect((await h.call('get_linkedin_status')).data.status).toBe('disconnected');
  });

  it('list_accounts and get_usage carry the contract fields', async () => {
    await world();
    const a = await h.call('list_accounts');
    expect(a.data.accounts).toHaveLength(1);
    expect(a.data.accounts[0]).toMatchObject({ id: 'local', status: 'connected', identifier: 'me-self', limits: { sends_today: 0, sends_cap: 100, new_contacts_today: 0, new_contacts_cap: 50, ramp_day: null } });
    const u = await h.call('get_usage');
    expect(u.data).toMatchObject({ plan: 'self-hosted', day: '2026-03-10', sends: 0, sends_cap: 100, new_contacts: 0, new_contacts_cap: 50, ramp_day: null, contract_version: '1.0' });
    expect(Object.keys(u.data.linkedin).sort()).toEqual(
      ['accepts', 'accepts_cap', 'invites', 'invites_cap', 'next_write_allowed_at', 'profile_views', 'profile_views_cap', 'searches', 'searches_cap', 'working_hours'].sort(),
    );
    expect(u.data.linkedin).toMatchObject({ invites_cap: 20, profile_views_cap: 250, searches_cap: 30, accepts_cap: 20, working_hours: { start: '08:00', end: '20:00', timezone: TZ, open_now: true } });
  });
});

describe('send_message', () => {
  it('posts into an existing thread, links allowed because she wrote back', async () => {
    await world();
    const r = await h.call('send_message', { to: { contact_id: '2-JANE' }, text: 'Here you go: https://example.com/pricing' });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ message_id: '5-J3', status: 'sent', chat_id: '2-JANE' });
    const post = h.li.posts(/2-JANE\/events/)[0];
    expect(post.body.eventCreate.value['com.linkedin.voyager.messaging.create.MessageCreate'].attributedBody.text).toBe('Here you go: https://example.com/pricing');
    expect(post.headers['csrf-token']).toBe('ajax:123456789');
    expect((await h.call('get_usage')).data.sends).toBe(1);
    const m = await h.call('get_message', { id: '5-J3' });
    expect(m.data).toMatchObject({ id: '5-J3', direction: 'outbound', chat_id: '2-JANE', channel: 'linkedin', contact: { id: '2-JANE', linkedin_username: 'jane-doe' } });
  });

  it('refuses a link to a person who never wrote back, and sends nothing', async () => {
    await world();
    h.clock.t = NOW + 1000;
    const r = await h.call('send_message', { to: { linkedin_username: 'dana-k' }, text: 'Check www.example.com' });
    expect(r.isError).toBe(true);
    expect(r.data.error_code).toBe('link_not_allowed');
    expect(h.li.posts(/messaging/)).toHaveLength(0);
  });

  it('holds a second message within 24 h while ours is the last one', async () => {
    await world();
    await h.call('send_message', { to: { contact_id: '2-JANE' }, text: 'Details attached in the next message' });
    h.clock.t += 10 * 60_000;
    // LinkedIn now shows our message last in the thread.
    h.li.on('GET', /^\/messaging\/conversations\/2-JANE\/events/, {
      elements: [fx.event('2-JANE', '5-J2', fx.people.jane, 'Pricing is fine, send me details', NOW - 2 * HOUR), fx.event('2-JANE', '5-J3', fx.people.self, 'Details attached in the next message', NOW)],
    });
    const r = await h.call('send_message', { to: { contact_id: '2-JANE' }, text: 'Any thoughts?' });
    expect(r.data.error_code).toBe('rate_limited');
    expect(r.data.retry_after_s).toBe(24 * 3600 - 600);
  });

  it('opens a new thread with a first degree connection', async () => {
    await world();
    const r = await h.call('send_message', { to: { profile_url: 'https://www.linkedin.com/in/bob-lee/' }, text: 'Hi Bob' });
    expect(r.data).toMatchObject({ status: 'sent', chat_id: '2-BOB' });
    const post = h.li.posts(/^\/messaging\/conversations\?action=create$/)[0];
    expect(post.body.conversationCreate.recipients).toEqual(['ACoBOB']);
    expect(post.body.conversationCreate.subtype).toBe('MEMBER_TO_MEMBER');
    const u = (await h.call('get_usage')).data;
    expect([u.sends, u.new_contacts]).toEqual([1, 1]);
  });

  it('needs a connection before a new thread with a second degree person', async () => {
    await world();
    const r = await h.call('send_message', { to: { linkedin_username: 'carl-x' }, text: 'Hi Carl' });
    expect(r.data.error_code).toBe('needs_connection_first');
  });

  it('waits a short pacing gap itself and refuses a long one', async () => {
    await world();
    await h.call('send_message', { to: { contact_id: '2-JANE' }, text: 'one' }); // random 0 -> next write in 20 s
    h.li.on('POST', /^\/messaging\/conversations\?action=create$/, fx.createConversation('2-BOB', '5-B1', NOW + 20_000));
    const before = h.clock.sleeps.length;
    const r = await h.call('send_message', { to: { linkedin_username: 'bob-lee' }, text: 'two' });
    expect(r.data.status).toBe('sent');
    expect(h.clock.sleeps.slice(before)).toEqual([20_000]);
    h.store.updateAccount({ next_write_at: h.clock.t + 120_000 });
    const t = await h.call('send_message', { to: { contact_id: '2-DANA' }, text: 'three' });
    expect(t.data).toMatchObject({ error_code: 'rate_limited', retry_after_s: 120 });
  });

  it('refuses outside working hours with retry_after_s to 08:00', async () => {
    await world({ start: '2026-03-10T20:30:00Z' }); // 21:30 local
    const r = await h.call('send_message', { to: { contact_id: '2-JANE' }, text: 'late' });
    expect(r.data.error_code).toBe('outside_working_hours');
    expect(r.data.retry_after_s).toBe(10.5 * 3600);
  });

  it('rejects media, lists and two recipient fields', async () => {
    await world();
    expect((await h.call('send_message', { to: { contact_id: '2-JANE' }, text: 'x', media_url: 'https://example.com/a.png' })).data.error_code).toBe('media_unavailable');
    expect((await h.call('send_message', { to: { contact_id: '2-JANE' }, media_path: '/tmp/a.png' })).data.error_code).toBe('media_unavailable');
    expect((await h.call('send_message', { to: { contact_id: '2-JANE', linkedin_username: 'jane-doe' }, text: 'x' })).data.error_code).toBe('invalid_recipient');
    expect((await h.call('send_message', { to: { phone: '+3161' }, text: 'x' })).data.error_code).toBe('invalid_recipient');
  });

  it('marks the session expired on a 401 and then refuses writes', async () => {
    await world();
    h.li.on('POST', /2-JANE\/events/, () => new Response('', { status: 401 }));
    expect((await h.call('send_message', { to: { contact_id: '2-JANE' }, text: 'x' })).data.error_code).toBe('session_expired');
    expect((await h.call('get_linkedin_status')).data.status).toBe('disconnected');
    expect((await h.call('send_message', { to: { contact_id: '2-JANE' }, text: 'x' })).data.error_code).toBe('session_expired');
  });

  it('pauses writes for 48 h after a security check', async () => {
    await world();
    h.li.on('POST', /2-JANE\/events/, () => new Response('', { status: 302, headers: { location: 'https://www.linkedin.com/checkpoint/challenge/x' } }));
    expect((await h.call('send_message', { to: { contact_id: '2-JANE' }, text: 'x' })).data.error_code).toBe('security_challenge');
    expect((await h.call('get_linkedin_status')).data.status).toBe('restricted');
    const again = await h.call('connect_with_person', { linkedin_username: 'bob-lee' });
    expect(again.data).toMatchObject({ error_code: 'security_challenge', retry_after_s: 48 * 3600 });
    expect((await h.call('list_chats')).isError).toBe(false);
  });
});

describe('people and invitations', () => {
  it('connect_with_person refuses at the daily cap with retry_after_s to midnight', async () => {
    await world();
    const day = localDay(h.clock.now(), TZ);
    for (let i = 0; i < 20; i++) h.store.recordAction('invite', NOW, day, `p${i}`);
    const r = await h.call('connect_with_person', { linkedin_username: 'carl-x', note: 'Hi Carl' });
    expect(r.data).toMatchObject({ error_code: 'daily_invite_cap', retry_after_s: 14 * 3600 });
    expect(h.li.posts(/verifyQuota/)).toHaveLength(0);
  });

  it('connect_with_person sends, counts and spaces requests 5 to 8 minutes apart', async () => {
    await world();
    expect((await h.call('connect_with_person', { linkedin_username: 'carl-x', note: 'see example.com' })).data.error_code).toBe('link_not_allowed');
    const r = await h.call('connect_with_person', { linkedin_username: 'carl-x', note: 'Hi Carl, enjoyed your talk' });
    expect(r.data).toEqual({ status: 'sent', invitation_id: '9001' });
    expect((await h.call('get_usage')).data.linkedin.invites).toBe(1);
    expect((await h.call('connect_with_person', { linkedin_username: 'bob-lee' })).data).toEqual({ status: 'already_connected' });
    h.store.upsertContact({ id: 'ACoBOB', username: 'bob-lee', name: 'Bob Lee', headline: null, distance: 2, thread_id: null });
    h.clock.t += 60_000;
    const next = await h.call('connect_with_person', { linkedin_username: 'bob-lee' });
    expect(next.data).toMatchObject({ error_code: 'rate_limited', retry_after_s: 240 });
  });

  it('get_person_profile counts a profile view and returns the degree', async () => {
    await world();
    const r = await h.call('get_person_profile', { profile_url: 'https://www.linkedin.com/in/jane-doe/' });
    expect(r.data).toMatchObject({ linkedin_username: 'jane-doe', name: 'Jane Doe', connection_degree: 1 });
    expect(r.data.urn_id).toBeUndefined();
    expect((await h.call('get_usage')).data.linkedin.profile_views).toBe(1);
  });

  it('search_people counts a search and stops at the cap', async () => {
    await world();
    const r = await h.call('search_people', { keywords: 'head of sales', limit: 5 });
    expect(r.data.people.map((p: any) => p.linkedin_username)).toEqual(['jane-doe', 'bob-lee']);
    const day = localDay(h.clock.now(), TZ);
    for (let i = 0; i < 29; i++) h.store.recordAction('search', NOW, day, 'x');
    expect((await h.call('search_people', { keywords: 'cto' })).data.error_code).toBe('daily_read_cap');
  });

  it('lists and accepts a received invitation', async () => {
    await world();
    const l = await h.call('list_invitations', { direction: 'received' });
    expect(l.data.invitations).toEqual([{ id: '7001', direction: 'received', linkedin_username: 'carl-x', name: 'Carl Xu', sent_at: '2026-03-09T12:00:00.000Z', note: 'Hi Sam, met you at the meetup.' }]);
    const a = await h.call('accept_invitation', { invitation_id: '7001' });
    expect(a.data).toEqual({ accepted: true });
    expect(h.li.posts(/invitations\/7001/)[0].body).toEqual({ invitationId: '7001', invitationSharedSecret: 'secret-7001', isGenericInvitation: false });
    expect((await h.call('get_usage')).data.linkedin.accepts).toBe(1);
  });

  it('get_my_profile reads your own profile', async () => {
    await world();
    expect((await h.call('get_my_profile')).data).toMatchObject({ linkedin_username: 'me-self', name: 'Sam Self' });
  });
});

describe('reading', () => {
  it('list_chats returns the inbox, list_messages reads and stores a thread', async () => {
    await world();
    const c = await h.call('list_chats');
    expect(c.data.chats.map((x: any) => x.chat_id)).toEqual(['2-JANE', '2-DANA']);
    expect(c.data.chats[0]).toMatchObject({ name: 'Jane Doe', type: 'user', unread_count: 1 });
    const m = await h.call('list_messages', { chat_id: '2-JANE' });
    expect(m.data.messages.map((x: any) => [x.id, x.direction])).toEqual([
      ['5-J2', 'inbound'],
      ['5-J1', 'outbound'],
    ]);
    const page = await h.call('list_messages', { limit: 1 });
    expect(page.data.messages).toHaveLength(1);
    const next = await h.call('list_messages', { limit: 1, before: page.data.next_cursor });
    expect(next.data.messages[0].id).not.toBe(page.data.messages[0].id);
  });

  it('search_messages uses full text search over the store', async () => {
    await world();
    await h.call('list_messages', { chat_id: '2-JANE' });
    const r = await h.call('search_messages', { query: 'pricing' });
    expect(r.data.messages.map((x: any) => x.id).sort()).toEqual(['5-J1', '5-J2']);
    expect((await h.call('search_messages', { query: 'details', chat_id: '2-DANA' })).data.messages).toHaveLength(0);
    expect((await h.call('search_messages', { query: '"unbalanced (' })).isError).toBe(false);
  });

  it('wait_for_messages returns a new inbound event in arrival order with a cursor', async () => {
    await world();
    const first = await h.call('wait_for_messages', { timeout_s: 0 });
    expect(first.data.messages).toEqual([]);
    const cursor = first.data.cursor;
    h.clock.onSleep = () => {
      const t = h.clock.t;
      h.li.on('GET', /^\/messaging\/conversations\?keyVersion=LEGACY_INBOX$/, {
        elements: [fx.conversation('2-DANA', fx.people.dana, { unread: 1, lastActivityAt: t, events: [fx.event('2-DANA', '5-D2', fx.people.dana, 'Sorry for the delay, yes interested', t)] })],
      });
      h.clock.onSleep = null;
    };
    const r = await h.call('wait_for_messages', { cursor, timeout_s: 30 });
    expect(r.data.messages.map((x: any) => [x.id, x.direction, x.text])).toEqual([['5-D2', 'inbound', 'Sorry for the delay, yes interested']]);
    expect(h.clock.sleeps).toContain(15_000);
    const again = await h.call('wait_for_messages', { cursor: r.data.cursor, timeout_s: 0 });
    expect(again.data.messages).toEqual([]);
  });

  it('mark_read marks the thread seen on LinkedIn', async () => {
    await world();
    expect((await h.call('mark_read', { chat_id: '2-JANE' })).data).toEqual({ marked: true });
    expect(h.li.posts(/^\/messaging\/conversations\/2-JANE$/)[0].body).toEqual({ patch: { $set: { read: true } } });
  });
});
