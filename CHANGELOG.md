# Changelog

## 0.1.0 (2026-10-23)

First release.

- LinkedIn MCP server over stdio, started with `npx linksmcp`.
- Sign in with your own LinkedIn session: the `li_at` cookie through `linksmcp login` or the `LINKSMCP_LI_AT` environment variable, a cookie export file through `linksmcp login --cookie-jar cookies.json`, or the `connect_linkedin` tool with `cookie_jar` and `country` (or `li_at` as a shortcut). The cookies are stored in `~/.linksmcp/auth.json` with file mode 600. The one account has the id `local`.
- 19 tools following door-contract 1.0: 9 shared messaging tools (`list_accounts`, `send_message`, `get_message`, `list_messages`, `wait_for_messages`, `get_usage`, `list_chats`, `search_messages`, `mark_read`) and 10 LinkedIn tools (`connect_linkedin`, `get_linkedin_status`, `submit_linkedin_code`, `disconnect_linkedin`, `get_my_profile`, `get_person_profile`, `search_people`, `connect_with_person`, `list_invitations`, `accept_invitation`). `submit_linkedin_code` exists for parity with the hosted version and answers `invalid_request` here.
- Recipients by `linkedin_url`, `contact_id` or `linkedin_username`. `send_message` requires `text`, accepts and logs `opt_in`, and answers `{message_id, status: "sent", reply_to_applied: false}`.
- Daily limits for messages, new threads, connection requests, profile views, searches and accepts, working hours, pacing between writes, a 24 hour gap for automated follow ups, a link rule and a 48 hour pause after a LinkedIn security check. All editable in `~/.linksmcp/config.json` or with environment variables.
- Every refusal is JSON `{error_code, error, retry_after_s?}`, including input checks such as `invalid_text`, `invalid_limit` and `account_not_found`.
- Local SQLite store with full text search in `~/.linksmcp/linksmcp.db`.
- CLI commands `login`, `status`, `doctor` and `logout`.
- Docker image `ghcr.io/linksmcp/linksmcp`.
- Not included yet: media attachments (`media_unavailable`).
