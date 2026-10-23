# Security

## Reporting a vulnerability

Email hi@linksmcp.com with a description of the issue, the steps to reproduce it and the version you tested. Please do not open a public issue for a security problem. You will get an answer within a few working days, and a fix is released as soon as it is ready.

## Scope

- The linksmcp server and CLI in this repository.
- The cookie file `~/.linksmcp/auth.json` (or `$LINKSMCP_HOME/auth.json`): how it is written, its file mode and who can read it.
- The SQLite file `~/.linksmcp/linksmcp.db`: what is stored and how it is accessed.
- The Docker image `ghcr.io/linksmcp/linksmcp`.

LinkedIn's own services and the MCP clients that start linksmcp are out of scope.

## How your data is handled

Your LinkedIn cookie never leaves your machine except in the requests linksmcp makes to LinkedIn on your behalf. linksmcp has no account, no telemetry and no update check, and it sends nothing to any other server. The cookie file is written with mode 600 so only your user can read it. `linksmcp logout` deletes it.

Treat `li_at` like a password: anyone who has it can act as you on LinkedIn. Never paste it into an issue, a log or a chat.
