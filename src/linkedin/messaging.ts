import { randomBytes, randomUUID } from 'node:crypto';
import type { LinkedInClient } from './client.js';
import { Graph, fullName, num, str, textOf, unwrap, urnId, type Obj } from './normalize.js';

export interface Person {
  urn_id: string | null;
  linkedin_username: string | null;
  name: string | null;
}

export interface LiEvent {
  id: string;
  thread_id: string;
  created_at: number;
  from: Person | null;
  text: string;
}

export interface LiConversation {
  thread_id: string;
  name: string | null;
  group: boolean;
  unread_count: number;
  last_activity_at: number | null;
  participants: Person[];
  events: LiEvent[];
}

/** urn:li:fs_conversation:2-abc -> 2-abc; urn:li:fs_event:(2-abc,5-def) -> {thread 2-abc, event 5-def}. */
export function threadIdOf(urn: unknown): string | undefined {
  if (typeof urn !== 'string') return undefined;
  const ev = /^urn:li:[^:]*(?:event|message)[^:]*:\(([^,]+),([^)]+)\)$/i.exec(urn);
  if (ev) return ev[1];
  const m = /^urn:li:[^:]*conversation[^:]*:(.+)$/i.exec(urn);
  if (m) return m[1].replace(/^\(|\)$/g, '');
  return undefined;
}

export function eventIdOf(urn: unknown): string | undefined {
  if (typeof urn !== 'string') return undefined;
  const ev = /^urn:li:[^:]+:\(([^,]+),([^)]+)\)$/.exec(urn);
  if (ev) return ev[2];
  return urnId(urn);
}

export function memberOf(g: Graph, raw: any): Person | null {
  const m = unwrap(raw);
  if (!m) return null;
  const mini: Obj = g.get(m, 'miniProfile') ?? m;
  const p: Person = {
    urn_id: urnId(mini.entityUrn) ?? null,
    linkedin_username: str(mini.publicIdentifier) ?? null,
    name: fullName(mini.firstName, mini.lastName) ?? null,
  };
  return p.urn_id || p.linkedin_username ? p : null;
}

export function parseEvent(g: Graph, e: Obj, fallbackThread?: string): LiEvent | null {
  const content = unwrap(g.get(e, 'eventContent'));
  if (!content) return null;
  const text = textOf(content.attributedBody) ?? str(content.body) ?? (content.attributedBody || content.body !== undefined ? '' : undefined);
  if (text === undefined) return null;
  const thread = threadIdOf(e.entityUrn) ?? fallbackThread;
  const id = eventIdOf(e.entityUrn) ?? str(e.dashEntityUrn) ?? str(e.backendUrn);
  if (!thread || !id) return null;
  return { id, thread_id: thread, created_at: num(e.createdAt) ?? 0, from: memberOf(g, g.get(e, 'from')), text };
}

function parseConversation(g: Graph, c: Obj): LiConversation | null {
  const thread = threadIdOf(c.entityUrn);
  if (!thread) return null;
  const parts = g.get(c, 'participants');
  const events = g.get(c, 'events');
  return {
    thread_id: thread,
    name: str(c.name) ?? null,
    group: c.groupChat === true,
    unread_count: num(c.unreadCount) ?? (c.read === false ? 1 : 0),
    last_activity_at: num(c.lastActivityAt) ?? null,
    participants: (Array.isArray(parts) ? parts : []).map((p) => memberOf(g, p)).filter((p): p is Person => !!p),
    events: (Array.isArray(events) ? events : []).map((e: Obj) => parseEvent(g, e, thread)).filter((e): e is LiEvent => !!e),
  };
}

/** Parses /messaging/conversations. */
export function parseConversations(json: unknown): LiConversation[] {
  const g = new Graph(json);
  let list = g.elements();
  if (!list.length) list = g.ofType('.messaging.Conversation');
  return list.map((c) => parseConversation(g, c)).filter((c): c is LiConversation => !!c);
}

/** Parses /messaging/conversations/{id}/events, oldest first. */
export function parseEvents(json: unknown, threadId: string): LiEvent[] {
  const g = new Graph(json);
  let list = g.elements();
  if (!list.length) list = g.ofType('.messaging.Event');
  return list
    .map((e) => parseEvent(g, e, threadId))
    .filter((e): e is LiEvent => !!e)
    .sort((a, b) => a.created_at - b.created_at);
}

export interface SendResult {
  event_id: string | null;
  thread_id: string | null;
  created_at: number | null;
}

export function parseSendResult(json: unknown, fallbackThread?: string): SendResult {
  const g = new Graph(json);
  const v: Obj = g.get(g.root, 'value') ?? g.root ?? {};
  return {
    event_id: eventIdOf(v.eventUrn) ?? null,
    thread_id: threadIdOf(v.conversationUrn) ?? threadIdOf(v.eventUrn) ?? fallbackThread ?? null,
    created_at: num(v.createdAt) ?? null,
  };
}

function trackingId(): string {
  return String.fromCharCode(...randomBytes(16));
}

function messageEvent(text: string): Obj {
  return {
    eventCreate: {
      originToken: randomUUID(),
      value: {
        'com.linkedin.voyager.messaging.create.MessageCreate': {
          attributedBody: { text, attributes: [] },
          attachments: [],
        },
      },
      trackingId: trackingId(),
    },
    dedupeByClientGeneratedToken: false,
  };
}

const enc = encodeURIComponent;

export async function listConversations(c: LinkedInClient): Promise<LiConversation[]> {
  return parseConversations(await c.request('/messaging/conversations', { query: 'keyVersion=LEGACY_INBOX' }));
}

export async function getEvents(c: LinkedInClient, threadId: string): Promise<LiEvent[]> {
  return parseEvents(await c.request(`/messaging/conversations/${enc(threadId)}/events`), threadId);
}

/** The existing 1:1 thread with a member, if any. */
export async function findConversationWith(c: LinkedInClient, memberUrnId: string): Promise<LiConversation | null> {
  const json = await c.request('/messaging/conversations', {
    query: `keyVersion=LEGACY_INBOX&q=participants&recipients=List(${enc(memberUrnId)})`,
  });
  return parseConversations(json).find((x) => !x.group) ?? null;
}

export async function sendInThread(c: LinkedInClient, threadId: string, text: string): Promise<SendResult> {
  const json = await c.request(`/messaging/conversations/${enc(threadId)}/events`, { method: 'POST', query: 'action=create', body: messageEvent(text) });
  return parseSendResult(json, threadId);
}

export async function createThread(c: LinkedInClient, memberUrnId: string, text: string): Promise<SendResult> {
  const create = { ...messageEvent(text), recipients: [memberUrnId], subtype: 'MEMBER_TO_MEMBER' };
  const json = await c.request('/messaging/conversations', {
    method: 'POST',
    query: 'action=create',
    body: { keyVersion: 'LEGACY_INBOX', conversationCreate: create },
  });
  return parseSendResult(json);
}

export async function markSeen(c: LinkedInClient, threadId: string): Promise<void> {
  await c.request(`/messaging/conversations/${enc(threadId)}`, { method: 'POST', body: { patch: { $set: { read: true } } } });
}
