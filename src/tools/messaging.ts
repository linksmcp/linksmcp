import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveUsername } from '../linkedin/ids.js';
import { createThread, findConversationWith, markSeen, sendInThread } from '../linkedin/messaging.js';
import type { ThreadState } from '../safety.js';
import { decodeCursor, encodeCursor } from '../store.js';
import { ToolError } from '../wire.js';
import { chatNotFound, json, wrap, type ToolContext, type ToolDef } from './types.js';

const accountId = z.string().optional().describe('Account id from list_accounts. Optional: this server has one account, "local".');
const RECIPIENT_KEYS = ['linkedin_username', 'profile_url', 'contact_id'] as const;
const WAIT_SLACK_MS = 120_000;

export function messagingTools(ctx: ToolContext): ToolDef[] {
  const { door } = ctx;
  const { store } = door;
  const maxWait = Math.min(55, ctx.maxWaitS ?? 55);
  const pollMs = (ctx.pollIntervalS ?? 15) * 1000;

  const threadState = (chatId: string): ThreadState => {
    const last = store.lastInChat(chatId);
    return { theyWrote: store.hasInbound(chatId), last: last ? { direction: last.direction, at: new Date(last.ts) } : null };
  };

  const parseRecipient = (to: unknown): Partial<Record<(typeof RECIPIENT_KEYS)[number], string>> => {
    if (!to || typeof to !== 'object' || Array.isArray(to)) throw new ToolError('invalid_recipient', 'to must be one recipient object, not a list.');
    const o = to as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !(RECIPIENT_KEYS as readonly string[]).includes(k));
    if (extra.length) throw new ToolError('invalid_recipient', `Unknown recipient field ${extra.join(', ')}. Use exactly one of linkedin_username, profile_url or contact_id.`);
    const given = RECIPIENT_KEYS.filter((k) => typeof o[k] === 'string' && (o[k] as string).trim() !== '');
    if (given.length !== 1) throw new ToolError('invalid_recipient', 'to takes exactly one of linkedin_username, profile_url or contact_id.');
    for (const k of RECIPIENT_KEYS) if (o[k] !== undefined && typeof o[k] !== 'string') throw new ToolError('invalid_recipient', `${k} must be a string.`);
    return { [given[0]]: (o[given[0]] as string).trim() };
  };

  return [
    {
      name: 'send_message',
      title: 'Send a message',
      description:
        'Send one LinkedIn message to ONE recipient: to.contact_id (a chat_id from list_chats or a message) posts into that thread; ' +
        'to.linkedin_username or to.profile_url uses your existing thread with that person or opens a new one (first degree connections only). ' +
        'Text only: attachments are not supported. Daily limits, working hours, pacing and the link rule apply; a refusal sends nothing and returns error_code.',
      inputSchema: {
        account_id: accountId,
        to: z
          .looseObject({
            linkedin_username: z.string().optional().describe('Public id from the profile URL.'),
            profile_url: z.string().optional().describe('https://www.linkedin.com/in/...'),
            contact_id: z.string().optional().describe('A chat id from list_chats or a message.'),
          })
          .describe('One recipient object: exactly one of linkedin_username, profile_url, contact_id.'),
        text: z.string().max(4096).optional().describe('The message text.'),
        media_url: z.string().optional().describe('Not supported on LinkedIn in this version; returns media_unavailable.'),
        reply_to: z.string().optional().describe('Message id this answers. LinkedIn has no quoted replies here, so the text is posted in the same thread.'),
        media_path: z.string().optional().describe('Not supported on LinkedIn in this version; returns media_unavailable.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      handler: wrap(async ({ account_id, to, text, media_url, media_path, reply_to }) => {
        door.checkAccountId(account_id);
        if (media_url || media_path) throw new ToolError('media_unavailable', 'Attachments are not supported on LinkedIn in this version. Send text only.');
        const recipient = parseRecipient(to);
        const body = typeof text === 'string' ? text.trim() : '';
        if (!body) throw new ToolError('send_failed', 'text is required.');
        if (reply_to && !store.getMessage(reply_to)) throw new ToolError('message_not_found', `No message with id ${reply_to}.`);

        door.precheckWrite({ kind: 'message' });

        let threadId: string | null = null;
        let member: { id: string; username: string | null; name: string | null } | null = null;
        if (recipient.contact_id) {
          const chat = store.getChat(recipient.contact_id);
          if (!chat) throw new ToolError('contact_not_found', `No chat with id ${recipient.contact_id}. Use list_chats to find one.`);
          threadId = chat.id;
        } else {
          const username = resolveUsername(recipient);
          let person = await door.person(username);
          if (person.id === store.account().urn_id) throw new ToolError('invalid_recipient', 'That is your own profile.');
          const known = store.chatWith(person.id) ?? (person.thread_id ? store.getChat(person.thread_id) : undefined);
          if (known) threadId = known.id;
          else {
            const c = await door.client();
            const conv = await door.guard(() => findConversationWith(c, person.id));
            if (conv) {
              door.storeConversation(conv);
              threadId = conv.thread_id;
            }
          }
          if (!threadId) {
            if (person.distance === null) person = await door.person(username, { needDistance: true });
            if (person.distance !== 1) {
              throw new ToolError('needs_connection_first', `${person.name ?? username} is not a first degree connection. Send a connection request with connect_with_person first.`);
            }
          }
          member = { id: person.id, username: person.username, name: person.name };
        }

        if (threadId) {
          const id = threadId;
          try {
            await door.syncThread(id);
          } catch (err) {
            throw chatNotFound(err, id);
          }
        }
        const isNew = !threadId;
        await door.gateWrite({ kind: 'message', newThread: isNew, text: body, thread: threadId ? threadState(threadId) : { theyWrote: false, last: null } });

        const c = await door.client();
        const result = await door.guard(() => (threadId ? sendInThread(c, threadId, body) : createThread(c, member!.id, body)));
        const chatId = result.thread_id ?? threadId ?? `pending-${member!.id}`;
        door.recordWrite('message', isNew ? ['new_thread'] : [], chatId);
        const now = door.now().getTime();
        if (isNew && member) {
          store.upsertChat({
            id: chatId,
            name: member.name,
            type: 'user',
            unread_count: 0,
            last_message_at: result.created_at ?? now,
            participant_id: member.id,
            participant_username: member.username,
            participant_name: member.name,
            raw: null,
          });
          store.upsertContact({ id: member.id, username: member.username, name: member.name, headline: null, distance: 1, thread_id: chatId, updated_at: now });
        }
        const own = store.account();
        const messageId = result.event_id ?? `local-${randomUUID()}`;
        store.upsertMessage({
          id: messageId,
          chat_id: chatId,
          direction: 'outbound',
          text: body,
          status: 'sent',
          ts: result.created_at ?? now,
          sender_id: own.urn_id,
          sender_username: own.identifier,
          sender_name: own.name,
          raw: null,
        });
        return json({ message_id: messageId, status: 'sent', chat_id: chatId });
      }),
    },
    {
      name: 'get_message',
      title: 'Get a message',
      description: 'Get one stored message by id (from list_messages, wait_for_messages or send_message).',
      inputSchema: { id: z.string().describe('Message id.') },
      annotations: { readOnlyHint: true },
      handler: wrap(async ({ id }) => {
        const m = store.getMessage(id);
        if (!m) throw new ToolError('message_not_found', `No message with id ${id}.`);
        return json(door.toWireMessage(m));
      }),
    },
    {
      name: 'list_messages',
      title: 'List messages',
      description:
        'List messages, newest first. With chat_id the thread is read from LinkedIn first and stored; without chat_id it lists what is stored on this machine. ' +
        'Pass next_cursor as before for the next page.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('1 to 100, default 50.'),
        direction: z.enum(['inbound', 'outbound']).optional(),
        account_id: accountId,
        before: z.string().optional().describe('Cursor from next_cursor.'),
        chat_id: z.string().optional().describe('A chat id from list_chats.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: wrap(async ({ limit, direction, account_id, before, chat_id }) => {
        door.checkAccountId(account_id);
        const n = limit ?? 50;
        if (chat_id && !before) {
          try {
            await door.syncThread(chat_id);
          } catch (err) {
            throw chatNotFound(err, chat_id);
          }
        }
        const rows = store.listMessages({ chatId: chat_id, direction, before: decodeCursor(before), limit: n });
        const last = rows[rows.length - 1];
        return json({ messages: rows.map((r) => door.toWireMessage(r)), next_cursor: rows.length === n && last ? encodeCursor({ seq: last.seq, ts: last.ts }) : null });
      }),
    },
    {
      name: 'wait_for_messages',
      title: 'Wait for new messages',
      description:
        'Long poll for new inbound LinkedIn messages. Checks the inbox every 15 s until a message arrives or timeout_s passes (default 25, max 55). ' +
        'Without a cursor it starts from now. Pass the returned cursor to the next call so nothing is missed.',
      inputSchema: {
        cursor: z.string().optional(),
        account_id: accountId,
        timeout_s: z.number().int().min(0).max(55).optional().describe('0 to 55 seconds, default 25.'),
        chat_id: z.string().optional().describe('Only wait for this chat.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: wrap(async ({ cursor, account_id, timeout_s, chat_id }) => {
        door.checkAccountId(account_id);
        const start = door.now().getTime();
        const given = decodeCursor(cursor);
        const cur = given ?? { seq: store.maxSeq(), ts: start };
        // A cursor allows for LinkedIn's clock and inbox lag; without one, only messages sent from now on count.
        const minTs = given ? cur.ts - WAIT_SLACK_MS : start;
        const deadline = start + Math.min(maxWait, Math.max(0, timeout_s ?? 25)) * 1000;
        const found = () => store.inboundAfter({ seq: cur.seq, minTs, chatId: chat_id, limit: 100 });
        const done = (rows: ReturnType<typeof found>) =>
          json({
            messages: rows.map((r) => door.toWireMessage(r)),
            cursor: encodeCursor({ seq: rows.length ? rows[rows.length - 1].seq : Math.max(cur.seq, store.maxSeq()), ts: door.now().getTime() }),
          });

        let rows = found();
        if (rows.length) return done(rows);
        for (;;) {
          if (chat_id) {
            try {
              await door.syncThread(chat_id);
            } catch (err) {
              throw chatNotFound(err, chat_id);
            }
          } else {
            const convs = await door.syncInbox();
            // The inbox carries the newest event per thread; read a thread fully only when it has more unread than that.
            for (const conv of convs) {
              const newest = conv.events[conv.events.length - 1];
              if (conv.unread_count > 1 && newest && newest.created_at >= minTs) await door.syncThread(conv.thread_id);
            }
          }
          rows = found();
          if (rows.length) return done(rows);
          const left = deadline - door.now().getTime();
          if (left <= 0) return done([]);
          await door.sleep(Math.min(pollMs, left));
          if (door.now().getTime() >= deadline) {
            rows = found();
            return done(rows);
          }
        }
      }),
    },
    {
      name: 'list_chats',
      title: 'List chats',
      description: 'List LinkedIn threads, most recent first: reads the inbox from LinkedIn and stores it. type user = 1:1, group = group threads.',
      inputSchema: {
        account_id: accountId,
        query: z.string().optional().describe('Filter by name or public id.'),
        limit: z.number().int().min(1).max(200).optional().describe('1 to 200, default 50.'),
        type: z.enum(['user', 'group', 'channel']).optional().describe('LinkedIn has no channels; channel returns an empty list.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: wrap(async ({ account_id, query, limit, type }) => {
        door.checkAccountId(account_id);
        if (type === 'channel') return json({ chats: [] });
        await door.syncInbox();
        const rows = store.listChats({ query: query?.trim() || undefined, type, limit: limit ?? 50 });
        return json({ chats: rows.map((r) => door.toWireChat(r)) });
      }),
    },
    {
      name: 'search_messages',
      title: 'Search messages',
      description: 'Full text search over the messages stored on this machine (every thread read with list_chats, list_messages or wait_for_messages).',
      inputSchema: {
        query: z.string().describe('Words to find.'),
        account_id: accountId,
        chat_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().describe('1 to 100, default 20.'),
      },
      annotations: { readOnlyHint: true },
      handler: wrap(async ({ query, account_id, chat_id, limit }) => {
        door.checkAccountId(account_id);
        const rows = store.search({ query, chatId: chat_id, limit: limit ?? 20 });
        return json({ messages: rows.map((r) => door.toWireMessage(r)) });
      }),
    },
    {
      name: 'mark_read',
      title: 'Mark a chat as read',
      description: 'Mark a LinkedIn thread as read.',
      inputSchema: { chat_id: z.string(), account_id: accountId },
      annotations: { idempotentHint: true, openWorldHint: true },
      handler: wrap(async ({ chat_id, account_id }) => {
        door.checkAccountId(account_id);
        const c = await door.client();
        try {
          await door.guard(() => markSeen(c, chat_id));
        } catch (err) {
          throw chatNotFound(err, chat_id);
        }
        store.setUnread(chat_id, 0);
        return json({ marked: true });
      }),
    },
  ];
}
