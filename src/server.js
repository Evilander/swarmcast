import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { config } from './config.js';
import { getCurrentAndForecast, summarizeWeatherData, getSevereParams, getNWSAlerts } from './weather.js';
import { runSwarm } from './swarm.js';
import { runDebateRound } from './debate.js';
import {
  getCalibrationStats,
  getStorageStatus,
  loadForecasts,
  loadForecastsForDate,
  loadScheduleConfig,
  saveForecast,
  saveOutcome,
  saveScheduleConfig
} from './storage.js';
import { setupSSE } from './stream.js';
import { getLocalForecasts } from './local-forecasts.js';
import { buildAccuracyReport, getActualWeather } from './accuracy.js';
import { LOCATIONS, getLocation } from './locations.js';
import { callLLM } from './llm.js';
import { batchUpdateReputation, getAgentWeights, getLeaderboard } from './reputation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, '..', 'public');
const ADMIN_HEADER = 'x-swarmcast-admin-key';
const EXPENSIVE_ROUTE_PATHS = [
  '/api/forecast',
  '/api/forecast/quick',
  '/api/forecast/all',
  '/api/forecast/multiday',
  '/api/forecast/stream',
  '/api/brief',
  '/api/severe/analysis'
];
const ADMIN_ROUTE_PATHS = [
  '/api/outcome',
  '/api/outcome/auto',
  '/api/reputation/score',
  '/api/schedule'
];

let latestForecast = null;
let requestSequence = 0;
let scheduledInterval = null;
let scheduleRunning = false;
let scheduleConfig = loadInitialScheduleConfig();

