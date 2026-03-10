# SwarmCast

SwarmCast is a production-oriented weather service that blends standard forecast data, severe-weather signals, and multi-agent LLM reasoning into a single dashboard and API.

Five specialist agents review the same weather context, argue from different forecasting styles, and produce a consensus forecast with confidence, disagreement, and watch items. The app also tracks outcomes over time so agent weights can adapt based on real performance.

![SwarmCast dashboard](screenshot-5agent.png)

## Highlights

- Multi-agent consensus forecasting with quick, full, and live-stream modes
- Date-selectable forecasts from the 7-day strip instead of a hard-coded next-day-only flow
- Date-selectable severe outlook and severe analysis for today or upcoming forecast days
- Readiness and status endpoints for deployment health checks
- Admin-key protection for mutating routes
- File-backed persistence with atomic writes
- Docker-ready single-service deployment
- Zero build step and minimal runtime dependencies

## Quick Start

```bash
git clone https://github.com/Evilander/swarmcast.git
cd swarmcast
npm ci
cp .env.example .env
# Set the API key for your chosen provider in .env
npm run start:prod
```

PowerShell:

```powershell
Copy-Item .env.example .env
npm ci
npm run start:prod
```

Open `http://localhost:3777`.

## Configuration

SwarmCast requires Node 20+ and at least one configured LLM provider key when `REQUIRE_LLM_KEY=true`.

Core settings:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AI...

LLM_PROVIDER=openai
REQUIRE_LLM_KEY=true

NODE_ENV=production
HOST=0.0.0.0
PORT=3777
DATA_DIR=./data
ALLOWED_ORIGIN=
ADMIN_API_KEY=
```

Useful production knobs:

- `TRUST_PROXY`
- `REQUEST_TIMEOUT_MS`
- `KEEP_ALIVE_TIMEOUT_MS`
- `HEADERS_TIMEOUT_MS`
- `SHUTDOWN_TIMEOUT_MS`
- `EXTERNAL_TIMEOUT_MS`
- `EXTERNAL_RETRIES`
- `STREAM_HEARTBEAT_MS`
- `RATE_LIMIT_WINDOW_MS`
- `EXPENSIVE_ROUTE_LIMIT`
- `ADMIN_ROUTE_LIMIT`

## Production Notes

- `/api/status` reports runtime health, storage state, scheduler state, memory usage, and warnings.
- `/api/ready` is the deploy readiness probe.
- Mutating routes require the `x-swarmcast-admin-key` header when `ADMIN_API_KEY` is set.
- Expensive LLM-backed routes are rate-limited in-process.
- Runtime data is stored under `DATA_DIR`, so state can live outside the repo checkout.
- This service is designed as a single-instance file-backed deployment, not a multi-writer cluster.

## Docker

```bash
docker build -t swarmcast .
docker run --rm -p 3777:3777 --env-file .env swarmcast
```

The container image includes a healthcheck against `/api/ready`.

## Forecast and Severe Date Selection

The dashboard now supports choosing the forecast date directly from the 7-day strip. Severe-weather detail follows the selected date instead of always locking to tomorrow.

API examples:

```bash
curl "http://localhost:3777/api/forecast?date=2026-03-10"
curl "http://localhost:3777/api/forecast/stream?date=2026-03-11"
curl "http://localhost:3777/api/severe?location=mt-sterling&day=today"
curl "http://localhost:3777/api/severe/analysis?location=mt-sterling&date=2026-03-11"
```

## API Surface

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/weather` | `GET` | Current conditions and forecast data |
| `/api/forecast` | `GET` | Full swarm forecast |
| `/api/forecast/quick` | `GET` | Fast swarm forecast |
| `/api/forecast/stream` | `GET` | SSE live swarm forecast |
| `/api/forecast/all` | `GET` | Forecast all configured locations |
| `/api/forecast/multiday` | `GET` | Generate multiple future swarm forecasts |
| `/api/severe` | `GET` | Severe outlook, alerts, and selected-day detail |
| `/api/severe/analysis` | `GET` | LLM severe-risk analysis for the selected day |
| `/api/brief` | `GET` | Morning weather brief |
| `/api/local` | `GET` | Local/NWS source comparison |
| `/api/reputation` | `GET` | Agent leaderboard and weights |
| `/api/reputation/score` | `POST` | Score forecasts against actuals |
| `/api/outcome` | `POST` | Record actual observed weather |
| `/api/outcome/auto` | `POST` | Auto-record yesterday's weather |
| `/api/accuracy` | `GET` | Accuracy summary |
| `/api/history` | `GET` | Stored forecast history |
| `/api/schedule` | `GET/POST` | Scheduler configuration |
| `/api/status` | `GET` | Operational status |
| `/api/ready` | `GET` | Readiness probe |

## Local Verification

```bash
npm test
```

The smoke suite validates the hardened server surface, including status/readiness, admin route protection, CORS handling, validation failures, security headers, and rate limiting.

## Architecture

```text
public/   dashboard and embeddable widget
src/      server, providers, swarm orchestration, storage, reputation, accuracy
test/     node:test smoke coverage
data/     runtime forecast, outcome, and scheduler state
```

## License

MIT
