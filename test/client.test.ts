import { describe, expect, it } from 'vitest';
import { fetchJsessionid, jsessionFromSetCookie, LinkedInClient, mapError } from '../src/linkedin/client.js';
import { resolveUsername, usernameFromUrl } from '../src/linkedin/ids.js';
import { parseInviteResult, parseInvitations, sendInvitation } from '../src/linkedin/invitations.js';
import { parseConversations, parseEvents, parseSendResult } from '../src/linkedin/messaging.js';
import { parseDistance, parseMe, parseProfileView } from '../src/linkedin/profile.js';
import { buildSearchQuery, parseSearch, searchPeople } from '../src/linkedin/search.js';
import { ToolError } from '../src/wire.js';
import * as fx from './fixtures.js';
import { FakeLinkedIn, jsonResponse } from './helpers.js';

const client = (li: FakeLinkedIn) => new LinkedInClient({ liAt: 'AQEDcookie', jsessionid: 'ajax:42' }, li.fetch);

async function codeOf(p: Promise<unknown>): Promise<{ code: string; retry?: number }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return { code: e.code, retry: e.retryAfterS };
    throw e;
  }
  throw new Error('expected a ToolError');
}

describe('requests', () => {
  it('sends the session cookie, csrf token and LinkedIn headers', async () => {
    const li = new FakeLinkedIn().on('GET', /^\/me$/, fx.me);
    await client(li).request('/me');
    const h = li.calls[0].headers;
    expect(li.calls[0].url).toBe('https://www.linkedin.com/voyager/api/me');
    expect(h.cookie).toBe('li_at=AQEDcookie; JSESSIONID="ajax:42"');
    expect(h['csrf-token']).toBe('ajax:42');
    expect(h['x-restli-protocol-version']).toBe('2.0.0');
    expect(h['x-li-lang']).toBe('en_US');
    expect(h.accept).toBe('application/vnd.linkedin.normalized+json+2.1');
    expect(h['user-agent']).toMatch(/Chrome\/\d+/);
  });

  it('gets JSESSIONID from the feed when only li_at is known', async () => {
    const li = new FakeLinkedIn().on('GET', /^\/feed\//, () => new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID="ajax:777"; Path=/; Secure' } }));
    expect(await fetchJsessionid('AQED', li.fetch)).toBe('ajax:777');
    expect(li.calls[0].url).toBe('https://www.linkedin.com/feed/');
    expect(li.calls[0].headers.cookie).toBe('li_at=AQED');
  });

  it('asks for jsessionid when LinkedIn does not hand one out', async () => {
    const li = new FakeLinkedIn().on('GET', /^\/feed\//, () => new Response('', { status: 200 }));
    const err = await fetchJsessionid('AQED', li.fetch).catch((e) => e);
    expect(err.code).toBe('no_connected_account');
    expect(err.message).toMatch(/jsessionid/);
  });

  it('reports a dead cookie when the feed redirects to the login page', async () => {
    const li = new FakeLinkedIn().on('GET', /^\/feed\//, () => new Response('', { status: 302, headers: { location: 'https://www.linkedin.com/uas/login?session_redirect=feed' } }));
    expect((await codeOf(fetchJsessionid('AQED', li.fetch))).code).toBe('session_expired');
  });

  it('parses JSESSIONID with or without quotes', () => {
    expect(jsessionFromSetCookie(['lang=v=2', 'JSESSIONID=ajax:1; Path=/'])).toBe('ajax:1');
    expect(jsessionFromSetCookie(['JSESSIONID="ajax:2"'])).toBe('ajax:2');
    expect(jsessionFromSetCookie(['bcookie=x'])).toBeNull();
  });
});

describe('error mapping', () => {
  const resp = (status: number, headers: Record<string, string> = {}, body = '') => new Response(body, { status, headers });
  it.each([
    [401, {}, '', 'session_expired'],
    [403, {}, '', 'session_expired'],
    [403, {}, 'CSRF check failed', 'session_expired'],
    [403, {}, '{"message":"Not allowed for this member"}', 'send_failed'],
    [403, {}, '{"message":"This account is restricted"}', 'account_suspended'],
    [302, { location: 'https://www.linkedin.com/checkpoint/challenge/AgH' }, '', 'security_challenge'],
    [302, { location: 'https://www.linkedin.com/login?trk=x' }, '', 'session_expired'],
    [303, { location: 'https://www.linkedin.com/authwall' }, '', 'session_expired'],
    [500, {}, '', 'send_failed'],
    [503, {}, '', 'send_failed'],
  ])('%s -> %s', async (status, headers, body, want) => {
    const err = await mapError(resp(status as number, headers as Record<string, string>, body as string));
    expect(err.code).toBe(want);
  });

  it('maps HTTP 999 to security_challenge', async () => {
    const r = new Response('', { status: 200 });
    Object.defineProperty(r, 'status', { value: 999 });
    expect((await mapError(r)).code).toBe('security_challenge');
  });

  it('maps 429 to rate_limited with retry-after or 900 s', async () => {
    const a = await mapError(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    expect([a.code, a.retryAfterS]).toEqual(['rate_limited', 120]);
    const b = await mapError(new Response('', { status: 429 }));
    expect([b.code, b.retryAfterS]).toEqual(['rate_limited', 900]);
  });

  it('applies the mapping to API calls', async () => {
    const li = new FakeLinkedIn().on('GET', /^\/me$/, () => new Response('', { status: 401 }));
    expect((await codeOf(client(li).request('/me'))).code).toBe('session_expired');
  });
});

describe('parsers', () => {
  it('profileView', () => {
    const p = parseProfileView(fx.profileView(fx.people.jane), 'jane-doe');
    expect(p).toMatchObject({
      linkedin_username: 'jane-doe',
      profile_url: 'https://www.linkedin.com/in/jane-doe/',
      name: 'Jane Doe',
      headline: 'Head of Sales at Acme',
      location: 'Amsterdam, North Holland',
      about: 'About Jane.',
      urn_id: 'ACoJANE',
    });
    expect(p.experience[0]).toEqual({ title: 'Head of Sales', company: 'Acme', location: 'Amsterdam', start: '2021-03', description: 'Sales.' });
    expect(p.experience[1]).toEqual({ title: 'Account Executive', company: 'Initech', start: '2017', end: '2021-02' });
    expect(p.education[0]).toEqual({ school: 'University of Amsterdam', degree: 'MSc', field_of_study: 'Economics', start: '2012', end: '2016' });
  });

  it('profileView with missing fields', () => {
    const p = parseProfileView({}, 'ghost');
    expect(p).toMatchObject({ linkedin_username: 'ghost', name: null, experience: [], education: [], urn_id: null });
  });

  it('/me', () => {
    expect(parseMe(fx.me)).toEqual({ linkedin_username: 'me-self', name: 'Sam Self', headline: 'Founder', urn_id: 'ACoSELF', plain_id: '1234' });
    expect(parseMe({})).toMatchObject({ linkedin_username: null, urn_id: null });
  });

  it('network distance', () => {
    expect(parseDistance(fx.networkinfo('DISTANCE_1'))).toBe(1);
    expect(parseDistance(fx.networkinfo('OUT_OF_NETWORK'))).toBe(3);
    expect(parseDistance({ distance: { value: 'DISTANCE_2' } })).toBe(2);
    expect(parseDistance({})).toBeNull();
  });

  it('search, normalized shape: skips members without a public profile', () => {
    expect(parseSearch(fx.search)).toEqual([
      { linkedin_username: 'jane-doe', profile_url: 'https://www.linkedin.com/in/jane-doe/', name: 'Jane Doe', headline: 'Head of Sales at Acme', location: 'Amsterdam' },
      { linkedin_username: 'bob-lee', profile_url: 'https://www.linkedin.com/in/bob-lee/', name: 'Bob Lee', headline: 'CTO', location: null },
    ]);
  });

  it('search, plain nested shape', () => {
    expect(parseSearch(fx.searchPlain)).toEqual([{ linkedin_username: 'carl-x', profile_url: 'https://www.linkedin.com/in/carl-x/', name: 'Carl Xu', headline: null, location: 'Berlin' }]);
  });

  it('search query: rest.li escaping, id filters, text folded into keywords', () => {
    const q = buildSearchQuery({ keywords: 'sales (EMEA)', location: '102890719', current_company: 'Acme, Inc' }, 'voyagerSearchDashClusters.abc');
    expect(q).toContain('keywords:sales%20%28EMEA%29%20Acme%2C%20Inc,');
    expect(q).toContain('(key:geoUrn,value:List(102890719))');
    expect(q).toContain('(key:resultType,value:List(PEOPLE))');
    expect(q).toContain('&queryId=voyagerSearchDashClusters.abc');
    expect(q.startsWith('variables=(start:0,origin:GLOBAL_SEARCH_HEADER,')).toBe(true);
  });

  it('search request uses the graphql endpoint and limits the page', async () => {
    const li = new FakeLinkedIn().on('GET', /^\/graphql\?/, fx.search);
    const out = await searchPeople(client(li), { keywords: 'sales', limit: 1 }, 'q.1');
    expect(out.people).toHaveLength(1);
    expect(out.next_start).toBe(1);
    expect(li.calls[0].path).toMatch(/^\/graphql\?variables=\(start:0,/);
  });

  it('conversations and events', () => {
    const conv = parseConversations({
      elements: [fx.conversation('2-JANE', fx.people.jane, { unread: 1, lastActivityAt: 1000, events: [fx.event('2-JANE', '5-A', fx.people.jane, 'Hello', 1000)] })],
    });
    expect(conv[0]).toMatchObject({ thread_id: '2-JANE', group: false, unread_count: 1, last_activity_at: 1000 });
    expect(conv[0].participants[0]).toEqual({ urn_id: 'ACoJANE', linkedin_username: 'jane-doe', name: 'Jane Doe' });
    expect(conv[0].events[0]).toMatchObject({ id: '5-A', thread_id: '2-JANE', text: 'Hello', created_at: 1000 });

    const evs = parseEvents({ elements: [fx.event('2-JANE', '5-B', fx.people.self, 'second', 2000), fx.event('2-JANE', '5-A', fx.people.jane, 'first', 1000), { entityUrn: 'urn:li:fs_event:(2-JANE,5-C)', eventContent: {} }] }, '2-JANE');
    expect(evs.map((e) => e.id)).toEqual(['5-A', '5-B']);
  });

  it('send results in both shapes', () => {
    expect(parseSendResult(fx.sendEvent('2-JANE', '5-Z', 5000))).toEqual({ event_id: '5-Z', thread_id: '2-JANE', created_at: 5000 });
    expect(parseSendResult(fx.createConversation('2-NEW', '5-N', 6000))).toEqual({ event_id: '5-N', thread_id: '2-NEW', created_at: 6000 });
    expect(parseSendResult({}, '2-X')).toEqual({ event_id: null, thread_id: '2-X', created_at: null });
  });

  it('invitationViews', () => {
    expect(parseInvitations(fx.invitationViews, 'received')).toEqual([
      { id: '7001', direction: 'received', linkedin_username: 'carl-x', name: 'Carl Xu', sent_at: '2026-03-09T12:00:00.000Z', shared_secret: 'secret-7001', note: 'Hi Sam, met you at the meetup.' },
    ]);
  });

  it('verifyQuotaAndCreateV2: sent with id, or pending when one is already waiting', async () => {
    expect(parseInviteResult(fx.inviteCreated)).toBe('9001');
    const li = new FakeLinkedIn().on('POST', /verifyQuotaAndCreateV2/, fx.inviteCreated);
    expect(await sendInvitation(client(li), 'ACoBOB', 'Hi Bob')).toEqual({ status: 'sent', invitation_id: '9001' });
    expect(li.calls[0].body).toEqual({ invitee: { inviteeUnion: { memberProfile: 'urn:li:fsd_profile:ACoBOB' } }, customMessage: 'Hi Bob' });
    expect(li.calls[0].path).toContain('decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2');
    const li2 = new FakeLinkedIn().on('POST', /verifyQuotaAndCreateV2/, () => jsonResponse(fx.inviteCantResend, 400));
    expect(await sendInvitation(client(li2), 'ACoBOB', '')).toEqual({ status: 'pending' });
  });
});

describe('recipients', () => {
  it('reads the public id from a profile URL', () => {
    expect(usernameFromUrl('https://www.linkedin.com/in/jane-doe/')).toBe('jane-doe');
    expect(usernameFromUrl('linkedin.com/in/j%C3%B6rg?trk=x')).toBe('jörg');
    expect(usernameFromUrl('https://www.linkedin.com/company/acme')).toBeNull();
  });
  it('wants exactly one of username or URL', () => {
    expect(resolveUsername({ linkedin_username: 'jane-doe' })).toBe('jane-doe');
    expect(() => resolveUsername({})).toThrow(/exactly one/);
    expect(() => resolveUsername({ linkedin_username: 'a', profile_url: 'b' })).toThrow(/exactly one/);
    expect(() => resolveUsername({ profile_url: 'https://example.com/x' })).toThrow(/profile_url/);
  });
});