class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code || 'request_error';
    this.details = options.details || null;
  }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.server.trustProxy) {
    app.set('trust proxy', true);
  }

  app.use(assignRequestId);
  app.use(applySecurityHeaders);
  app.use(handleCors);
  app.use(express.json({ limit: config.server.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.server.jsonBodyLimit }));
  app.use(logRequests);
  app.use(EXPENSIVE_ROUTE_PATHS, createRateLimiter({
    windowMs: config.rateLimits.windowMs,
    maxRequests: config.rateLimits.expensiveRequests,
    bucket: 'expensive'
  }));
  app.use(ADMIN_ROUTE_PATHS, createRateLimiter({
    windowMs: config.rateLimits.windowMs,
    maxRequests: config.rateLimits.adminRequests,
    bucket: 'admin'
  }));
  app.use(ADMIN_ROUTE_PATHS, requireAdminIfConfigured);
  app.use(express.static(STATIC_DIR, {
    index: 'index.html',
    maxAge: config.nodeEnv === 'production' ? '1h' : 0
  }));

  app.get('/api/weather', handleAsync(async (req, res) => {
    const { latitude, longitude } = getRequestedCoordinates(req);
    const displayLocation = getDisplayLocation(req);
    const raw = await getCurrentAndForecast(latitude, longitude);
    const summary = summarizeWeatherData(raw);
    res.json({ ok: true, location: displayLocation, summary, raw });
  }));

  app.get('/api/forecast', handleAsync(async (req, res) => {
    const { latitude, longitude } = getRequestedCoordinates(req);
    const location = getDisplayLocation(req);
    const targetDate = getRequestedDate(req.query.date, getTomorrowDate());
    const withDebate = getBooleanQuery(req.query.debate, true);

    const raw = await getCurrentAndForecast(latitude, longitude);
    const summary = summarizeWeatherData(raw);
    const result = await runSwarm(summary, location, targetDate, {
      lat: latitude,
      lon: longitude
    });
    result.weather = summary;

    if (withDebate && result.consensus) {
      result.debate = await runDebateRound(result.agents, result.consensus, location, targetDate);
    }

    saveForecast(result);
    latestForecast = result;
    res.json({ ok: true, ...result });
  }));

  app.get('/api/forecast/quick', handleAsync(async (req, res) => {
    const { latitude, longitude } = getRequestedCoordinates(req);
    const location = getDisplayLocation(req);
    const targetDate = getRequestedDate(req.query.date, getTomorrowDate());

    const raw = await getCurrentAndForecast(latitude, longitude);
    const summary = summarizeWeatherData(raw);
    const result = await runSwarm(summary, location, targetDate, {
      lat: latitude,
      lon: longitude
    });
    result.weather = summary;

    saveForecast(result);
    latestForecast = result;
    res.json({ ok: true, ...result });
  }));

  app.get('/api/forecast/all', handleAsync(async (req, res) => {
    const targetDate = getRequestedDate(req.query.date, getTomorrowDate());
    const results = await Promise.allSettled(
      LOCATIONS.map(async (location) => {
        const raw = await getCurrentAndForecast(location.lat, location.lon);
        const summary = summarizeWeatherData(raw);
        const forecast = await runSwarm(summary, location.name, targetDate, {
          lat: location.lat,
          lon: location.lon
        });
        forecast.weather = summary;
        saveForecast(forecast);
        return { location, forecast, ok: true };
      })
    );

    res.json({
      ok: true,
      date: targetDate,
      results: results.map((entry, index) => (
        entry.status === 'fulfilled'
          ? entry.value
          : {
              location: LOCATIONS[index],
              ok: false,
              error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
            }
      ))
    });
  }));

  app.get('/api/forecast/multiday', handleAsync(async (req, res) => {
    const { latitude, longitude } = getRequestedCoordinates(req);
    const location = getDisplayLocation(req);
    const days = getIntegerQuery(req.query.days, { name: 'days', defaultValue: 3, min: 1, max: 5 });
    const raw = await getCurrentAndForecast(latitude, longitude);
    const summary = summarizeWeatherData(raw);

    const forecasts = [];
    for (let offset = 1; offset <= days; offset += 1) {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      const targetDate = localDateStr(date);
      const forecast = await runSwarm(summary, location, targetDate, {
        lat: latitude,
        lon: longitude
      });
      forecast.weather = summary;
      saveForecast(forecast);
      forecasts.push(forecast);
    }

    res.json({ ok: true, location, days: forecasts });
  }));

  app.get('/api/history', (req, res) => {
    const limit = getIntegerQuery(req.query.limit, { name: 'limit', defaultValue: 20, min: 1, max: 100 });
    res.json({ ok: true, forecasts: loadForecasts(limit) });
  });

  app.get('/api/history/:date', (req, res) => {
    const targetDate = getRequestedDate(req.params.date, null, { required: true });
    res.json({ ok: true, date: targetDate, forecasts: loadForecastsForDate(targetDate) });
  });

  app.post('/api/outcome', (req, res) => {
    const targetDate = getRequestedDate(req.body?.date, null, { required: true });
    const actual = normalizeOutcomePayload(req.body?.actual);
    saveOutcome(targetDate, actual);
    res.json({ ok: true, date: targetDate });
  });

  app.post('/api/outcome/auto', handleAsync(async (req, res) => {
    const { latitude, longitude } = getRequestedCoordinates(req);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const targetDate = localDateStr(yesterday);

    const raw = await getCurrentAndForecast(latitude, longitude);
    const summary = summarizeWeatherData(raw);
    const actualDay = summary.pastDays.find((day) => day.date === targetDate);
    if (!actualDay) {
      throw new HttpError(404, `No data found for ${targetDate}.`);
    }

    const actual = {
      high_temp: actualDay.high,
      low_temp: actualDay.low,
      condition: actualDay.condition,
      precip_sum: actualDay.precipSum,
      wind_max: actualDay.windMax
    };
    saveOutcome(targetDate, actual);

    const reputationUpdates = [];
    for (const forecast of loadForecastsForDate(targetDate)) {
      reputationUpdates.push(...batchUpdateReputation(forecast, {
        high: actualDay.high,
        low: actualDay.low,
        precip: actualDay.precipSum,
        windMax: actualDay.windMax
      }));
    }

    res.json({ ok: true, date: targetDate, actual, reputationUpdates });
  }));

  app.get('/api/calibration', (req, res) => {
    res.json({ ok: true, stats: getCalibrationStats() });
  });

  app.get('/api/local', handleAsync(async (req, res) => {
    const { latitude, longitude } = getRequestedCoordinates(req);
    const forecasts = await getLocalForecasts(latitude, longitude);
    res.json({ ok: true, forecasts });
  }));

  app.get('/api/locations', (req, res) => {
    res.json({ ok: true, locations: LOCATIONS, default: LOCATIONS[0]?.id || null });
  });

  app.get('/api/brief', handleAsync(async (req, res) => {
    const location = getLocationFromQuery(req.query.location || LOCATIONS[0]?.id);
    const raw = await getCurrentAndForecast(location.lat, location.lon);
    const summary = summarizeWeatherData(raw);

    let nwsDetail = '';
    try {
      const localForecasts = await getLocalForecasts(location.lat, location.lon);
      const nws = localForecasts.find((item) => item.source === 'nws');
      if (nws?.forecast) {
        nwsDetail = `NWS official forecast: ${nws.forecast.condition}, High ${nws.forecast.high}F, Wind ${nws.forecast.wind} ${nws.forecast.windDir}, Precip ${nws.forecast.precipProb}%. Detail: ${nws.forecast.detail}`;
      }
    } catch {
      nwsDetail = '';
    }

    let severeContext = '';
    try {
      const severeParams = await getSevereParams(location.lat, location.lon);
      const tomorrow = getTomorrowDate();
      const severeTomorrow = severeParams?.find((day) => day.date === tomorrow);
      if (severeTomorrow && severeTomorrow.maxCape >= 1000) {
        severeContext = `
SEVERE WEATHER DATA FOR TOMORROW:
Max CAPE: ${severeTomorrow.maxCape} J/kg
Peak instability: ${severeTomorrow.peakCapeTime || 'afternoon'}
Max wind gusts: ${severeTomorrow.maxGusts} mph
Severity level: ${severeTomorrow.severity.label}
${severeTomorrow.maxCape >= 2000 ? 'This is a significant severe weather day. Mention the severe threat prominently.' : ''}`;
      }
    } catch {
      severeContext = '';
    }

    const forecasts = loadForecasts(5);
    const recentForecast = forecasts.find((forecast) => forecast.location === location.name);
    let swarmContext = '';
    if (recentForecast?.consensus) {
      const consensus = recentForecast.consensus;
      swarmContext = `
SwarmCast prediction (${consensus.overall_confidence}% confidence, ${consensus.agreement_score}% agreement):
High ${consensus.consensus.high_temp}F / Low ${consensus.consensus.low_temp}F
Condition: ${consensus.consensus.condition}
Precip chance: ${consensus.consensus.precip_chance}%
Severe risk: ${consensus.consensus.severe_risk}
Narrative: ${consensus.narrative}
Key dissent: ${consensus.key_dissent || 'None'}
Watch items: ${(consensus.watch_items || []).join('; ')}`;
    }

    const briefPrompt = `You are a witty, warm weather briefer for a small-town morning newsletter in western Illinois. Write a 3-4 paragraph morning weather brief for ${location.name} that someone would enjoy reading with their coffee.

Current conditions right now:
Temperature: ${summary.current.temp}F (feels like ${summary.current.feelsLike}F)
Condition: ${summary.current.condition}
Humidity: ${summary.current.humidity}%
Wind: ${summary.current.windSpeed} mph

Today's forecast:
${summary.futureDays[0] ? `High ${summary.futureDays[0].high}F / Low ${summary.futureDays[0].low}F, ${summary.futureDays[0].condition}, Precip ${summary.futureDays[0].precipProb}%` : 'Not available'}

${nwsDetail}

${swarmContext}

${severeContext}

Tomorrow:
${summary.futureDays[1] ? `High ${summary.futureDays[1].high}F / Low ${summary.futureDays[1].low}F, ${summary.futureDays[1].condition}` : 'Not available'}

Guidelines:
- Start with the vibe: what does it feel like outside right now?
- Give practical advice about jacket, umbrella, or sunscreen decisions.
- If the swarm has dissenting opinions, mention it casually.
- If severe weather data shows elevated risk, lead with safety and timing without sounding alarmist.
- Keep it conversational but informative.
- Reference local landmarks or activities when relevant.
- End with a quick look-ahead at tomorrow.
- Respond with only the brief text, with no title or JSON.`;

    const brief = await callLLM(briefPrompt, {
      temperature: 0.8,
      raw: true,
      maxTokens: 1500
    });

    res.json({
      ok: true,
      location: location.name,
      brief,
      timestamp: new Date().toISOString()
    });
  }));

  app.get('/api/accuracy', handleAsync(async (req, res) => {
    const { latitude, longitude } = getRequestedCoordinates(req);
    res.json({ ok: true, ...(await buildAccuracyReport(latitude, longitude)) });
  }));

  app.get('/api/export/:format', (req, res) => {
    const format = String(req.params.format || '').trim().toLowerCase();
    if (!['text', 'json'].includes(format)) {
      throw new HttpError(400, 'Supported formats: text, json.');
    }

    const forecast = loadForecasts(1)[0];
    if (!forecast) {
      throw new HttpError(404, 'No forecasts available.');
    }

    if (format === 'json') {
      res.json({ ok: true, forecast });
      return;
    }

    const consensus = forecast.consensus;
    const lines = [
      `SwarmCast Forecast - ${forecast.location}`,
      `${forecast.targetDate}`,
      `Generated: ${new Date(forecast.timestamp).toLocaleString()}`,
      '',
      '=== CONSENSUS ===',
      `High: ${consensus.consensus.high_temp}F | Low: ${consensus.consensus.low_temp}F`,
      `${consensus.consensus.condition}`,
      `Precip: ${consensus.consensus.precip_chance}%`,
      `Wind: ${consensus.consensus.wind_max} mph`,
      `Severe Risk: ${consensus.consensus.severe_risk}`,
      `Confidence: ${consensus.overall_confidence}% | Agreement: ${consensus.agreement_score}%`,
      '',
      consensus.narrative,
      '',
      '=== AGENT BREAKDOWN ===',
      ...forecast.agents
        .filter((agent) => agent.result)
        .map((agent) => {
          const result = agent.result;
          return `${agent.emoji} ${agent.name} (${result.confidence}%): ${result.prediction.high_temp}F/${result.prediction.low_temp}F - ${result.reasoning}`;
        }),
      '',
      consensus.key_dissent && consensus.key_dissent !== 'None' ? `Key Dissent: ${consensus.key_dissent}` : '',
      '',
      `Generated by SwarmCast v${config.version}`
    ].filter(Boolean);

    res.type('text/plain').send(lines.join('\n'));
  });

  app.get('/api/severe', handleAsync(async (req, res) => {
    const location = getLocationFromQuery(req.query.location || LOCATIONS[0]?.id);
    const selection = resolveDateSelection(req.query, { defaultDay: 'tomorrow' });
    const [days, alerts] = await Promise.all([
      getSevereParams(location.lat, location.lon),
      getNWSAlerts(location.lat, location.lon)
    ]);
    const tomorrow = getTomorrowDate();
    const today = localDateStr(new Date());
    res.json({
      ok: true,
      location: location.name,
      alerts,
      days: days || [],
      today: findDayByDate(days, today),
      tomorrow: days?.find((day) => day.date === tomorrow) || null,
      selected: findDayByDate(days, selection.date),
      selectedDate: selection.date,
      selectedDay: selection.day,
      selectedLabel: selection.label,
      hasActiveAlerts: alerts.length > 0,
      timestamp: new Date().toISOString()
    });
  }));

  app.get('/api/severe/analysis', handleAsync(async (req, res) => {
    const location = getLocationFromQuery(req.query.location || LOCATIONS[0]?.id);
    const selection = resolveDateSelection(req.query, { defaultDay: 'tomorrow' });
    const [days, alerts, rawWeather] = await Promise.all([
      getSevereParams(location.lat, location.lon),
      getNWSAlerts(location.lat, location.lon),
      getCurrentAndForecast(location.lat, location.lon)
    ]);

    const summary = summarizeWeatherData(rawWeather);
    const severeDay = findDayByDate(days, selection.date);
    const forecastDay = summary.futureDays.find((day) => day.date === selection.date);

    const analysisPrompt = `You are a severe weather analyst for western Illinois. Analyze these conditions for ${location.name} on ${selection.date} and provide a detailed severe weather threat assessment.

CONVECTIVE PARAMETERS:
- Max CAPE: ${severeDay?.maxCape || 0} J/kg (peak at ${severeDay?.peakCapeTime || 'unknown'})
- Average CAPE: ${severeDay?.avgCape || 0} J/kg
- Max Wind Gusts: ${severeDay?.maxGusts || 0} mph
- Max Sustained Wind: ${severeDay?.maxWind || 0} mph
- Max Precip Probability: ${severeDay?.maxPrecipProb || 0}%
- Thunderstorm Hours (code >= 95): ${severeDay?.thunderstormHours || 0}
- Storm Hours (code >= 80): ${severeDay?.stormHours || 0}
- Severity Assessment: ${severeDay?.severity?.label || 'N/A'}

SURFACE CONDITIONS:
- Current Temp: ${summary.current.temp}F
- Humidity: ${summary.current.humidity}%
- Wind: ${summary.current.windSpeed} mph
- Pressure: ${summary.current.pressure} hPa

FORECAST:
- High: ${forecastDay?.high || '?'}F / Low: ${forecastDay?.low || '?'}F
- Condition: ${forecastDay?.condition || 'unknown'}
- Precip Prob: ${forecastDay?.precipProb || 0}%
- Wind Max: ${forecastDay?.windMax || 0} mph
- Gust Max: ${forecastDay?.gustMax || 0} mph

ACTIVE NWS ALERTS: ${alerts.length > 0 ? alerts.map((alert) => `${alert.event}: ${alert.headline}`).join('; ') : 'None'}

Respond with JSON:
{
  "threat_level": "none|marginal|slight|enhanced|moderate|high",
  "threat_summary": "1-2 sentence headline",
  "primary_threats": ["list of main threats"],
  "timing": "when the worst weather is expected",
  "cape_assessment": "what the CAPE values tell us",
  "wind_assessment": "wind threat analysis",
  "tornado_risk": "none|low|moderate|significant",
  "hail_risk": "none|low|moderate|significant",
  "flood_risk": "none|low|moderate|significant",
  "safety_actions": ["list of safety recommendations"],
  "confidence": 0-100,
  "peak_danger_window": "time range of highest risk"
}`;

    const analysis = await callLLM(analysisPrompt, { maxTokens: 1500 });
    res.json({
      ok: true,
      location: location.name,
      date: selection.date,
      day: selection.day,
      dateLabel: selection.label,
      convective: severeDay,
      alerts,
      analysis,
      timestamp: new Date().toISOString()
    });
  }));

  app.get('/api/reputation', (req, res) => {
    res.json({ ok: true, leaderboard: getLeaderboard(), weights: getAgentWeights() });
  });

  app.post('/api/reputation/score', handleAsync(async (req, res) => {
    const targetDate = getRequestedDate(req.body?.date, localDateStr(addDays(new Date(), -1)));
    const location = getLocationFromQuery(req.body?.location || LOCATIONS[0]?.id);
    const forecasts = loadForecastsForDate(targetDate);
    if (forecasts.length === 0) {
      throw new HttpError(404, `No forecasts found for ${targetDate}.`);
    }

    const actual = await getActualWeather(location.lat, location.lon, targetDate);
    if (!actual) {
      throw new HttpError(404, `No actual weather data found for ${targetDate}.`);
    }

    const agentScores = [];
    for (const forecast of forecasts) {
      agentScores.push(...batchUpdateReputation(forecast, actual));
    }

    res.json({
      ok: true,
      date: targetDate,
      actual,
      agentScores,
      updatedLeaderboard: getLeaderboard()
    });
  }));

  app.get('/api/schedule', (req, res) => {
    res.json({
      ok: true,
      ...scheduleConfig,
      active: Boolean(scheduledInterval),
      running: scheduleRunning
    });
  });

  app.post('/api/schedule', (req, res) => {
    const nextSchedule = validateScheduleConfig({
      enabled: req.body?.enabled ?? scheduleConfig.enabled,
      intervalHours: req.body?.intervalHours ?? scheduleConfig.intervalHours,
      locations: req.body?.locations ?? scheduleConfig.locations
    });

    scheduleConfig = saveScheduleConfig(nextSchedule);
    restartScheduler({ runNow: scheduleConfig.enabled });
    res.json({ ok: true, ...scheduleConfig, active: Boolean(scheduledInterval) });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      ok: true,
      location: config.weather.locationName,
      lat: config.weather.latitude,
      lon: config.weather.longitude,
      provider: config.llm.provider,
      agentCount: 5,
      uptime: Math.round(process.uptime()),
      version: config.version,
      adminProtected: config.admin.enabled
    });
  });

  app.get('/api/status', (req, res) => {
    res.json(buildReadinessSnapshot());
  });

  app.get('/api/ready', (req, res) => {
    const readiness = buildReadinessSnapshot();
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  setupSSE(app, async (latitude, longitude, options = {}) => {
    const raw = await getCurrentAndForecast(latitude, longitude, options);
    return summarizeWeatherData(raw);
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Route not found.' });
  });

  app.use((error, req, res, next) => {
    void next;
    const status = error instanceof HttpError ? error.status : 500;
    const response = {
      ok: false,
      error: error instanceof Error ? error.message : 'Unexpected server error.',
      code: error instanceof HttpError ? error.code : 'internal_error'
    };
    if (error instanceof HttpError && error.details) {
      response.details = error.details;
    }
    if (!(error instanceof HttpError)) {
      console.error(`[${req.id}]`, error);
    }
    res.status(status).json(response);
  });

  return app;
}

export function startServer() {
  restartScheduler({ runNow: scheduleConfig.enabled });
  const app = createApp();
  const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`SwarmCast ${config.version} listening on http://${config.server.host}:${config.server.port}`);
    for (const warning of config.warnings) {
      console.warn(`Warning: ${warning}`);
    }
  });

  server.requestTimeout = config.server.requestTimeoutMs;
  server.keepAliveTimeout = config.server.keepAliveTimeoutMs;
  server.headersTimeout = config.server.headersTimeoutMs;
  attachShutdownHandlers(server);
  return server;
}

