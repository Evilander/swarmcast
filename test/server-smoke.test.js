import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const baseDataDir = mkdtempSync(join(tmpdir(), 'swarmcast-test-'));
const port = 4787;
const adminKey = 'test-admin-key';
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: baseDataDir,
    ADMIN_API_KEY: adminKey,
    ALLOWED_ORIGIN: 'https://dashboard.example.com',
    REQUIRE_LLM_KEY: 'false',
    EXPENSIVE_ROUTE_LIMIT: '3',
    RATE_LIMIT_WINDOW_MS: '60000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
server.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

test.before(async () => {
  await waitForServer();
});

test.after(() => {
  server.kill('SIGTERM');
  rmSync(baseDataDir, { recursive: true, force: true });
});

// --- Existing tests ---

test('status and readiness endpoints respond', async () => {
  const status = await fetchJson('/api/status');
  assert.equal(status.status, 'ready');
  assert.equal(status.ready, true);
  assert.equal(status.storage.ok, true);
});

test('admin routes require the admin header and persist schedule updates', async () => {
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, intervalHours: 12, locations: ['mt-sterling'] })
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-swarmcast-admin-key': adminKey
    },
    body: JSON.stringify({ enabled: false, intervalHours: 12, locations: ['mt-sterling'] })
  });
  assert.equal(authorized.status, 200);

  const schedule = await fetchJson('/api/schedule');
  assert.equal(schedule.intervalHours, 12);
  assert.deepEqual(schedule.locations, ['mt-sterling']);
  assert.equal(schedule.enabled, false);
});

test('CORS preflight allows the configured origin', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://dashboard.example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-swarmcast-admin-key'
    }
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://dashboard.example.com');
  assert.match(response.headers.get('access-control-allow-headers') || '', /x-swarmcast-admin-key/i);
});

test('CORS preflight rejects disallowed origins', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://not-allowed.example.com',
      'Access-Control-Request-Method': 'POST'
    }
  });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'origin_not_allowed');
});

// --- Request validation tests ---

test('invalid lat/lon returns 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/weather?lat=abc`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /lat/i);
});

test('out-of-range lat returns 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/weather?lat=95`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /between/i);
});

test('invalid date format returns 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/history/not-a-date`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /YYYY-MM-DD/);
});

test('invalid boolean query returns 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/forecast?debate=maybe`);
  // This hits the expensive rate limiter path too, but the validation error
  // should come through as 400 regardless
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /boolean/i);
});

test('invalid integer query returns 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/history?limit=abc`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /integer/i);
});

test('out-of-range integer returns 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/history?limit=999`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /between/i);
});

test('invalid export format returns 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/export/csv`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /format/i);
});

test('unknown location falls back to default', async () => {
  // getLocation() always returns LOCATIONS[0] for unknown IDs
  const res = await fetch(`http://127.0.0.1:${port}/api/severe?location=atlantis`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.location, 'Mt. Sterling, IL');
});

test('severe route supports selecting today explicitly', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/severe?day=today`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.selectedDay, 'today');
  assert.equal(body.selectedLabel, 'Today');
  assert.equal(body.selectedDate, localDateStr(new Date()));
});

test('severe route rejects unsupported day values', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/severe?day=weekend`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /today or tomorrow/i);
});

test('outcome without actual body returns 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/outcome`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-swarmcast-admin-key': adminKey
    },
    body: JSON.stringify({ date: '2025-06-01' })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /actual/i);
});

test('outcome with non-numeric high_temp returns 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/outcome`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-swarmcast-admin-key': adminKey
    },
    body: JSON.stringify({
      date: '2025-06-01',
      actual: { high_temp: 'hot', low_temp: 60 }
    })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /numeric/i);
});

// --- 404 handling ---

test('unknown route returns 404', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/nonexistent`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// --- Rate limiting ---

test('expensive route rate limiting triggers 429', async () => {
  // EXPENSIVE_ROUTE_LIMIT is set to 3 for this test suite.
  // We need a route that's rate-limited but doesn't require an LLM key.
  // /api/forecast/stream is expensive-rate-limited but it's SSE.
  // /api/forecast is expensive-rate-limited — it will fail with an LLM error
  // but the rate limiter fires first (it's middleware, runs before handler).
  // We need to exhaust the limit. The previous boolean validation test already
  // used one hit. Let's burn through the rest.
  const results = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/forecast/quick`);
    results.push(res.status);
  }

  // At least one should be 429 (rate limited)
  assert.ok(
    results.includes(429),
    `Expected at least one 429 in responses, got: ${results.join(', ')}`
  );

  // The 429 response should include Retry-After header
  const lastRes = await fetch(`http://127.0.0.1:${port}/api/forecast/quick`);
  if (lastRes.status === 429) {
    assert.ok(lastRes.headers.has('retry-after'), 'Expected Retry-After header on 429');
  }
});

// --- Security headers ---

test('security headers are present', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  assert.ok(res.headers.has('x-request-id'));
});

// --- Config endpoint ---

test('config endpoint reports admin protection', async () => {
  const cfg = await fetchJson('/api/config');
  assert.equal(cfg.ok, true);
  assert.equal(cfg.adminProtected, true);
  assert.equal(typeof cfg.version, 'string');
  assert.equal(typeof cfg.uptime, 'number');
});

// --- GET on admin routes works without key ---

test('GET on admin routes works without admin key', async () => {
  const schedule = await fetch(`http://127.0.0.1:${port}/api/schedule`);
  assert.equal(schedule.status, 200);

  const reputation = await fetch(`http://127.0.0.1:${port}/api/reputation`);
  assert.equal(reputation.status, 200);
});

// --- Helpers ---

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) {
      throw new Error(`Server exited early.\n${stderr}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for server.\n${stderr}`);
}

async function fetchJson(pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  assert.equal(response.ok, true, `Expected ${pathname} to succeed.`);
  return response.json();
}

function localDateStr(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}
