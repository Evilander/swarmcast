// Accuracy tracking — compare past predictions to actual outcomes
// This is what makes SwarmCast genuinely useful over time

import { loadForecasts } from './storage.js';
import { fetchWithTimeout } from './fetch-utils.js';

// Get actual weather for past dates from Open-Meteo archive
export async function getActualWeather(lat, lon, date, options = {}) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    start_date: date,
    end_date: date,
    daily: [
      'temperature_2m_max', 'temperature_2m_min',
      'precipitation_sum', 'wind_speed_10m_max',
      'weather_code'
    ].join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'America/Chicago'
  });

  const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${params}`, options);
  if (!res.ok) return null;
  const data = await res.json();

  if (!data.daily || !data.daily.time || data.daily.time.length === 0) return null;

  const WMO = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    61: 'Rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Snow', 73: 'Moderate snow', 75: 'Heavy snow',
    80: 'Rain showers', 81: 'Moderate showers', 82: 'Heavy showers',
    95: 'Thunderstorm', 96: 'T-storm w/ hail', 99: 'T-storm w/ heavy hail'
  };

  return {
    date,
    high: data.daily.temperature_2m_max[0],
    low: data.daily.temperature_2m_min[0],
    precip: data.daily.precipitation_sum[0],
    windMax: data.daily.wind_speed_10m_max[0],
    condition: WMO[data.daily.weather_code[0]] || 'Unknown'
  };
}

// Score a prediction against actual weather
function scorePrediction(predicted, actual) {
  if (!predicted || !actual) return null;

  const highError = Math.abs(predicted.high_temp - actual.high);
  const lowError = Math.abs(predicted.low_temp - actual.low);

  // Precip accuracy: did we correctly predict rain/no-rain?
  const predictedRain = predicted.precip_chance > 30;
  const actualRain = actual.precip > 0.01;
  const precipHit = predictedRain === actualRain;

  // Temperature grade
  const avgTempError = (highError + lowError) / 2;
  let tempGrade;
  if (avgTempError <= 2) tempGrade = 'A';
  else if (avgTempError <= 4) tempGrade = 'B';
  else if (avgTempError <= 7) tempGrade = 'C';
  else if (avgTempError <= 10) tempGrade = 'D';
  else tempGrade = 'F';

  return {
    highError: Math.round(highError * 10) / 10,
    lowError: Math.round(lowError * 10) / 10,
    avgTempError: Math.round(avgTempError * 10) / 10,
    tempGrade,
    precipHit,
    predictedRain,
    actualRain
  };
}

// Build a full accuracy report for recent forecasts
export async function buildAccuracyReport(lat, lon) {
  const forecasts = loadForecasts(30);

  // Only look at forecasts for dates that have already passed
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  const pastForecasts = forecasts.filter(f => f.targetDate < today);

  if (pastForecasts.length === 0) {
    return {
      message: 'No past forecasts to evaluate yet. Run forecasts daily and check back!',
      reports: [],
      summary: null
    };
  }

  // Group by target date (take latest forecast for each date)
  const byDate = {};
  for (const f of pastForecasts) {
    if (!byDate[f.targetDate] || f.timestamp > byDate[f.targetDate].timestamp) {
      byDate[f.targetDate] = f;
    }
  }

  const reports = [];

  for (const [date, forecast] of Object.entries(byDate)) {
    const actual = await getActualWeather(lat, lon, date);
    if (!actual) continue;

    // Score consensus
    const consensusScore = forecast.consensus?.consensus
      ? scorePrediction(forecast.consensus.consensus, actual)
      : null;

    // Score individual agents
    const agentScores = {};
    for (const agent of (forecast.agents || [])) {
      if (!agent.result?.prediction) continue;
      agentScores[agent.id] = {
        name: agent.name,
        emoji: agent.emoji,
        score: scorePrediction(agent.result.prediction, actual),
        confidence: agent.result.confidence
      };
    }

    // Find best and worst agent
    const scored = Object.values(agentScores).filter(a => a.score);
    let bestAgent = null, worstAgent = null;
    if (scored.length > 0) {
      scored.sort((a, b) => a.score.avgTempError - b.score.avgTempError);
      bestAgent = { name: scored[0].name, emoji: scored[0].emoji, error: scored[0].score.avgTempError };
      worstAgent = { name: scored[scored.length - 1].name, emoji: scored[scored.length - 1].emoji, error: scored[scored.length - 1].score.avgTempError };
    }

    reports.push({
      date,
      predicted: forecast.consensus?.consensus || null,
      actual,
      consensusScore,
      agentScores,
      bestAgent,
      worstAgent
    });
  }

  // Build summary stats
  const allConsensusScores = reports.filter(r => r.consensusScore).map(r => r.consensusScore);
  const summary = allConsensusScores.length > 0 ? {
    totalEvaluated: allConsensusScores.length,
    avgHighError: mean(allConsensusScores.map(s => s.highError)),
    avgLowError: mean(allConsensusScores.map(s => s.lowError)),
    avgTempError: mean(allConsensusScores.map(s => s.avgTempError)),
    precipAccuracy: Math.round((allConsensusScores.filter(s => s.precipHit).length / allConsensusScores.length) * 100),
    gradeDistribution: countGrades(allConsensusScores.map(s => s.tempGrade))
  } : null;

  // Per-agent leaderboard
  const agentLeaderboard = {};
  for (const report of reports) {
    for (const [id, agentScore] of Object.entries(report.agentScores)) {
      if (!agentScore.score) continue;
      if (!agentLeaderboard[id]) {
        agentLeaderboard[id] = { name: agentScore.name, emoji: agentScore.emoji, errors: [], precipHits: 0, total: 0 };
      }
      agentLeaderboard[id].errors.push(agentScore.score.avgTempError);
      agentLeaderboard[id].total++;
      if (agentScore.score.precipHit) agentLeaderboard[id].precipHits++;
    }
  }

  const leaderboard = Object.entries(agentLeaderboard)
    .map(([id, data]) => ({
      id,
      name: data.name,
      emoji: data.emoji,
      avgError: mean(data.errors),
      precipAccuracy: Math.round((data.precipHits / data.total) * 100),
      forecasts: data.total
    }))
    .sort((a, b) => a.avgError - b.avgError);

  return { reports, summary, leaderboard };
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

function countGrades(grades) {
  const counts = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const g of grades) counts[g] = (counts[g] || 0) + 1;
  return counts;
}
