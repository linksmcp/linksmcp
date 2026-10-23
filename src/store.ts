import Database from 'better-sqlite3';
import { chmodSync, existsSync } from 'node:fs';
import type { ActionKind, Counts } from './safety.js';
import { ZERO_COUNTS } from './safety.js';

export interface MessageRow {
  seq: number;
  id: string;
  chat_id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status: string;
  ts: number;
  sender_id: string | null;
  sender_username: string | null;
  sender_name: string | null;
  raw: string | null;
}

export interface ChatRow {
  id: string;
  name: string | null;
  type: 'user' | 'group';
  unread_count: number;
  last_message_at: number | null;
  participant_id: string | null;
  participant_username: string | null;
  participant_name: string | null;
  raw: string | null;
}

export interface ContactRow {
  id: string;
  username: string | null;
  name: string | null;
  headline: string | null;
  distance: number | null;
  thread_id: string | null;
  updated_at: number;
}

export interface AccountRow {
  status: string;
  restricted_until: number | null;
  restricted_reason: string | null;
  identifier: string | null;
  urn_id: string | null;
  name: string | null;
  connected_at: number | null;
  next_write_at: number | null;
  next_invite_at: number | null;
}

export interface InvitationRow {
  id: string;
  direction: string;
  shared_secret: string | null;
  username: string | null;
  name: string | null;
  sent_at: string | null;
  note: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sender_id TEXT,
  sender_username TEXT,
  sender_name TEXT,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT NOT NULL DEFAULT 'user',
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  participant_id TEXT,
  participant_username TEXT,
  participant_name TEXT,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS chats_participant ON chats(participant_id);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  username TEXT,
  name TEXT,
  headline TEXT,
  distance INTEGER,
  thread_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_username ON contacts(username COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  target TEXT
);
CREATE INDEX IF NOT EXISTS actions_day ON actions(day, kind);
CREATE TABLE IF NOT EXISTS account (
  k INTEGER PRIMARY KEY CHECK (k = 1),
  status TEXT NOT NULL DEFAULT 'disconnected',
  restricted_until INTEGER,
  restricted_reason TEXT,
  identifier TEXT,
  urn_id TEXT,
  name TEXT,
  connected_at INTEGER,
  next_write_at INTEGER,
  next_invite_at INTEGER
);
INSERT OR IGNORE INTO account (k) VALUES (1);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  shared_secret TEXT,
  username TEXT,
  name TEXT,
  sent_at TEXT,
  note TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, msg_id UNINDEXED, chat_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
`;

export interface Cursor {
  seq: number;
  ts: number;
}

/** Opaque cursor strings: base64url JSON. Bad input reads as null. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(s: string | undefined): Cursor | null {
  if (!s) return null;
  try {
    const o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof o.seq === 'number' && typeof o.ts === 'number') return { seq: o.seq, ts: o.ts };
  } catch {
    // fall through
  }
  return null;
}

/** Turns free text into an FTS5 query of quoted terms, so user input can never be a syntax error. */
export function ftsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return terms.join(' ');
}

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    const fresh = path !== ':memory:' && !existsSync(path);
    this.db = new Database(path);
    if (fresh) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // best effort
      }
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------- messages ----------

  /** Inserts or updates a message. Returns true when it was new. */
  upsertMessage(m: Omit<MessageRow, 'seq'>): boolean {
    const existing = this.db.prepare('SELECT seq, text FROM messages WHERE id = ?').get(m.id) as { seq: number; text: string } | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE messages SET text = ?, status = ?, ts = ?, sender_id = COALESCE(?, sender_id), sender_username = COALESCE(?, sender_username), sender_name = COALESCE(?, sender_name), raw = COALESCE(?, raw) WHERE id = ?')
        .run(m.text, m.status, m.ts, m.sender_id, m.sender_username, m.sender_name, m.raw, m.id);
      if (existing.text !== m.text) {
        this.db.prepare('DELETE FROM messages_fts WHERE msg_id = ?').run(m.id);
        this.db.prepare('INSERT INTO messages_fts (text, msg_id, chat_id) VALUES (?, ?, ?)').run(m.text, m.id, m.chat_id);
      }
      return false;
    }
    this.db
      .prepare('INSERT INTO messages (id, chat_id, direction, text, status, ts, sender_id, sender_username, sender_name, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.chat_id, m.direction, m.text, m.status, m.ts, m.sender_id, m.sender_username, m.sender_name, m.raw);
    this.db.prepare('INSERT INTO messages_fts (text, msg_id, chat_id) VALUES (?, ?, ?)').run(m.text, m.id, m.chat_id);
    return true;
  }

  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  /** Newest first. `before` is a cursor from a previous page. */
  listMessages(opts: { chatId?: string; direction?: string; before?: Cursor | null; limit: number }): MessageRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.chatId) {
      where.push('chat_id = ?');
      args.push(opts.chatId);
    }
    if (opts.direction) {
      where.push('direction = ?');
      args.push(opts.direction);
    }
    if (opts.before) {
      where.push('(ts < ? OR (ts = ? AND seq < ?))');
      args.push(opts.before.ts, opts.before.ts, opts.before.seq);
    }
    const sql = `SELECT * FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, seq DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, opts.limit) as MessageRow[];
  }

  /** Inbound messages stored after the cursor (seq), sent no earlier than `minTs`, in arrival order. */
  inboundAfter(opts: { seq: number; minTs: number; chatId?: string; limit: number }): MessageRow[] {
    const args: unknown[] = [opts.seq, opts.minTs];
    let sql = "SELECT * FROM messages WHERE direction = 'inbound' AND seq > ? AND ts >= ?";
    if (opts.chatId) {
      sql += ' AND chat_id = ?';
      args.push(opts.chatId);
    }
    sql += ' ORDER BY seq ASC LIMIT ?';
    return this.db.prepare(sql).all(...args, opts.limit) as MessageRow[];
  }

  maxSeq(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages').get() as { s: number };
    return r.s;
  }

  /** Newest message in a thread. */
  lastInChat(chatId: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, seq DESC LIMIT 1').get(chatId) as MessageRow | undefined;
  }

  hasInbound(chatId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND direction = 'inbound' LIMIT 1").get(chatId);
  }

  search(opts: { query: string; chatId?: string; limit: number }): MessageRow[] {
    const q = ftsQuery(opts.query);
    if (!q) return [];
    const args: unknown[] = [q];
    let sql = 'SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.msg_id WHERE messages_fts MATCH ?';
    if (opts.chatId) {
      sql += ' AND f.chat_id = ?';
      args.push(opts.chatId);
    }
    sql += ' ORDER BY m.ts DESC LIMIT ?';
    return this.db.prepare(sql).all(...args, opts.limit) as MessageRow[];
  }

  // ---------- chats ----------

  upsertChat(c: ChatRow): void {
    this.db
      .prepare(
        `INSERT INTO chats (id, name, type, unread_count, last_message_at, participant_id, participant_username, participant_name, raw)
         VALUES (@id, @name, @type, @unread_count, @last_message_at, @participant_id, @participant_username, @participant_name, @raw)
         ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, chats.name), type = excluded.type, unread_count = excluded.unread_count,
           last_message_at = MAX(COALESCE(excluded.last_message_at, 0), COALESCE(chats.last_message_at, 0)),
           participant_id = COALESCE(excluded.participant_id, chats.participant_id),
           participant_username = COALESCE(excluded.participant_username, chats.participant_username),
           participant_name = COALESCE(excluded.participant_name, chats.participant_name), raw = COALESCE(excluded.raw, chats.raw)`,
      )
      .run(c);
  }

  getChat(id: string): ChatRow | undefined {
    return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
  }

  chatWith(participantId: string): ChatRow | undefined {
    return this.db.prepare("SELECT * FROM chats WHERE participant_id = ? AND type = 'user' ORDER BY last_message_at DESC LIMIT 1").get(participantId) as ChatRow | undefined;
  }

  listChats(opts: { query?: string; type?: string; limit: number }): ChatRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.type) {
      where.push('type = ?');
      args.push(opts.type);
    }
    if (opts.query) {
      where.push("(name LIKE ? ESCAPE '\\' OR participant_name LIKE ? ESCAPE '\\' OR participant_username LIKE ? ESCAPE '\\')");
      const like = `%${opts.query.replace(/[%_]/g, (c) => '\\' + c)}%`;
      args.push(like, like, like);
    }
    const sql = `SELECT * FROM chats ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(last_message_at, 0) DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, opts.limit) as ChatRow[];
  }

  setUnread(id: string, n: number): void {
    this.db.prepare('UPDATE chats SET unread_count = ? WHERE id = ?').run(n, id);
  }

  // ---------- contacts ----------

  upsertContact(c: Omit<ContactRow, 'updated_at'> & { updated_at?: number }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (id, username, name, headline, distance, thread_id, updated_at) VALUES (@id, @username, @name, @headline, @distance, @thread_id, @updated_at)
         ON CONFLICT(id) DO UPDATE SET username = COALESCE(excluded.username, contacts.username), name = COALESCE(excluded.name, contacts.name),
           headline = COALESCE(excluded.headline, contacts.headline), distance = COALESCE(excluded.distance, contacts.distance),
           thread_id = COALESCE(excluded.thread_id, contacts.thread_id), updated_at = excluded.updated_at`,
      )
      .run({ ...c, updated_at: c.updated_at ?? Date.now() });
  }

  contactByUsername(username: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE username = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1').get(username) as ContactRow | undefined;
  }

  contact(id: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  }

  // ---------- actions ----------

  recordAction(kind: ActionKind, at: number, day: string, target: string | null): void {
    this.db.prepare('INSERT INTO actions (kind, at, day, target) VALUES (?, ?, ?, ?)').run(kind, at, day, target);
  }

  countsForDay(day: string): Counts {
    const rows = this.db.prepare('SELECT kind, COUNT(*) AS n FROM actions WHERE day = ? GROUP BY kind').all(day) as { kind: keyof Counts; n: number }[];
    const c: Counts = { ...ZERO_COUNTS };
    for (const r of rows) if (r.kind in c) c[r.kind] = r.n;
    return c;
  }

  // ---------- account ----------

  account(): AccountRow {
    return this.db.prepare('SELECT status, restricted_until, restricted_reason, identifier, urn_id, name, connected_at, next_write_at, next_invite_at FROM account WHERE k = 1').get() as AccountRow;
  }

  updateAccount(patch: Partial<AccountRow>): void {
    const keys = Object.keys(patch) as (keyof AccountRow)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE account SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE k = 1`).run(patch);
  }

  // ---------- invitations ----------

  upsertInvitation(i: InvitationRow): void {
    this.db
      .prepare(
        `INSERT INTO invitations (id, direction, shared_secret, username, name, sent_at, note) VALUES (@id, @direction, @shared_secret, @username, @name, @sent_at, @note)
         ON CONFLICT(id) DO UPDATE SET shared_secret = COALESCE(excluded.shared_secret, invitations.shared_secret), username = COALESCE(excluded.username, invitations.username),
           name = COALESCE(excluded.name, invitations.name), sent_at = COALESCE(excluded.sent_at, invitations.sent_at), note = COALESCE(excluded.note, invitations.note)`,
      )
      .run(i);
  }

  invitation(id: string): InvitationRow | undefined {
    return this.db.prepare('SELECT * FROM invitations WHERE id = ?').get(id) as InvitationRow | undefined;
  }
}
