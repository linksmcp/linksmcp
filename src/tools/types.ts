import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Door } from '../door.js';
import { LinkedInHttpError } from '../linkedin/client.js';
import { ToolError } from '../wire.js';

export interface ToolContext {
  door: Door;
  /** Upper bound for wait_for_messages, in seconds (tests lower it). */
  maxWaitS?: number;
  /** Seconds between inbox polls in wait_for_messages. */
  pollIntervalS?: number;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler: (args: any) => Promise<CallToolResult>;
}

export const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

export function errorResult(err: unknown): CallToolResult {
  const e = err instanceof ToolError ? err : new ToolError('send_failed', (err as Error)?.message ?? String(err));
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(e.toWire()) }] };
}

export function wrap(fn: (args: any) => Promise<CallToolResult>): (args: any) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args ?? {});
    } catch (err) {
      return errorResult(err);
    }
  };
}

/** A 404 (or 400) on a thread means LinkedIn does not know that chat id. */
export function chatNotFound(err: unknown, chatId: string): unknown {
  if (err instanceof LinkedInHttpError && (err.status === 404 || err.status === 400)) {
    return new ToolError('contact_not_found', `LinkedIn has no thread with id ${chatId}. Use list_chats to find one.`);
  }
  return err;
}

/** limit within [min, max], else invalid_limit. */
export function limitArg(v: unknown, min: number, max: number, def: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ToolError('invalid_limit', `limit must be a whole number from ${min} to ${max}.`);
  }
  return v;
}

/** A chat id used as a filter or target: non-empty, no surrounding blanks, at most 200 characters. */
export function chatIdArg(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.trim() !== v || v.length > 200) {
    throw new ToolError('invalid_chat_id', 'chat_id must be a chat id from list_chats (1 to 200 characters, no spaces around it).');
  }
  return v;
}

/** An optional enum value checked inside the handler (the schema already lists the values). */
export function enumArg<T extends string>(v: unknown, values: readonly T[], code: string, name: string): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new ToolError(code, `${name} must be one of ${values.join(', ')}.`);
  return v as T;
}

/** Query text with a length range, else invalid_query. */
export function queryArg(v: unknown, min: number, max: number, required: boolean): string | undefined {
  if (v === undefined || v === null || (!required && v === '')) {
    if (required) throw new ToolError('invalid_query', `query is required (${min} to ${max} characters).`);
    return undefined;
  }
  const s = typeof v === 'string' ? v.trim() : '';
  if (typeof v !== 'string' || s.length < min || v.length > max) throw new ToolError('invalid_query', `query must be ${min} to ${max} characters.`);
  return s;
}
