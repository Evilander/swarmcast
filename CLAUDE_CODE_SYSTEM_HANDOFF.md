# Claude Code System Handoff

## Scope

This handoff is for a fresh Claude Code session continuing work on `B:\projects\claude\githhug\ideas\2026-03-09\swarmcast`.

Treat this as an internal operating memo, not a user-facing prompt.

## Repo State

- Repo: `swarmcast`
- Branch: `master`
- Base commit at handoff time: `d425ab6`
- Worktree is dirty with the production-hardening changes still uncommitted

Current modified/new files:

- `.env.example`
- `README.md`
- `package-lock.json`
- `package.json`
- `public/index.html`
- `src/accuracy.js`
- `src/llm.js`
- `src/local-forecasts.js`
- `src/reputation.js`
- `src/server.js`
- `src/storage.js`
- `src/stream.js`
- `src/weather.js`
- `.dockerignore`
- `Dockerfile`
- `src/config.js`
- `src/fetch-utils.js`
- `test/server-smoke.test.js`

## Mission

The current goal is not "invent the next version of the product." The goal is to preserve and extend a production-hardening pass for a single-instance deployable service.

Optimize for:

- correctness over novelty
- preserving security and operability guarantees already added
- avoiding regressions in the zero-build deployment model
- verifying behavior with commands, not assumptions

Do not optimize for:

- large architectural rewrites
- framework migrations
- premature multi-node abstractions

## Mental Model

SwarmCast is still fundamentally a lightweight Express app with:

- static frontend in `public/index.html`
- weather and NWS fetchers
- LLM-backed ensemble forecasting
- file-backed persistence under `data/`
- in-process scheduler

The hardening pass intentionally kept that architecture but made it safer to run in production-like conditions.

This means:

- it is production-ready for a single instance behind normal infra protections
- it is not horizontally scalable yet
- file-backed persistence and in-process scheduling are still deliberate tradeoffs, not bugs introduced by the hardening pass

## What Changed

### Runtime and config

- `src/config.js`
  - centralizes env loading and validation
  - enforces provider selection and optional fail-fast API key requirements
  - defines server, rate-limit, timeout, admin, and storage settings

- `src/fetch-utils.js`
  - wraps `fetch()` with timeout, retry, and abort propagation

### Server surface

- `src/server.js`
  - replaced ad hoc env parsing with shared config
  - adds request IDs and basic request logging
  - adds security headers
  - adds body size limits
  - validates lat/lon/date/boolean/integer inputs
  - adds in-process rate limiting
  - supports optional admin protection on mutating routes via `x-swarmcast-admin-key`
  - adds `/api/ready` and upgrades `/api/status`
  - persists schedule config and restores it on boot
  - adds graceful shutdown behavior

### Persistence

- `src/storage.js`
  - adds atomic JSON writes through temp-file rename
  - persists scheduler state
  - exposes storage readiness information

- `src/reputation.js`
  - now uses shared data dir and atomic persistence helper

### External-call hardening

- `src/llm.js`
- `src/weather.js`
- `src/local-forecasts.js`
- `src/accuracy.js`

These now route outbound HTTP through the timeout/retry wrapper.

### Streaming

- `src/stream.js`
  - aborts work when the SSE client disconnects
  - adds heartbeat traffic
  - removes the overly permissive cross-origin posture from the previous version
  - sanitizes basic SSE query inputs

### Frontend adjustments

- `public/index.html`
  - reflects admin-protected mode in the status line
  - disables or de-emphasizes mutating controls when admin protection is active
  - avoids automatic mutating calls in protected mode

### Deployment and verification

- `Dockerfile`
- `.dockerignore`
- `package.json`
- `README.md`
- `.env.example`
- `test/server-smoke.test.js`

Net result:

- explicit production startup path
- Docker health check
- smoke tests for readiness and admin route protection
- docs aligned to the hardened behavior

## Invariants To Preserve

If you continue this work, do not casually break these:

- ES modules only
- no build step required
- app must still boot with `node src/server.js`
- smoke tests must stay fast and local
- mutating routes remain protectable with `ADMIN_API_KEY`
- expensive routes remain rate-limited
- readiness must report degraded state when critical runtime requirements are missing
- disk writes for forecast/outcome/schedule/reputation data should remain atomic
- SSE work should stop when the client disconnects

## Operational Assumptions

- Node runtime target is `>=20`
- tests intentionally run with `NODE_ENV=test` and `REQUIRE_LLM_KEY=false`
- live forecast/brief/analysis routes still require a valid provider key when actually invoked
- default deploy shape is a single service instance with local disk

If you change any of those assumptions, update:

- `package.json`
- `.env.example`
- `README.md`
- `Dockerfile`
- `test/server-smoke.test.js`

## Verification Baseline

Run these first before making more changes:

```bash
npm test
node --check src/server.js
node --check src/stream.js
node --check src/llm.js
```

If you need a live boot:

```bash
npm run start:prod
```

Basic local probes:

```bash
curl http://127.0.0.1:3777/api/status
curl http://127.0.0.1:3777/api/ready
curl http://127.0.0.1:3777/api/weather
```

When `ADMIN_API_KEY` is set, verify that:

- `POST /api/schedule` returns `401` without `x-swarmcast-admin-key`
- `GET /api/schedule` still works
- the dashboard renders in read-only mode for mutating controls

## Known Limitations

These are still real and should not be misrepresented:

- persistence is JSON-on-disk, not database-backed
- scheduler is in-process, not externalized
- rate limiting is in-memory and per-instance
- there is no auth model beyond optional admin header protection for mutating routes
- observability is still lightweight logging, not full metrics/tracing
- LLM output validation is still "parse expected JSON," not schema-enforced with robust retries/repair

## High-Value Next Steps

If continuing hardening, the next practical wins are:

1. Add focused tests around request validation failures and rate-limit behavior.
2. Add stricter JSON-shape validation for LLM responses before downstream use.
3. Normalize readiness semantics further by distinguishing liveness from dependency readiness more explicitly.
4. Replace file-backed schedule/reputation/forecast persistence with a real store only if the deployment target actually needs multi-instance behavior.
5. Add structured logging if this is going into a real hosted environment.

## Low-Value Next Steps

Avoid spending time here unless the user explicitly asks:

- TypeScript migration
- frontend redesign
- adding frameworks or bundlers
- replacing Express without a concrete production requirement
- speculative distributed scheduler work

## Recommended Reading Order

For a fresh session, read in this order:

1. `src/config.js`
2. `src/server.js`
3. `src/storage.js`
4. `src/stream.js`
5. `src/llm.js`
6. `test/server-smoke.test.js`
7. `README.md`

That sequence reconstructs the current operating model fastest.

## Completion Standard

A follow-up change should not be considered done unless:

- `npm test` passes
- any touched runtime file parses cleanly
- docs/config examples are updated if behavior changed
- no new unauthenticated mutating or quota-burning path was introduced unintentionally
- the single-instance deploy story is still coherent

## Final Guidance

Continue from the hardened architecture that exists now. Treat the current work as the baseline to preserve, not a disposable draft.
