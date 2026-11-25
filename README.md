# Switchboard

A shared team inbox. Customers write to a business through Pigeon (a simulated
messaging provider); support agents sign in, see conversations arrive in real
time, claim them, reply, and close or reopen them. Several workspaces share
one deployment and never see each other's data. Replies go out exactly once,
even when Pigeon is slow, rate-limits, fails, or the server is killed.

- **Server** `scaffold/server`: Express + TypeScript, MongoDB, Redis, `ws`.
- **Web app** `scaffold/web`: React 19 + Vite.
- **Tests** `tests/`: Node's test runner against real MongoDB, Redis and the simulators.

## Run it from a clean clone

Needs Node 22+ and Docker.

```
git clone <this repo> switchboard && cd switchboard
npm run up                  # MongoDB, Redis, Pigeon :4010, IdP :4020, Paybox :4030
npm run doctor              # every port should say PASS
npm run scaffold:install    # server and web dependencies
npm run scaffold:server     # API on http://localhost:4000
npm run scaffold:web        # web app on http://localhost:5173 (second terminal)
```

Open http://localhost:5173, click **Sign in** and pick a test user (e.g. Ben
Ortiz, an agent in `ws_acme`). Customers write in on their own every few
seconds; `npm run inbound` makes one write now.

No `.env` is needed: settings are read from the environment, then `.env`,
then `.env.example`, which holds the defaults (including our own tuning
values: outbox lease, timeouts, rate limit, session lifetimes).

## Tests

```
npm test        # 215 tests; needs npm run up
```

`tests/billing.e2e.test.ts` runs the bonus grader's billing scenario against a
live server on :4000 (where Paybox sends webhooks); see its header to run it.

## The checker (from Git Bash on Windows)

The checker starts the server itself, so stop `scaffold:server` first. Run it
from **Git Bash**: it spawns `sh`, which PowerShell does not have on its PATH.

```
npm run check                                         # level 1
npm run check -- --levels 1,5                         # levels 1 and 5
node harness/check.js --levels 1,5 --out CHECK_REPORT.json
npm run drizzle                                       # turn the customer trickle back on afterwards
```

On Windows the checker cannot kill the instances it starts (it uses process
groups), so they keep ports 4001/4002. Stop them after each run, in PowerShell:

```
Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'tsx src/index.ts|scaffold/server start' } | % { Stop-Process -Id $_.ProcessId -Force }
```

This is also why `npm run check:full` stops at level 2 on Windows. Run it on
Linux or WSL for levels 2 and 3.

## What works and what is not done

| | Status |
| --- | --- |
| Level 1: duplicates, order, forged/stale webhooks, rate limit, outage, claim race | 24/24 locally |
| Level 4: the written rules | each rule covered by tests (`tests/level4.integration.test.ts`) |
| Level 5: login (OIDC + PKCE), tenant isolation, WebSocket live + replay, 2 instances | 15/15 locally |
| Levels 2 and 3: kill -9, several copies, failover | built for, **not run here** (Windows); see DECISIONS.md |
| Bonus billing (Paybox) | server done; grader scenario passes end to end; **no card form in the UI** |
| Web app | list, conversation, reply, claim/close/reopen, live updates, loading/error/empty states; typechecked and built, **not tested in a browser** |
| Encrypted notes, Elasticsearch search | **not built** |

## Where things are

```
scaffold/server/src
  routes/       webhooks (Pigeon), grader, auth, api, billing
  services/     inbound, replies, conversations (claim), status, inbox, snapshot, reset
  outbox/       worker (leases), Pigeon client, Redis rate limit
  realtime/     event log (Redis Streams), hub, /ws upgrade
  auth/         OIDC + PKCE, sessions, cookies, middleware
  billing/      Paybox client and subscription logic
scaffold/web/src  App, Inbox, ConversationList, ConversationPane, live.ts, inbox-state.ts
tests/            unit and integration tests
```
