#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { openDoor } from './app.js';
import { deleteAuth } from './auth.js';
import { getMe } from './linkedin/profile.js';
import { resolvePaths } from './paths.js';
import { serveStdio } from './server.js';
import { VERSION } from './version.js';
import { ToolError } from './wire.js';

const HELP = `linksmcp ${VERSION}: a LinkedIn MCP server that runs on your machine.

Usage:
  linksmcp [serve]       Start the MCP server on stdio (what your AI app runs)
  linksmcp login         Store your li_at cookie (read from stdin, not echoed)
                         Options: --li-at <value>  --jsessionid <value>
                                  --cookie-jar <file>  (a linkedin.com cookie export, JSON; more reliable)
                                  --user-agent <ua>    (the browser the cookies came from)
                                  --country <XX>
  linksmcp status        Print the account status
  linksmcp doctor        Check the cookie with LinkedIn and print today's counts and limits
  linksmcp logout        Forget the stored cookie
  linksmcp --version

Data lives in $LINKSMCP_HOME (default ~/.linksmcp).`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function print(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}

function fail(err: unknown): never {
  const e = err instanceof ToolError ? err.toWire() : { error_code: 'send_failed', error: (err as Error)?.message ?? String(err) };
  process.stderr.write(`${e.error_code}: ${e.error}\n`);
  process.exit(1);
}

/** Reads one line from the terminal without echoing it, or all of stdin when it is a pipe. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value.trim());
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'serve';
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h') || cmd === 'help') {
    process.stdout.write(HELP + '\n');
    return;
  }

  switch (cmd) {
    case 'serve': {
      const door = openDoor();
      const server = await serveStdio({ door });
      const stop = async () => {
        await server.close().catch(() => undefined);
        door.store.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      process.stdin.on('end', stop);
      return;
    }
    case 'login': {
      const door = openDoor();
      const jarFile = flag(args, '--cookie-jar');
      let cookieJar: string | undefined;
      let liAt: string | undefined;
      if (jarFile) {
        try {
          cookieJar = readFileSync(jarFile, 'utf8');
        } catch (err) {
          fail(new ToolError('invalid_request', `Could not read ${jarFile}: ${(err as Error).message}`));
        }
      } else {
        liAt = flag(args, '--li-at') ?? (await readSecret('Paste the value of your li_at cookie (a full cookie export file with --cookie-jar is more reliable): '));
        if (!liAt) fail(new ToolError('invalid_request', 'No cookie given.'));
      }
      try {
        const status = await door.connect({ cookie_jar: cookieJar, li_at: liAt, jsessionid: flag(args, '--jsessionid'), country: flag(args, '--country'), user_agent: flag(args, '--user-agent') });
        print(status);
        if (status.status !== 'connected') {
          process.stderr.write(`Sign-in failed: ${status.error ?? 'unknown reason'}\n`);
          process.exit(1);
        }
        process.stderr.write(`Signed in as ${status.profile_name ?? 'your LinkedIn account'}. The cookie is stored in ${door.paths.auth}.\n`);
      } catch (err) {
        fail(err);
      }
      return;
    }
    case 'status': {
      print(openDoor().linkedinStatus(true));
      return;
    }
    case 'doctor': {
      const door = openDoor();
      if (!door.auth()) fail(new ToolError('no_connected_account', 'No cookie stored. Run "linksmcp login" first.'));
      try {
        const me = await door.guard(async () => getMe(await door.client()));
        process.stderr.write(`Cookie OK: signed in as ${me.linkedin_username ?? me.name ?? 'unknown'}.\n`);
      } catch (err) {
        print({ status: door.linkedinStatus(true), usage: door.usage() });
        fail(err);
      }
      print({ status: door.linkedinStatus(true), usage: door.usage(), data_dir: door.paths.home });
      return;
    }
    case 'logout': {
      const removed = deleteAuth(resolvePaths().auth);
      process.stderr.write(removed ? 'The stored cookie was deleted. LinkedIn itself is not signed out.\n' : 'No cookie was stored.\n');
      return;
    }
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}\n`);
      process.exit(2);
  }
}

main().catch(fail);
