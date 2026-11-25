# Decisions

**Build order.** Health and grader endpoints → Pigeon webhook → outbox → level 4 rules → login and API → WebSocket → billing bonus → UI. The automatic check carries 85 of 100 points, so I made `npm run check` pass early and kept it passing after every step. The UI came last: it is worth 3 points, and the API it needs already existed.

**Surviving.** No state lives in memory. *Restarts:* a webhook gets 2xx only after MongoDB stored it, with a unique index on (workspace, message_id). A reply is stored before its 202. Replies are sent from an outbox under a 12 s lease, with `Idempotency-Key = client_ref`, so a resend after a crash is a replay, not a second send. *Several copies:* the leases are in MongoDB. The per-workspace rate limit and the 429 cool-off are in Redis (one Lua script), and so are sessions and login state. WebSocket frames get their `seq` from one Lua script (INCR + XADD to a Redis Stream + PUBLISH), so every copy serves the same ordered log. *Flaky Pigeon:* 4 s timeout; backoff from 0.5 s to 8 s with jitter; Retry-After is honoured across copies; our token bucket (6, 3.5/s) stays under Pigeon's (8, 4/s). Status only moves forward.

**Where the docs were silent.**
- Timestamps more than 5 min in the future get 401.
- A workspace exists only if it has a `PIGEON_KEY_WS_*` variable.
- A new reply starts as `queued`. Transient failures are retried forever with backoff; any other 4xx marks it `failed`.
- Reset deletes our `sb:app:*` Redis keys, not FLUSHDB, so sessions survive. Replay keeps the last 10k frames per workspace.
- Closing a conversation keeps its assignee. Admins and agents have the same inbox rights. Roles are read at login.
- Billing: `past_due` is a grace period (can send); `incomplete` stays on the trial; `canceled` gets 402 but can still read. Reducing seats removes nobody's access.

**Skipped.** Encrypted notes, Elasticsearch search, the billing card form, unassigning a conversation.

**Known to be wrong or unverified.**
- Levels 2 and 3 were never run: the checker cannot kill processes on Windows.
- A status, claim or reply frame is lost if Redis fails exactly when it is published (the data itself is safe).
- An inbound frame is lost if the server crashes between setting its `emitted` flag and publishing it.
- Replies queued before a cancellation are still sent.
- The UI was not tested in a browser.

**AI.** I built this with Claude Code (transcripts in `ai-logs/`). Before each step it gave a short plan and I chose the scope; after each step it tested, committed and stopped.
- It proposed WSL to run levels 2 and 3; I declined to save time.
- It listed the silent points above and proposed an answer for each; I decided each one.
- It flagged that billing needs 4 small edits to existing files. I approved them as long as earlier progress stayed intact, which it proved by re-running levels 1 and 5.
- It also found an npm `--prefix` install bug and stray check instances.