function handleAsync(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function assignRequestId(req, res, next) {
  requestSequence += 1;
  req.id = `req_${Date.now().toString(36)}_${requestSequence.toString(36)}`;
  res.setHeader('X-Request-Id', req.id);
  next();
}

function applySecurityHeaders(req, res, next) {
  void req;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
}

function handleCors(req, res, next) {
  const allowedOrigin = config.server.allowedOrigin;
  const requestOrigin = req.get('origin');
  if (!allowedOrigin || !requestOrigin) {
    next();
    return;
  }

  res.setHeader('Vary', appendVaryHeader(res.getHeader('Vary'), 'Origin'));

  const originAllowed = allowedOrigin === '*' || requestOrigin === allowedOrigin;
  if (!originAllowed) {
    if (req.method === 'OPTIONS') {
      next(new HttpError(403, 'Origin not allowed.', { code: 'origin_not_allowed' }));
      return;
    }
    next();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin === '*' ? '*' : requestOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${ADMIN_HEADER}`);
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}

function logRequests(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    console.log(`[${req.id}] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
  });
  next();
}

function appendVaryHeader(existingValue, nextValue) {
  const values = new Set(
    String(existingValue || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  values.add(nextValue);
  return [...values].join(', ');
}

function createRateLimiter({ windowMs, maxRequests, bucket }) {
  const state = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${bucket}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const entry = state.get(key);

    if (!entry || entry.resetAt <= now) {
      state.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(maxRequests - 1));
      return next();
    }

    if (entry.count >= maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(new HttpError(429, 'Rate limit exceeded.'));
    }

    entry.count += 1;
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    next();
  };
}

