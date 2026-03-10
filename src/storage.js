import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { config } from './config.js';

const DATA_DIR = config.dataDir;
const FORECAST_DIR = join(DATA_DIR, 'forecasts');
const OUTCOME_DIR = join(DATA_DIR, 'outcomes');
const SCHEDULE_FILE = join(DATA_DIR, 'schedule.json');

export const DEFAULT_SCHEDULE_CONFIG = Object.freeze({
  enabled: false,
  intervalHours: 6,
  locations: ['mt-sterling']
});

export function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function writeJsonAtomic(filepath, value) {
  ensureDir(dirname(filepath));
  const tempPath = `${filepath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, filepath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function saveForecast(forecast) {
  ensureDir(FORECAST_DIR);
  const ts = new Date(forecast.timestamp).toISOString().replace(/[:.]/g, '-');
  const filename = `${forecast.targetDate}_${ts}.json`;
  const filepath = join(FORECAST_DIR, filename);
  writeJsonAtomic(filepath, forecast);
  return filename;
}

export function loadForecasts(limit = 50) {
  ensureDir(FORECAST_DIR);
  return readdirSync(FORECAST_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((file) => readJsonFile(join(FORECAST_DIR, file)))
    .filter(Boolean);
}

export function loadForecastsForDate(targetDate) {
  ensureDir(FORECAST_DIR);
  return readdirSync(FORECAST_DIR)
    .filter((file) => file.startsWith(`${targetDate}_`) && file.endsWith('.json'))
    .sort()
    .reverse()
    .map((file) => readJsonFile(join(FORECAST_DIR, file)))
    .filter(Boolean);
}

export function saveOutcome(date, actual) {
  ensureDir(OUTCOME_DIR);
  const filepath = join(OUTCOME_DIR, `${date}.json`);
  writeJsonAtomic(filepath, {
    date,
    actual,
    recorded: new Date().toISOString()
  });
}

export function loadOutcome(date) {
  return readJsonFile(join(OUTCOME_DIR, `${date}.json`));
}

export function getCalibrationStats() {
  const forecasts = loadForecasts(200);
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
    if (!outcome) {
      continue;
    }

    stats.withOutcomes += 1;
    const actual = outcome.actual;

    if (forecast.consensus?.consensus && actual.high_temp != null) {
      stats.tempErrors.push(Math.abs(forecast.consensus.consensus.high_temp - actual.high_temp));
    }

    for (const agent of forecast.agents || []) {
      if (!agent.result) {
        continue;
      }
      if (!stats.agentAccuracy[agent.id]) {
        stats.agentAccuracy[agent.id] = {
          name: agent.name,
          emoji: agent.emoji,
          tempErrors: [],
          count: 0
        };
      }

      const agentStats = stats.agentAccuracy[agent.id];
      agentStats.count += 1;
      if (actual.high_temp != null) {
        agentStats.tempErrors.push(Math.abs(agent.result.prediction.high_temp - actual.high_temp));
      }
    }
  }

  stats.avgTempError = stats.tempErrors.length > 0
    ? (stats.tempErrors.reduce((sum, value) => sum + value, 0) / stats.tempErrors.length).toFixed(1)
    : null;

  for (const entry of Object.values(stats.agentAccuracy)) {
    entry.avgTempError = entry.tempErrors.length > 0
      ? (entry.tempErrors.reduce((sum, value) => sum + value, 0) / entry.tempErrors.length).toFixed(1)
      : null;
  }

  return stats;
}

export function loadScheduleConfig() {
  return normalizeScheduleConfig(readJsonFile(SCHEDULE_FILE) || DEFAULT_SCHEDULE_CONFIG);
}

export function saveScheduleConfig(scheduleConfig) {
  const normalized = normalizeScheduleConfig(scheduleConfig);
  writeJsonAtomic(SCHEDULE_FILE, normalized);
  return normalized;
}

export function getStorageStatus() {
  try {
    ensureDir(DATA_DIR);
    ensureDir(FORECAST_DIR);
    ensureDir(OUTCOME_DIR);
    return {
      ok: true,
      dataDir: DATA_DIR
    };
  } catch (error) {
    return {
      ok: false,
      dataDir: DATA_DIR,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function normalizeScheduleConfig(scheduleConfig = DEFAULT_SCHEDULE_CONFIG) {
  const intervalHours = Number.isFinite(Number(scheduleConfig.intervalHours))
    ? Number(scheduleConfig.intervalHours)
    : DEFAULT_SCHEDULE_CONFIG.intervalHours;
  const locations = Array.isArray(scheduleConfig.locations)
    ? [...new Set(scheduleConfig.locations.map((value) => String(value).trim()).filter(Boolean))]
    : DEFAULT_SCHEDULE_CONFIG.locations;

  return {
    enabled: Boolean(scheduleConfig.enabled),
    intervalHours: Math.max(1, Math.min(24, Math.round(intervalHours))),
    locations: locations.length > 0 ? locations : [...DEFAULT_SCHEDULE_CONFIG.locations]
  };
}

function readJsonFile(filepath) {
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}
