# Decisions

**Build order.** Grader endpoints → webhook → outbox → level 4 rules → login/API → WebSocket → billing → UI. The check is 85 of 100 points, so it passed early and stayed passing after every step; the UI (3 points) came last.

**Surviving.** Nothing lives in memory. *Restarts:* a webhook gets 2xx only after MongoDB stored it (unique per message id); a reply is stored before its 202 and sent from an outbox under a 12 s lease with `Idempotency-Key = client_ref`, so a resend is a replay. *Several copies:* leases in MongoDB; rate limit, 429 cool-off, sessions and login state in Redis; WebSocket `seq` from one Lua script (INCR + Redis Stream + PUBLISH). *Flaky Pigeon:* 4 s timeout, backoff 0.5–8 s with jitter, Retry-After shared by all copies, our bucket (6, 3.5/s) under Pigeon's; status only moves forward.

**Where the docs were silent.** Timestamps over 5 min in the future: 401. A workspace exists only if it has a `PIGEON_KEY_WS_*` variable. Replies start `queued` and retry forever; a 4xx other than 429 marks them failed. Reset deletes `sb:app:*` keys (sessions survive); replay keeps 10k frames. Closing keeps the assignee; admins and agents have the same inbox rights. Billing: `past_due` can still send, `incomplete` stays on the trial, `canceled` gets 402 but can read.

**Skipped.** Encrypted notes, search, the billing card form, unassigning.

**Levels 2, 3 and 4 are unverified.** *Levels 2 and 3* could not run on my machine (Windows). The checker kills instances with `process.kill(-pid)` (a Unix process group); on Windows that silently fails. So the "killed" instance keeps its port, the restarted one exits with EADDRINUSE, the load balancer has no live instance, and the run stops ("snapshot returned 502"). That is why `check:full` scored 24/75: everything after the stop counts as 0, including level 5, which scores 15/15 when run alone. The design covers them (expiring leases, idempotent resends, state shared in MongoDB and Redis), but I never saw them pass. *Level 4* is not in the public checker, so it cannot be run locally; every written rule has its own tests instead.

**Still wrong.** A frame is lost if Redis fails at the moment it is published (the data itself is safe). Replies queued before a cancellation still go out. The UI was not tested in a browser.

**AI.** I used Claude Code (`ai-logs/`). It proposed a plan before each step; I set the scope, and after each step it tested and committed. It proposed WSL for levels 2 and 3; I declined to save time. It listed the silent points with proposed answers; I decided each. It flagged that billing needs 4 small edits to existing files; I approved them on condition that nothing regressed, and re-running levels 1 and 5 confirmed it.