function requireAdminIfConfigured(req, res, next) {
  void res;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  if (!config.admin.enabled) {
    next();
    return;
  }
  const key = req.get(ADMIN_HEADER);
  if (key !== config.admin.apiKey) {
    next(new HttpError(401, `Missing or invalid ${ADMIN_HEADER} header.`));
    return;
  }
  next();
}

function getRequestedCoordinates(req) {
  return {
    latitude: getNumberQuery(req.query.lat, {
      name: 'lat',
      defaultValue: config.weather.latitude,
      min: -90,
      max: 90
    }),
    longitude: getNumberQuery(req.query.lon, {
      name: 'lon',
      defaultValue: config.weather.longitude,
      min: -180,
      max: 180
    })
  };
}

function getDisplayLocation(req) {
  const raw = cleanString(req.query.location);
  if (!raw) {
    return config.weather.locationName;
  }
  const knownLocation = getLocation(raw);
  return knownLocation?.name || sanitizeString(raw, 'location', 100);
}

function getLocationFromQuery(value) {
  const locationId = cleanString(value);
  if (!locationId) {
    throw new HttpError(400, 'Location is required.');
  }
  const location = getLocation(locationId);
  if (!location) {
    throw new HttpError(400, `Unknown location "${locationId}".`);
  }
  return location;
}

