# Changelog

## 0.1.0 (2026-10-23)

First release.

- LinkedIn MCP server over stdio, started with `npx linksmcp`.
- Sign in with your own `li_at` cookie through `linksmcp login`, the `LINKSMCP_LI_AT` environment variable or the `connect_linkedin` tool. The cookie is stored in `~/.linksmcp/auth.json` with file mode 600.
- 18 tools following door-contract 1.0: 9 shared messaging tools (`list_accounts`, `send_message`, `get_message`, `list_messages`, `wait_for_messages`, `get_usage`, `list_chats`, `search_messages`, `mark_read`) and 9 LinkedIn tools (`connect_linkedin`, `get_linkedin_status`, `disconnect_linkedin`, `get_my_profile`, `get_person_profile`, `search_people`, `connect_with_person`, `list_invitations`, `accept_invitation`).
- Daily limits for messages, new threads, connection requests, profile views, searches and accepts, working hours, pacing between writes, a 24 hour gap for automated follow ups, a link rule and a 48 hour pause after a LinkedIn security check. All editable in `~/.linksmcp/config.json`.
- Local SQLite store with full text search in `~/.linksmcp/linksmcp.db`.
- CLI commands `login`, `status`, `doctor` and `logout`.
- Docker image `ghcr.io/linksmcp/linksmcp`.
- Not included yet: media attachments (`media_unavailable`).
