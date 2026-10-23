# linksmcp: the LinkedIn MCP server you run yourself

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

linksmcp is a free, MIT licensed LinkedIn MCP server for people who want Claude, Cursor or any MCP client to read their LinkedIn inbox, look up profiles, search people and send messages. It runs on your own machine, over stdio, signed in with your own LinkedIn session cookie. Nothing goes to a third party.

## What you get

1. Your LinkedIn inbox inside your AI assistant: read threads, reply, wait for new messages.
2. Profile lookups, people search, connection requests and invitation handling as MCP tools.
3. Daily limits, pacing and pauses enforced on your machine before anything reaches LinkedIn.
4. A local SQLite store with full text search over every message the server has seen.
5. No account, no telemetry, no update check. One cookie, one folder, one process.

## Install

linksmcp needs Node.js 20 or newer. The package is `linksmcp` on npm.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "linksmcp": {
      "command": "npx",
      "args": ["-y", "linksmcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add linksmcp -- npx linksmcp
```

### Cursor

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "linksmcp": {
      "command": "npx",
      "args": ["-y", "linksmcp"]
    }
  }
}
```

### OpenClaw and other MCP clients

Any client that starts a stdio MCP server works with the same block. Put it wherever your client keeps its `mcpServers` list:

```json
{
  "mcpServers": {
    "linksmcp": {
      "command": "npx",
      "args": ["-y", "linksmcp"]
    }
  }
}
```

### Docker

```bash
docker run -i -v ~/.linksmcp:/data ghcr.io/linksmcp/linksmcp
```

The container keeps its cookie, config and database in `/data`, so mount the same folder every time. To sign in from Docker, run `docker run -it -v ~/.linksmcp:/data ghcr.io/linksmcp/linksmcp login`.

## Sign in

linksmcp signs in with the `li_at` cookie of a LinkedIn session you already have open in your browser. In Chrome:

1. Open https://www.linkedin.com and make sure you are signed in.
2. Open Developer Tools (F12 on Windows and Linux, Cmd+Option+I on Mac) and pick the Application tab.
3. In the left panel open Storage, then Cookies, then `https://www.linkedin.com`.
4. Find the row named `li_at` and copy its Value.

Then run:

```bash
npx linksmcp login
```

Paste the cookie when asked. linksmcp checks it against LinkedIn and saves it to `~/.linksmcp/auth.json` with file mode 600, readable only by your user. You can also pass the cookie as the `LINKSMCP_LI_AT` environment variable, or sign in from your assistant with the `connect_linkedin` tool.

Other commands:

| Command | What it does |
| --- | --- |
| `linksmcp` | Starts the MCP server over stdio. This is what your client runs. |
| `linksmcp login` | Saves your `li_at` cookie after checking it. |
| `linksmcp status` | Shows the signed in account and today's usage. |
| `linksmcp doctor` | Checks Node, the data folder, the cookie and the connection to LinkedIn. |
| `linksmcp logout` | Deletes the stored cookie. Your LinkedIn session in the browser stays signed in. |

Environment variables:

| Variable | What it does |
| --- | --- |
| `LINKSMCP_HOME` | Moves the data folder. Default `~/.linksmcp`. |
| `LINKSMCP_LI_AT` | Supplies the cookie without `linksmcp login`. |
| `LINKSMCP_TZ` | Timezone for working hours and the daily counters, for example `Europe/Amsterdam`. Default is the machine's timezone. |
| `LINKSMCP_SEARCH_QUERY_ID` | Overrides the LinkedIn search query id when LinkedIn changes it. |

## Tools

linksmcp speaks door-contract 1.0: 9 shared messaging tools plus 9 LinkedIn tools. Every write is checked against the limits below before it is sent.

| Group | Tool | What it does |
| --- | --- | --- |
| Account | `list_accounts` | Lists the connected LinkedIn account. |
| Account | `connect_linkedin` | Signs in with the `li_at` cookie of your own LinkedIn session. |
| Account | `get_linkedin_status` | Shows whether the account is connected, paused or signed out. |
| Account | `disconnect_linkedin` | Forgets the stored cookie. LinkedIn itself is not signed out. |
| Account | `get_my_profile` | Reads your own profile. |
| People | `get_person_profile` | Reads one profile by username or profile URL. Counts as a profile view. |
| People | `search_people` | Finds people by keywords, location and current company. Counts as a search. |
| People | `connect_with_person` | Sends a connection request with an optional note of up to 300 characters, without links. |
| People | `list_invitations` | Lists sent or received invitations. |
| People | `accept_invitation` | Accepts a received invitation. Counts as an accept. |
| Inbox | `list_chats` | Lists your LinkedIn threads, most recent first. |
| Inbox | `list_messages` | Reads one thread from LinkedIn, or lists stored messages when no thread is given. |
| Inbox | `get_message` | Gets one stored message by id. |
| Inbox | `send_message` | Sends one message to one person, in an existing thread or a new one with a first degree connection. |
| Inbox | `wait_for_messages` | Waits for new inbound messages and returns them as they arrive. |
| Inbox | `search_messages` | Full text search over every message stored on your machine. |
| Inbox | `mark_read` | Marks a thread as read on LinkedIn. |
| Usage | `get_usage` | Shows today's counts against each limit and when the next write is allowed. |

A recipient is one object with exactly one of `linkedin_username` (the public id from the profile URL), `profile_url` (`https://www.linkedin.com/in/...`) or `contact_id` (a chat id from `list_chats`). There is no bulk tool and `to` never takes a list.

## Limits

linksmcp counts every action per local calendar day and refuses the ones over a limit. These are the defaults:

| Rule | Default |
| --- | --- |
| Messages per day (openers, replies, follow ups) | 100 |
| New threads opened per day | 50 |
| Connection requests per day | 20 |
| Profile views per day | 250 |
| Searches per day | 30 |
| Accepted invitations per day | 20 |
| Working hours | 08:00 to 20:00 local time, every day |
| Gap between any two writes | 20 to 60 seconds, varied |
| Gap between connection requests | 5 to 8 minutes, varied |
| Automated messages to one person while you spoke last | 24 hours apart. Replies to someone who wrote last are never held. |
| Links | Refused in connection notes and in messages to a person who has not written back in that thread. |
| After the cookie stops working | Writes stop until you sign in again. |
| After a LinkedIn security check or restriction | Writes pause for 48 hours. Reading the inbox still works. |
| LinkedIn answers "too many requests" | Writes wait for LinkedIn's retry time, or 15 minutes. |

When the gap left before the next write is 45 seconds or less, linksmcp waits and then sends. Longer waits come back as `rate_limited` with `retry_after_s`, so your assistant can decide what to do next.

To change a limit, edit `~/.linksmcp/config.json` (or `$LINKSMCP_HOME/config.json`; the file is written with these defaults on first start) and restart the server:

```json
{
  "caps": {
    "messages": 100,
    "new_threads": 50,
    "invitations": 20,
    "profile_views": 250,
    "searches": 30,
    "accepts": 20
  },
  "working_hours": { "start": "08:00", "end": "20:00" },
  "write_gap_seconds": { "min": 20, "max": 60 },
  "invite_gap_seconds": { "min": 300, "max": 480 },
  "follow_up_floor_hours": 24,
  "restriction_pause_hours": 48,
  "timezone": ""
}
```

The same caps can be set per run with `LINKSMCP_MESSAGES_PER_DAY`, `LINKSMCP_NEW_THREADS_PER_DAY`, `LINKSMCP_INVITES_PER_DAY`, `LINKSMCP_PROFILE_VIEWS_PER_DAY`, `LINKSMCP_SEARCHES_PER_DAY`, `LINKSMCP_ACCEPTS_PER_DAY` and `LINKSMCP_WORKING_HOURS` (for example `09:00-18:00`). A value that fails to parse keeps the default.

LinkedIn's own User Agreement binds you when you use this software, and any restriction LinkedIn places on your account is your own. The limits keep your activity at a sensible pace. No setting makes automation invisible to LinkedIn.

## What is a LinkedIn MCP server?

A LinkedIn MCP server is a program that gives an AI assistant tools for LinkedIn through the Model Context Protocol, the open standard Claude, Cursor and other clients use to call external tools. The assistant asks the server to read a thread, look up a profile or send a message, and the server does it with your LinkedIn session and returns the result. linksmcp is one you run yourself, so the session, the limits and the message history stay on your computer.

## Self hosted or hosted

The same tool names also work on the hosted version at https://linksmcp.com.

| | linksmcp (this repo) | Hosted at linksmcp.com |
| --- | --- | --- |
| Where it runs | On your machine, started by your MCP client | Described at linksmcp.com |
| Limits | The defaults above, which you can edit | Managed for you, published at linksmcp.com/rules |
| Price | Free, MIT | See linksmcp.com |

## FAQ

### Does linksmcp work with Claude Desktop?

Yes. Add the `mcpServers` block from the Install section to `claude_desktop_config.json`, restart Claude Desktop, run `npx linksmcp login` once, and the 18 tools appear in Claude. Claude Code, Cursor and any other stdio MCP client work the same way.

### Is linksmcp safe to use?

Your cookie stays in a file only your user can read, the code is open for you to inspect, and nothing is sent anywhere except to LinkedIn. Daily limits, working hours, pacing and pauses run before every write. Using any automation on LinkedIn still carries the risk that LinkedIn restricts your account.

### Does LinkedIn allow this?

LinkedIn's User Agreement limits automated access, and you are the one bound by it. linksmcp is a tool you run on your own account. Read LinkedIn's terms and decide for yourself, and keep the limits at a level you are comfortable with.

### Where is my LinkedIn cookie stored?

In `~/.linksmcp/auth.json` with file mode 600, or in the folder set by `LINKSMCP_HOME`. If you use `LINKSMCP_LI_AT` it lives only in your environment. `linksmcp logout` deletes the file.

### Can linksmcp send bulk messages?

No. `send_message` takes one recipient per call and there is no bulk tool. Every message also counts against the daily message limit and the pacing gap.

### Can I attach files or images to LinkedIn messages?

Not in version 0.1. A call with `media_url` or `media_path` returns `media_unavailable`. Text messages and replies work.

### What happens when LinkedIn asks for a security check?

linksmcp returns `security_challenge` and pauses all writes for 48 hours, while reading the inbox keeps working. Open LinkedIn in your browser and finish the check. If LinkedIn signed you out, copy the new `li_at` cookie and run `npx linksmcp login` again.

### Can I change the daily limits?

Yes. Edit `~/.linksmcp/config.json` as shown in the Limits section, or set the environment variables listed there, and restart the server. `get_usage` and `linksmcp status` show the limits in effect.

## Errors

Every refusal is a tool result with `isError: true` whose text is JSON: `{"error_code": "...", "error": "...", "retry_after_s": 120}`. Nothing is sent on a refusal and nothing is queued. `retry_after_s` appears when waiting helps.

| Code | Meaning |
| --- | --- |
| `no_connected_account` | No LinkedIn account is signed in. Run `linksmcp login` or call `connect_linkedin`. |
| `session_expired` | The cookie no longer signs in. Copy a fresh `li_at` and sign in again. |
| `security_challenge` | LinkedIn asked for a security check. Writes pause for 48 hours. Finish the check in a browser. |
| `account_suspended` | LinkedIn restricted the account. Writes pause for 48 hours. |
| `invalid_recipient` | The recipient is malformed, a list, or not a LinkedIn member. |
| `contact_not_found` | No chat with that id is known. |
| `message_not_found` | No message with that id is known. |
| `needs_connection_first` | A new thread can only be opened with a first degree connection. |
| `link_not_allowed` | A link in a connection note, or in a message to a person who has not written back. The text is refused, not edited. |
| `outside_working_hours` | Outside the configured working hours. `retry_after_s` points to the next window start. |
| `rate_limited` | Too soon after the last write, inside the 24 hour follow up gap, or LinkedIn asked to slow down. Wait `retry_after_s`. |
| `daily_send_cap` | Today's message limit is reached. `retry_after_s` points to the next local midnight. |
| `new_contact_cap` | Today's new thread limit is reached. `retry_after_s` points to the next local midnight. |
| `daily_invite_cap` | Today's connection request limit is reached. |
| `daily_read_cap` | Today's profile view or search limit is reached. |
| `media_unavailable` | Attachments are not supported in this version. |
| `send_failed` | LinkedIn rejected the send. |

The full contract, including codes used only by other channels, is in [`contract/door-contract.json`](contract/door-contract.json).

### Search stopped working

LinkedIn changes the id of its people search query from time to time. When `search_people` fails while everything else works, update linksmcp, or set `LINKSMCP_SEARCH_QUERY_ID` to the current id and restart.

## Contributing

Issues and pull requests are welcome. Run `npm ci`, then `npm run typecheck`, `npm test` and `npm run lint` before you open a pull request.
Tool names, fields and error codes follow `contract/door-contract.json` and are never renamed within a major version, so new behaviour arrives as new optional fields or new tools.
Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

linksmcp is an independent open source project, not affiliated with or endorsed by LinkedIn. LinkedIn is a trademark of LinkedIn Corporation, used only to identify the service this software connects to.