function getRequestedDate(value, defaultValue, options = {}) {
  const date = cleanString(value) || defaultValue;
  if (!date) {
    if (options.required) {
      throw new HttpError(400, `${options.label || 'date'} is required.`);
    }
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new HttpError(400, `${options.label || 'date'} must be in YYYY-MM-DD format.`);
  }
  return date;
}

function resolveDateSelection(query, { defaultDay = 'tomorrow' } = {}) {
  const explicitDate = cleanString(query?.date);
  if (explicitDate) {
    const date = getRequestedDate(explicitDate, null, { required: true });
    return {
      date,
      day: getRelativeDateKey(date),
      label: getRelativeDateLabel(date)
    };
  }

  const day = cleanString(query?.day) || defaultDay;
  if (!['today', 'tomorrow'].includes(day)) {
    throw new HttpError(400, 'day must be either today or tomorrow.');
  }

  const date = day === 'today' ? localDateStr(new Date()) : getTomorrowDate();
  return {
    date,
    day,
    label: day === 'today' ? 'Today' : 'Tomorrow'
  };
}

function getBooleanQuery(value, defaultValue = false) {
  if (value == null || value === '') {
    return defaultValue;
  }
  const normalized = cleanString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new HttpError(400, `Invalid boolean value "${value}".`);
}

