/** door-contract 1.0 shapes for the linkedin channel. */
export const CONTRACT_VERSION = '1.0';
export const CHANNEL = 'linkedin';
export const ACCOUNT_ID = 'local';

export interface WireContact {
  id: string;
  name?: string;
  linkedin_username?: string;
  profile_url?: string;
}

export interface WireMessage {
  id: string;
  account_id: string;
  channel: string;
  direction: 'inbound' | 'outbound';
  text: string;
  media?: { url?: string; content_type: string };
  status: string;
  error?: { code: string; message: string };
  timestamp: string;
  contact: WireContact;
  chat_id: string;
}

export interface WireAccount {
  id: string;
  channel: string;
  connect_kind: string;
  identifier: string | null;
  status: 'connected' | 'connecting' | 'disconnected' | 'restricted';
  connected_at: string | null;
  limits: {
    sends_today: number;
    sends_cap: number;
    new_contacts_today: number;
    new_contacts_cap: number;
    ramp_day: number | null;
  };
  /** Additive: a plain sentence on what to do next, when there is something to do. */
  hint?: string;
}

export interface WireChat {
  chat_id: string;
  name: string | null;
  type: 'user' | 'group' | 'channel';
  unread_count: number;
  last_message_at: string | null;
}

export interface WireError {
  error_code: string;
  error: string;
  retry_after_s?: number;
}

/** A refusal or failure that becomes an isError tool result with a contract error body. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }

  toWire(): WireError {
    const e: WireError = { error_code: this.code, error: this.message };
    if (this.retryAfterS !== undefined) e.retry_after_s = Math.max(1, Math.ceil(this.retryAfterS));
    return e;
  }
}

export const profileUrlFor = (username: string) => `https://www.linkedin.com/in/${username}/`;
