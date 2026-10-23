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