function getIntegerQuery(value, { name, defaultValue, min, max }) {
  if (value == null || value === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    throw new HttpError(400, `${name} must be an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw new HttpError(400, `${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function getNumberQuery(value, { name, defaultValue, min, max }) {
  if (value == null || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${name} must be numeric.`);
  }
  if (parsed < min || parsed > max) {
    throw new HttpError(400, `${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizeOutcomePayload(actual) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new HttpError(400, 'actual must be an object.');
  }

  return {
    high_temp: requireFiniteNumber(actual.high_temp, 'actual.high_temp'),
    low_temp: requireFiniteNumber(actual.low_temp, 'actual.low_temp'),
    condition: sanitizeString(actual.condition ?? 'Unknown', 'actual.condition', 120),
    precip_sum: optionalFiniteNumber(actual.precip_sum, 'actual.precip_sum', 0),
    wind_max: optionalFiniteNumber(actual.wind_max, 'actual.wind_max', 0)
  };
}

function requireFiniteNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${name} must be numeric.`);
  }
  return parsed;
}

function optionalFiniteNumber(value, name, defaultValue = null) {
  if (value == null || value === '') {
    return defaultValue;
  }
  return requireFiniteNumber(value, name);
}

function sanitizeString(value, name, maxLength) {
  const stringValue = cleanString(value);
  if (!stringValue) {
    throw new HttpError(400, `${name} must not be empty.`);
  }
  if (stringValue.length > maxLength) {
    throw new HttpError(400, `${name} must be at most ${maxLength} characters.`);
  }
  return stringValue;
}

function validateScheduleConfig(schedule) {
  const locations = Array.isArray(schedule.locations)
    ? [...new Set(schedule.locations.map((value) => sanitizeString(value, 'locations[]', 100)))]
    : [];
  if (locations.length === 0) {
    throw new HttpError(400, 'locations must contain at least one known location id.');
  }
  for (const locationId of locations) {
    if (!getLocation(locationId)) {
      throw new HttpError(400, `Unknown location "${locationId}" in schedule config.`);
    }
  }

  return {
    enabled: Boolean(schedule.enabled),
    intervalHours: Number.isFinite(Number(schedule.intervalHours))
      ? Math.max(1, Math.min(24, Math.round(Number(schedule.intervalHours))))
      : 6,
    locations
  };
}

function loadInitialScheduleConfig() {
  try {
    return validateScheduleConfig(loadScheduleConfig());
  } catch (error) {
    console.warn('Falling back to default schedule config:', error instanceof Error ? error.message : String(error));
    return {
      enabled: false,
      intervalHours: 6,
      locations: [LOCATIONS[0]?.id || 'mt-sterling']
    };
  }
}

function findDayByDate(days, targetDate) {
  return days?.find((day) => day.date === targetDate) || null;
}

function getRelativeDateKey(date) {
  if (date === localDateStr(new Date())) {
    return 'today';
  }
  if (date === getTomorrowDate()) {
    return 'tomorrow';
  }
  return null;
}

function getRelativeDateLabel(date) {
  const relative = getRelativeDateKey(date);
  if (relative === 'today') {
    return 'Today';
  }
  if (relative === 'tomorrow') {
    return 'Tomorrow';
  }

  const [year, month, day] = date.split('-').map((value) => Number.parseInt(value, 10));
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
}

function restartScheduler({ runNow = false } = {}) {
  if (scheduledInterval) {
    clearInterval(scheduledInterval);
    scheduledInterval = null;
  }

  if (!scheduleConfig.enabled) {
    return;
  }

  const intervalMs = scheduleConfig.intervalHours * 60 * 60 * 1000;
  scheduledInterval = setInterval(() => {
    void runScheduledForecast('interval');
  }, intervalMs);

  if (runNow) {
    void runScheduledForecast('startup');
  }
}

async function runScheduledForecast(trigger) {
  if (scheduleRunning) {
    console.warn(`Skipping scheduled run (${trigger}) because another run is still in progress.`);
    return;
  }

  scheduleRunning = true;
  try {
    const targetDate = getTomorrowDate();
    const locations = scheduleConfig.locations.map((locationId) => getLocation(locationId)).filter(Boolean);
    for (const location of locations) {
      const raw = await getCurrentAndForecast(location.lat, location.lon);
      const summary = summarizeWeatherData(raw);
      const forecast = await runSwarm(summary, location.name, targetDate, {
        lat: location.lat,
        lon: location.lon
      });
      forecast.weather = summary;
      saveForecast(forecast);
      latestForecast = forecast;
    }

    const yesterday = localDateStr(addDays(new Date(), -1));
    const firstLocation = locations[0];
    if (firstLocation) {
      const raw = await getCurrentAndForecast(firstLocation.lat, firstLocation.lon);
      const summary = summarizeWeatherData(raw);
      const actualDay = summary.pastDays.find((day) => day.date === yesterday);
      if (actualDay) {
        saveOutcome(yesterday, {
          high_temp: actualDay.high,
          low_temp: actualDay.low,
          condition: actualDay.condition,
          precip_sum: actualDay.precipSum,
          wind_max: actualDay.windMax
        });
        for (const forecast of loadForecastsForDate(yesterday)) {
          batchUpdateReputation(forecast, {
            high: actualDay.high,
            low: actualDay.low,
            precip: actualDay.precipSum,
            windMax: actualDay.windMax
          });
        }
      }
    }
  } catch (error) {
    console.error('Scheduled forecast failed:', error);
  } finally {
    scheduleRunning = false;
  }
}

function buildReadinessSnapshot() {
  const storage = getStorageStatus();
  const issues = [];
  if (!storage.ok) {
    issues.push(storage.error || 'Storage is not writable.');
  }
  if (config.llm.requireKey && !config.llm.hasConfiguredKey) {
    issues.push(`Configured provider "${config.llm.provider}" is missing an API key.`);
  }

  const memory = process.memoryUsage();
  return {
    ok: true,
    ready: issues.length === 0,
    status: issues.length === 0 ? 'ready' : 'degraded',
    version: config.version,
    nodeEnv: config.nodeEnv,
    uptime: Math.round(process.uptime()),
    provider: config.llm.provider,
    lastForecast: latestForecast?.timestamp || loadForecasts(1)[0]?.timestamp || null,
    memory: {
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024)
    },
    storage,
    schedule: {
      ...scheduleConfig,
      active: Boolean(scheduledInterval),
      running: scheduleRunning
    },
    warnings: config.warnings,
    issues
  };
}

function attachShutdownHandlers(server) {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`${signal} received, shutting down.`);
    if (scheduledInterval) {
      clearInterval(scheduledInterval);
      scheduledInterval = null;
    }

    const forceExit = setTimeout(() => {
      console.error('Graceful shutdown timed out; forcing exit.');
      process.exit(1);
    }, config.server.shutdownTimeoutMs);
    forceExit.unref();

    server.close((error) => {
      clearTimeout(forceExit);
      if (error) {
        console.error('Shutdown failed:', error);
        process.exit(1);
        return;
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
  });
}

function getTomorrowDate() {
  return localDateStr(addDays(new Date(), 1));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDateStr(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
