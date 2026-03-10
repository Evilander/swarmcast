# HANDOFF.md

## Directory structure
- `apps/web/` — dashboard
- `apps/api/` — forecast API
- `packages/agents/` — specialist agents
- `packages/aggregation/` — consensus and calibration logic
- `packages/connectors/` — weather, sports, news, market APIs
- `jobs/` — scheduled forecast runs
- `data/` — historical datasets and evaluations
- `reports/` — generated output

## Key dependencies
- `fastapi`, `pydantic`
- `pandas`, `numpy`, `scikit-learn`
- `apscheduler` or `celery`
- `httpx`
- `next`, `react`, charting lib

## Implementation order
1. Pick one narrow domain, ideally weather.
2. Build 3-4 specialist agents with distinct prompts/data views.
3. Implement aggregation and confidence scoring.
4. Save predictions and compare to outcomes.
5. Add dashboard charts and narrative summaries.
6. Add second domain only after first is stable.

## Estimated time to MVP
- 2 weekends for a single-domain forecasting lab
- 4-5 weeks for a multi-domain polished dashboard
