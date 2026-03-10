import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getCurrentAndForecast, summarizeWeatherData, getSevereParams, getNWSAlerts } from './weather.js';
import { runSwarm } from './swarm.js';
import { runDebateRound } from './debate.js';
import { saveForecast, loadForecasts, loadForecastsForDate, saveOutcome, getCalibrationStats } from './storage.js';
import { setupSSE } from './stream.js';
import { getLocalForecasts } from './local-forecasts.js';
import { buildAccuracyReport } from './accuracy.js';
import { LOCATIONS, getLocation } from './locations.js';
import { callLLM } from './llm.js';
import { getLeaderboard, batchUpdateReputation, getAgentWeights } from './reputation.js';

// Load .env manually (no dotenv dependency)
import { readFileSync } from 'fs';
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env file, use system env */ }

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3777;
const LAT = process.env.LATITUDE || '41.8781';
const LON = process.env.LONGITUDE || '-87.6298';
const LOCATION = process.env.LOCATION_NAME || 'Chicago, IL';

app.use(express.static(join(__dirname, '..', 'public')));

// In-memory cache of latest forecast for quick access
let latestForecast = null;

// API: Get current weather data
app.get('/api/weather', async (req, res) => {
  try {
    const lat = req.query.lat || LAT;
    const lon = req.query.lon || LON;
    const raw = await getCurrentAndForecast(lat, lon);
    const summary = summarizeWeatherData(raw);
    res.json({ ok: true, location: LOCATION, summary, raw });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Run the swarm forecast
app.get('/api/forecast', async (req, res) => {
  try {
    const lat = req.query.lat || LAT;
    const lon = req.query.lon || LON;
    const location = req.query.location || LOCATION;
    const targetDate = req.query.date || getTomorrowDate();
    const withDebate = req.query.debate !== 'false';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🌐 SwarmCast forecast requested for ${location}`);
    console.log(`📅 Target: ${targetDate}`);
    console.log(`💬 Debate: ${withDebate ? 'yes' : 'no'}`);
    console.log(`${'═'.repeat(60)}\n`);

    const raw = await getCurrentAndForecast(lat, lon);
    const summary = summarizeWeatherData(raw);
    const result = await runSwarm(summary, location, targetDate, { lat, lon });
    result.weather = summary;

    // Run debate round if enabled
    if (withDebate && result.consensus) {
      result.debate = await runDebateRound(result.agents, result.consensus, location, targetDate);
    }

    // Save to disk
    saveForecast(result);
    latestForecast = result;

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Forecast error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Run a quick forecast without debate (faster)
app.get('/api/forecast/quick', async (req, res) => {
  try {
    const lat = req.query.lat || LAT;
    const lon = req.query.lon || LON;
    const location = req.query.location || LOCATION;
    const targetDate = req.query.date || getTomorrowDate();

    const raw = await getCurrentAndForecast(lat, lon);
    const summary = summarizeWeatherData(raw);
    const result = await runSwarm(summary, location, targetDate, { lat, lon });
    result.weather = summary;

    saveForecast(result);
    latestForecast = result;

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Forecast all locations at once (parallel)
app.get('/api/forecast/all', async (req, res) => {
  try {
    const targetDate = req.query.date || getTomorrowDate();
    console.log(`\n🌐 Forecasting ALL locations for ${targetDate}...`);

    const results = await Promise.allSettled(
      LOCATIONS.map(async (loc) => {
        const raw = await getCurrentAndForecast(loc.lat, loc.lon);
        const summary = summarizeWeatherData(raw);
        const result = await runSwarm(summary, loc.name, targetDate, { lat: loc.lat, lon: loc.lon });
        result.weather = summary;
        saveForecast(result);
        console.log(`  ✅ ${loc.name}: High ${result.consensus?.consensus?.high_temp}°F`);
        return { location: loc, forecast: result, ok: true };
      })
    );

    const mapped = results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { location: LOCATIONS[i], ok: false, error: r.reason?.message }
    );

    res.json({ ok: true, date: targetDate, results: mapped });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Multi-day forecast (3 days)
app.get('/api/forecast/multiday', async (req, res) => {
  try {
    const lat = req.query.lat || LAT;
    const lon = req.query.lon || LON;
    const location = req.query.location || LOCATION;
    const days = Math.min(parseInt(req.query.days) || 3, 5);

    const raw = await getCurrentAndForecast(lat, lon);
    const summary = summarizeWeatherData(raw);

    const results = [];
    for (let i = 1; i <= days; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const targetDate = localDateStr(d);
      console.log(`\n📅 Day ${i}: ${targetDate}`);

      const result = await runSwarm(summary, location, targetDate, { lat, lon });
      result.weather = summary;
      saveForecast(result);
      results.push(result);
    }

    res.json({ ok: true, location, days: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Get forecast history (from disk)
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const forecasts = loadForecasts(limit);
  res.json({ ok: true, forecasts });
});

// API: Get forecasts for a specific date
app.get('/api/history/:date', (req, res) => {
  const forecasts = loadForecastsForDate(req.params.date);
  res.json({ ok: true, date: req.params.date, forecasts });
});

// API: Record actual outcome for calibration
app.post('/api/outcome', (req, res) => {
  try {
    const { date, actual } = req.body;
    if (!date || !actual) {
      return res.status(400).json({ ok: false, error: 'date and actual fields required' });
    }
    saveOutcome(date, actual);
    res.json({ ok: true, date });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Auto-record yesterday's outcome from Open-Meteo
app.post('/api/outcome/auto', async (req, res) => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const date = localDateStr(yesterday);

    const lat = req.query.lat || LAT;
    const lon = req.query.lon || LON;
    const raw = await getCurrentAndForecast(lat, lon);
    const summary = summarizeWeatherData(raw);

    // Find yesterday in past days
    const yesterdayData = summary.pastDays.find(d => d.date === date);
    if (!yesterdayData) {
      return res.status(404).json({ ok: false, error: `No data found for ${date}` });
    }

    const actualData = {
      high_temp: yesterdayData.high,
      low_temp: yesterdayData.low,
      condition: yesterdayData.condition,
      precip_sum: yesterdayData.precipSum,
      wind_max: yesterdayData.windMax
    };
    saveOutcome(date, actualData);

    // Auto-score agent reputation against actuals
    const pastForecasts = loadForecastsForDate(date);
    let reputationUpdates = [];
    for (const forecast of pastForecasts) {
      const results = batchUpdateReputation(forecast, {
        high: yesterdayData.high,
        low: yesterdayData.low,
        precip: yesterdayData.precipSum,
        windMax: yesterdayData.windMax
      });
      reputationUpdates.push(...results);
    }

    res.json({ ok: true, date, actual: yesterdayData, reputationUpdates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Calibration stats
app.get('/api/calibration', (req, res) => {
  const stats = getCalibrationStats();
  res.json({ ok: true, stats });
});

// API: Get local station forecasts for comparison
app.get('/api/local', async (req, res) => {
  try {
    const lat = req.query.lat || LAT;
    const lon = req.query.lon || LON;
    const forecasts = await getLocalForecasts(lat, lon);
    res.json({ ok: true, forecasts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SSE streaming endpoint
setupSSE(app, async (lat, lon) => {
  const raw = await getCurrentAndForecast(lat, lon);
  return summarizeWeatherData(raw);
});

// API: Available locations
app.get('/api/locations', (req, res) => {
  res.json({ ok: true, locations: LOCATIONS, default: LOCATIONS[0].id });
});

// API: Morning weather brief — conversational forecast for reading with coffee
app.get('/api/brief', async (req, res) => {
  try {
    const locId = req.query.location || 'mt-sterling';
    const loc = getLocation(locId);
    const lat = loc.lat;
    const lon = loc.lon;

    // Get weather data
    const raw = await getCurrentAndForecast(lat, lon);
    const summary = summarizeWeatherData(raw);

    // Get NWS forecast
    let nwsDetail = '';
    try {
      const localForecasts = await getLocalForecasts(lat, lon);
      const nws = localForecasts.find(f => f.source === 'nws');
      if (nws?.forecast) {
        nwsDetail = `NWS official forecast: ${nws.forecast.condition}, High ${nws.forecast.high}°F, Wind ${nws.forecast.wind} ${nws.forecast.windDir}, Precip ${nws.forecast.precipProb}%. Detail: ${nws.forecast.detail}`;
      }
    } catch { /* NWS unavailable */ }

    // Get severe weather params
    let severeContext = '';
    try {
      const severeParams = await getSevereParams(lat, lon);
      const tomorrow = getTomorrowDate();
      const tmrw = severeParams?.find(d => d.date === tomorrow);
      if (tmrw && tmrw.maxCape >= 1000) {
        severeContext = `
SEVERE WEATHER DATA FOR TOMORROW:
Max CAPE: ${tmrw.maxCape} J/kg (${tmrw.maxCape >= 2500 ? 'EXTREME instability' : tmrw.maxCape >= 1500 ? 'strong instability' : 'moderate instability'})
Peak instability: ${tmrw.peakCapeTime || 'afternoon'}
Max wind gusts: ${tmrw.maxGusts} mph
Severity level: ${tmrw.severity.label}
${tmrw.maxCape >= 2000 ? 'THIS IS A SIGNIFICANT SEVERE WEATHER DAY. Mention the severe threat prominently.' : ''}`;
      }
    } catch { /* severe data unavailable */ }

    // Get latest swarm forecast if available
    const forecasts = loadForecasts(5);
    const latest = forecasts.find(f => f.location === loc.name);
    let swarmContext = '';
    if (latest?.consensus) {
      const c = latest.consensus;
      swarmContext = `
SwarmCast prediction (${c.overall_confidence}% confidence, ${c.agreement_score}% agreement):
High ${c.consensus.high_temp}°F / Low ${c.consensus.low_temp}°F
Condition: ${c.consensus.condition}
Precip chance: ${c.consensus.precip_chance}%
Severe risk: ${c.consensus.severe_risk}
Narrative: ${c.narrative}
Key dissent: ${c.key_dissent || 'None'}
Watch items: ${(c.watch_items || []).join('; ')}`;
    }

    const briefPrompt = `You are a witty, warm weather briefer for a small-town morning newsletter in western Illinois. Write a 3-4 paragraph morning weather brief for ${loc.name} that someone would enjoy reading with their coffee.

Current conditions right now:
Temperature: ${summary.current.temp}°F (feels like ${summary.current.feelsLike}°F)
Condition: ${summary.current.condition}
Humidity: ${summary.current.humidity}%
Wind: ${summary.current.windSpeed} mph

Today's forecast:
${summary.futureDays[0] ? `High ${summary.futureDays[0].high}°F / Low ${summary.futureDays[0].low}°F, ${summary.futureDays[0].condition}, Precip ${summary.futureDays[0].precipProb}%` : 'Not available'}

${nwsDetail}

${swarmContext}

${severeContext}

Tomorrow:
${summary.futureDays[1] ? `High ${summary.futureDays[1].high}°F / Low ${summary.futureDays[1].low}°F, ${summary.futureDays[1].condition}` : 'Not available'}

Guidelines:
- Start with the vibe: what's it feel like out there right now?
- Practical advice: jacket? umbrella? sunscreen?
- If the swarm has dissenting opinions, mention it casually ("though our contrarian thinks...")
- If severe weather data shows high CAPE or severe risk, lead with safety and timing — but keep it conversational, not alarmist
- Keep it conversational but informative
- Reference local landmarks or activities when relevant (Mississippi River, farming, commute to Quincy)
- End with a quick look-ahead at tomorrow
- No JSON, no structured data — just flowing prose

Respond with ONLY the brief text, no labels or headers.`;

    const briefText = await callLLM(briefPrompt, { temperature: 0.8, raw: true, maxTokens: 1500 });
    res.json({
      ok: true,
      location: loc.name,
      brief: briefText,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Accuracy report — how good have our predictions been?
app.get('/api/accuracy', async (req, res) => {
  try {
    const lat = req.query.lat || LAT;
    const lon = req.query.lon || LON;
    const report = await buildAccuracyReport(lat, lon);
    res.json({ ok: true, ...report });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Export forecast as shareable text
app.get('/api/export/:format', (req, res) => {
  const forecasts = loadForecasts(1);
  if (forecasts.length === 0) {
    return res.status(404).json({ ok: false, error: 'No forecasts available' });
  }

  const f = forecasts[0];
  const c = f.consensus;

  if (req.params.format === 'text') {
    const lines = [
      `🐝 SwarmCast Forecast — ${f.location}`,
      `📅 ${f.targetDate}`,
      `⏰ Generated: ${new Date(f.timestamp).toLocaleString()}`,
      '',
      `═══ CONSENSUS ═══`,
      `🌡️ High: ${c.consensus.high_temp}°F | Low: ${c.consensus.low_temp}°F`,
      `🌤️ ${c.consensus.condition}`,
      `🌧️ Precip: ${c.consensus.precip_chance}%`,
      `💨 Wind: ${c.consensus.wind_max} mph`,
      `⚠️ Severe Risk: ${c.consensus.severe_risk}`,
      `📊 Confidence: ${c.overall_confidence}% | Agreement: ${c.agreement_score}%`,
      '',
      c.narrative,
      '',
      `═══ AGENT BREAKDOWN ═══`,
      ...f.agents.filter(a => a.result).map(a => {
        const r = a.result;
        return `${a.emoji} ${a.name} (${r.confidence}%): ${r.prediction.high_temp}°/${r.prediction.low_temp}° — ${r.reasoning}`;
      }),
      '',
      c.key_dissent && c.key_dissent !== 'None' ? `⚡ Key Dissent: ${c.key_dissent}` : '',
      '',
      `Generated by SwarmCast v0.1.0 — Multi-Agent Weather Prediction`
    ];

    res.type('text/plain').send(lines.filter(l => l !== undefined).join('\n'));
  } else if (req.params.format === 'json') {
    res.json({ ok: true, forecast: f });
  } else {
    res.status(400).json({ ok: false, error: 'Supported formats: text, json' });
  }
});

// API: Severe weather outlook — convective params + NWS alerts
app.get('/api/severe', async (req, res) => {
  try {
    const locId = req.query.location || 'mt-sterling';
    const loc = getLocation(locId);

    const [severeParams, alerts] = await Promise.all([
      getSevereParams(loc.lat, loc.lon),
      getNWSAlerts(loc.lat, loc.lon)
    ]);

    // Find tomorrow's severe data
    const tomorrow = getTomorrowDate();
    const tomorrowSevere = severeParams?.find(d => d.date === tomorrow);

    res.json({
      ok: true,
      location: loc.name,
      alerts,
      days: severeParams || [],
      tomorrow: tomorrowSevere || null,
      hasActiveAlerts: alerts.length > 0,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Severe weather analysis — LLM interprets the convective data
app.get('/api/severe/analysis', async (req, res) => {
  try {
    const locId = req.query.location || 'mt-sterling';
    const loc = getLocation(locId);

    const [severeParams, alerts, rawWeather] = await Promise.all([
      getSevereParams(loc.lat, loc.lon),
      getNWSAlerts(loc.lat, loc.lon),
      getCurrentAndForecast(loc.lat, loc.lon)
    ]);

    const summary = summarizeWeatherData(rawWeather);
    const tomorrow = getTomorrowDate();
    const tomorrowSevere = severeParams?.find(d => d.date === tomorrow);
    const tomorrowForecast = summary.futureDays.find(d => d.date === tomorrow);

    const analysisPrompt = `You are a severe weather analyst for western Illinois. Analyze these conditions for ${loc.name} on ${tomorrow} and provide a detailed severe weather threat assessment.

CONVECTIVE PARAMETERS:
- Max CAPE: ${tomorrowSevere?.maxCape || 0} J/kg (peak at ${tomorrowSevere?.peakCapeTime || 'unknown'})
- Average CAPE: ${tomorrowSevere?.avgCape || 0} J/kg
- Max Wind Gusts: ${tomorrowSevere?.maxGusts || 0} mph
- Max Sustained Wind: ${tomorrowSevere?.maxWind || 0} mph
- Max Precip Probability: ${tomorrowSevere?.maxPrecipProb || 0}%
- Thunderstorm Hours (code >= 95): ${tomorrowSevere?.thunderstormHours || 0}
- Storm Hours (code >= 80): ${tomorrowSevere?.stormHours || 0}
- Severity Assessment: ${tomorrowSevere?.severity?.label || 'N/A'}

SURFACE CONDITIONS:
- Current Temp: ${summary.current.temp}°F
- Humidity: ${summary.current.humidity}%
- Wind: ${summary.current.windSpeed} mph
- Pressure: ${summary.current.pressure} hPa

FORECAST:
- High: ${tomorrowForecast?.high || '?'}°F / Low: ${tomorrowForecast?.low || '?'}°F
- Condition: ${tomorrowForecast?.condition || 'unknown'}
- Precip Prob: ${tomorrowForecast?.precipProb || 0}%
- Wind Max: ${tomorrowForecast?.windMax || 0} mph
- Gust Max: ${tomorrowForecast?.gustMax || 0} mph

ACTIVE NWS ALERTS: ${alerts.length > 0 ? alerts.map(a => `${a.event}: ${a.headline}`).join('; ') : 'None'}

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
      location: loc.name,
      date: tomorrow,
      convective: tomorrowSevere,
      alerts,
      analysis,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Agent reputation leaderboard
app.get('/api/reputation', (req, res) => {
  const leaderboard = getLeaderboard();
  const weights = getAgentWeights();
  res.json({ ok: true, leaderboard, weights });
});

// API: Score agents against actuals and update reputation
app.post('/api/reputation/score', async (req, res) => {
  try {
    const { date } = req.body;
    const targetDate = date || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return localDateStr(d);
    })();

    const locId = req.body.location || 'mt-sterling';
    const loc = getLocation(locId);

    // Get the forecast for that date
    const forecasts = loadForecastsForDate(targetDate);
    if (forecasts.length === 0) {
      return res.status(404).json({ ok: false, error: `No forecasts found for ${targetDate}` });
    }

    // Get actual weather
    const { getActualWeather } = await import('./accuracy.js');
    const actual = await getActualWeather(loc.lat, loc.lon, targetDate);
    if (!actual) {
      return res.status(404).json({ ok: false, error: `No actual weather data for ${targetDate}` });
    }

    // Score each forecast's agents
    const allResults = [];
    for (const forecast of forecasts) {
      const results = batchUpdateReputation(forecast, actual);
      allResults.push(...results);
    }

    res.json({
      ok: true,
      date: targetDate,
      actual,
      agentScores: allResults,
      updatedLeaderboard: getLeaderboard()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Scheduled forecast system
let scheduledInterval = null;
let scheduleConfig = { enabled: false, intervalHours: 6, locations: ['mt-sterling'] };

async function runScheduledForecast() {
  const targetDate = getTomorrowDate();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`⏰ Scheduled forecast running at ${new Date().toLocaleTimeString()}`);
  console.log(`${'─'.repeat(50)}`);

  for (const locId of scheduleConfig.locations) {
    const loc = getLocation(locId);
    try {
      const raw = await getCurrentAndForecast(loc.lat, loc.lon);
      const summary = summarizeWeatherData(raw);
      const result = await runSwarm(summary, loc.name, targetDate, { lat: loc.lat, lon: loc.lon });
      result.weather = summary;
      saveForecast(result);
      console.log(`  ✅ ${loc.name}: High ${result.consensus?.consensus?.high_temp}°F`);
    } catch (err) {
      console.error(`  ❌ ${loc.name}: ${err.message}`);
    }
  }

  // Auto-record yesterday's outcome and score reputation
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = localDateStr(yesterday);
    const loc = getLocation(scheduleConfig.locations[0]);
    const raw = await getCurrentAndForecast(loc.lat, loc.lon);
    const summary = summarizeWeatherData(raw);
    const yData = summary.pastDays.find(d => d.date === yDate);
    if (yData) {
      saveOutcome(yDate, {
        high_temp: yData.high, low_temp: yData.low,
        condition: yData.condition, precip_sum: yData.precipSum, wind_max: yData.windMax
      });
      const pastForecasts = loadForecastsForDate(yDate);
      for (const f of pastForecasts) {
        batchUpdateReputation(f, { high: yData.high, low: yData.low, precip: yData.precipSum, windMax: yData.windMax });
      }
      console.log(`  📊 Auto-scored ${pastForecasts.length} forecasts for ${yDate}`);
    }
  } catch { /* outcome recording is best-effort */ }
}

// API: Schedule management
app.get('/api/schedule', (req, res) => {
  res.json({ ok: true, ...scheduleConfig, nextRun: scheduledInterval ? 'active' : 'stopped' });
});

app.post('/api/schedule', (req, res) => {
  const { enabled, intervalHours, locations } = req.body;

  if (enabled !== undefined) scheduleConfig.enabled = enabled;
  if (intervalHours) scheduleConfig.intervalHours = Math.max(1, Math.min(24, intervalHours));
  if (locations && Array.isArray(locations)) scheduleConfig.locations = locations;

  // Clear existing interval
  if (scheduledInterval) {
    clearInterval(scheduledInterval);
    scheduledInterval = null;
  }

  // Start new interval if enabled
  if (scheduleConfig.enabled) {
    const ms = scheduleConfig.intervalHours * 60 * 60 * 1000;
    scheduledInterval = setInterval(runScheduledForecast, ms);
    // Run immediately on enable
    runScheduledForecast();
    console.log(`⏰ Scheduled: every ${scheduleConfig.intervalHours}h for ${scheduleConfig.locations.join(', ')}`);
  }

  res.json({ ok: true, ...scheduleConfig });
});

// API: Server config
app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    location: LOCATION,
    lat: LAT,
    lon: LON,
    provider: process.env.LLM_PROVIDER || 'openai',
    agentCount: 5,
    uptime: Math.round(process.uptime()),
    version: '0.2.0'
  });
});

// API: Health check with uptime and memory
app.get('/api/status', (req, res) => {
  const mem = process.memoryUsage();
  const forecasts = loadForecasts(1);
  res.json({
    ok: true,
    status: 'healthy',
    uptime: Math.round(process.uptime()),
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
      rss: Math.round(mem.rss / 1024 / 1024) + ' MB'
    },
    lastForecast: forecasts[0]?.timestamp || null,
    schedule: scheduleConfig,
    provider: process.env.LLM_PROVIDER || 'openai'
  });
});

function getTomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDateStr(d);
}

function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║              🐝 SwarmCast v0.2.0                ║
║     Multi-Agent Weather Prediction Swarm        ║
╠══════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${PORT}             ║
║  Location:   ${LOCATION.padEnd(35)}║
║  Provider:   ${(process.env.LLM_PROVIDER || 'openai').padEnd(35)}║
║  Storage:    data/forecasts/                    ║
╚══════════════════════════════════════════════════╝
  `);
});
