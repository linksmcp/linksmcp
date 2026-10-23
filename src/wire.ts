/** door-contract 1.0 shapes for the linkedin channel. */
export const CONTRACT_VERSION = '1.0';
export const CHANNEL = 'linkedin';
export const ACCOUNT_ID = 'local';

export interface WireContact {
  id: string;
  name?: string;
  linkedin_username?: string;
  linkedin_url: string | null;
}

export interface WireMessage {
  id: string;
  account_id: string;
  channel: string;
  direction: 'inbound' | 'outbound';
  text: string;
  media: { url?: string; content_type: string } | null;
  status: string;
  /** code is the platform's error number; 0 when LinkedIn gave none. */
  error: { code: number; message: string } | null;
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

/** The hosted LinkedIn lane's status object (connect_linkedin, get_linkedin_status). */
export interface WireLinkedinStatus {
  account_id: string;
  status: 'connecting' | 'code_required' | 'connected' | 'failed' | 'disconnected';
  step: string | null;
  error: string | null;
  profile_name: string | null;
  profile_url: string | null;
  /** Self-hosted additions on get_linkedin_status. */
  limits?: WireAccount['limits'];
  hint?: string;
}

export interface WireChat {
  chat_id: string;
  channel: string;
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
