// Persistent forecast storage — JSON files organized by date

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'forecasts');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function saveForecast(forecast) {
  ensureDir(DATA_DIR);
  const ts = new Date(forecast.timestamp).toISOString().replace(/[:.]/g, '-');
  const filename = `${forecast.targetDate}_${ts}.json`;
  const filepath = join(DATA_DIR, filename);
  writeFileSync(filepath, JSON.stringify(forecast, null, 2));
  console.log(`💾 Saved forecast to ${filename}`);
  return filename;
}

export function loadForecasts(limit = 50) {
  ensureDir(DATA_DIR);
  const files = readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  return files.map(f => {
    try {
      return JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function loadForecastsForDate(targetDate) {
  ensureDir(DATA_DIR);
  const files = readdirSync(DATA_DIR)
    .filter(f => f.startsWith(targetDate) && f.endsWith('.json'))
    .sort()
    .reverse();

  return files.map(f => {
    try {
      return JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// Save outcome data (actual weather) for calibration tracking
export function saveOutcome(date, actual) {
  const outDir = join(__dirname, '..', 'data', 'outcomes');
  ensureDir(outDir);
  const filepath = join(outDir, `${date}.json`);
  writeFileSync(filepath, JSON.stringify({ date, actual, recorded: new Date().toISOString() }, null, 2));
  console.log(`📊 Saved outcome for ${date}`);
}

export function loadOutcome(date) {
  const filepath = join(__dirname, '..', 'data', 'outcomes', `${date}.json`);
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}

// Calculate calibration stats: how close were predictions to outcomes?
export function getCalibrationStats() {
  const forecasts = loadForecasts(200);
  const outDir = join(__dirname, '..', 'data', 'outcomes');
  ensureDir(outDir);

  const stats = {
    totalForecasts: forecasts.length,
    withOutcomes: 0,
    tempErrors: [],
    precipHits: 0,
    precipTotal: 0,
    agentAccuracy: {}
  };

  for (const forecast of forecasts) {
    const outcome = loadOutcome(forecast.targetDate);
    if (!outcome) continue;

    stats.withOutcomes++;
    const actual = outcome.actual;

    // Consensus accuracy
    if (forecast.consensus?.consensus) {
      const c = forecast.consensus.consensus;
      if (actual.high_temp != null) {
        stats.tempErrors.push(Math.abs(c.high_temp - actual.high_temp));
      }
    }

    // Per-agent accuracy
    for (const agent of (forecast.agents || [])) {
      if (!agent.result) continue;
      if (!stats.agentAccuracy[agent.id]) {
        stats.agentAccuracy[agent.id] = { name: agent.name, emoji: agent.emoji, tempErrors: [], count: 0 };
      }
      const aa = stats.agentAccuracy[agent.id];
      aa.count++;
      if (actual.high_temp != null) {
        aa.tempErrors.push(Math.abs(agent.result.prediction.high_temp - actual.high_temp));
      }
    }
  }

  // Average errors
  stats.avgTempError = stats.tempErrors.length
    ? (stats.tempErrors.reduce((a, b) => a + b, 0) / stats.tempErrors.length).toFixed(1)
    : null;

  for (const id of Object.keys(stats.agentAccuracy)) {
    const aa = stats.agentAccuracy[id];
    aa.avgTempError = aa.tempErrors.length
      ? (aa.tempErrors.reduce((a, b) => a + b, 0) / aa.tempErrors.length).toFixed(1)
      : null;
  }

  return stats;
}
