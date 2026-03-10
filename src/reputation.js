// Agent Reputation System — tracks accuracy history and rewards agents
// Better agents get more weight in future consensus building

import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { ensureDir, writeJsonAtomic } from './storage.js';

const DATA_DIR = config.dataDir;
const REP_FILE = join(DATA_DIR, 'reputation.json');

function loadReputation() {
  try {
    ensureDir(DATA_DIR);
    return JSON.parse(readFileSync(REP_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveReputation(rep) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(REP_FILE, rep);
}

// Score an agent based on how close their prediction was to actual
function computeScore(predicted, actual) {
  if (!predicted || !actual) return null;

  const highError = Math.abs(predicted.high_temp - actual.high);
  const lowError = Math.abs(predicted.low_temp - actual.low);
  const avgTempError = (highError + lowError) / 2;

  // Precip accuracy
  const predictedRain = predicted.precip_chance > 30;
  const actualRain = actual.precip > 0.01;
  const precipCorrect = predictedRain === actualRain;

  // Wind accuracy (within 5mph = good)
  const windError = Math.abs((predicted.wind_max || 0) - (actual.windMax || 0));

  // Build composite score (0-100, higher = better)
  let score = 100;
  score -= avgTempError * 5;        // -5 per degree off
  score -= windError * 1;           // -1 per mph off on wind
  if (!precipCorrect) score -= 15;  // -15 for wrong rain call

  return {
    score: Math.max(0, Math.min(100, Math.round(score * 10) / 10)),
    tempError: Math.round(avgTempError * 10) / 10,
    highError: Math.round(highError * 10) / 10,
    lowError: Math.round(lowError * 10) / 10,
    windError: Math.round(windError * 10) / 10,
    precipCorrect
  };
}

// Update reputation after comparing forecast to actuals
export function updateReputation(agentId, agentName, emoji, predicted, actual, date) {
  const rep = loadReputation();

  if (!rep[agentId]) {
    rep[agentId] = {
      name: agentName,
      emoji,
      totalForecasts: 0,
      totalScore: 0,
      streak: 0, // consecutive good forecasts (tempError < 3)
      bestStreak: 0,
      recentScores: [], // last 10 scores
      badges: [],
      weight: 1.0, // consensus weight multiplier
      history: []
    };
  }

  const entry = rep[agentId];
  const result = computeScore(predicted, actual);
  if (!result) return;

  entry.totalForecasts++;
  entry.totalScore += result.score;

  // Update streak
  if (result.tempError <= 3) {
    entry.streak++;
    if (entry.streak > entry.bestStreak) entry.bestStreak = entry.streak;
  } else {
    entry.streak = 0;
  }

  // Recent scores (keep last 10)
  entry.recentScores.push(result.score);
  if (entry.recentScores.length > 10) entry.recentScores.shift();

  // Calculate weight based on recent performance
  const recentAvg = entry.recentScores.reduce((a, b) => a + b, 0) / entry.recentScores.length;
  // Weight ranges from 0.5 (terrible) to 2.0 (excellent)
  entry.weight = Math.round(Math.max(0.5, Math.min(2.0, recentAvg / 50)) * 100) / 100;

  // Award badges
  entry.badges = computeBadges(entry);

  // Save history entry
  entry.history.push({
    date,
    score: result.score,
    tempError: result.tempError,
    precipCorrect: result.precipCorrect,
    weight: entry.weight
  });
  // Keep last 30 entries
  if (entry.history.length > 30) entry.history = entry.history.slice(-30);

  saveReputation(rep);
  return { agentId, ...result, newWeight: entry.weight, streak: entry.streak };
}

function computeBadges(entry) {
  const badges = [];
  const avg = entry.totalScore / (entry.totalForecasts || 1);

  if (entry.bestStreak >= 7) badges.push({ id: 'hot_streak', label: '7-Day Streak', icon: '🔥' });
  if (entry.bestStreak >= 3) badges.push({ id: 'on_fire', label: '3-Day Streak', icon: '🎯' });
  if (avg >= 85) badges.push({ id: 'elite', label: 'Elite Forecaster', icon: '👑' });
  if (avg >= 70) badges.push({ id: 'reliable', label: 'Reliable', icon: '⭐' });
  if (entry.totalForecasts >= 30) badges.push({ id: 'veteran', label: 'Veteran', icon: '🏆' });
  if (entry.totalForecasts >= 10) badges.push({ id: 'experienced', label: 'Experienced', icon: '📈' });
  if (entry.weight >= 1.5) badges.push({ id: 'heavy_hitter', label: 'Heavy Hitter', icon: '💪' });

  return badges;
}

// Get all agent weights for consensus weighting
export function getAgentWeights() {
  const rep = loadReputation();
  const weights = {};
  for (const [id, entry] of Object.entries(rep)) {
    weights[id] = {
      weight: entry.weight,
      recentAvg: entry.recentScores.length > 0
        ? Math.round(entry.recentScores.reduce((a, b) => a + b, 0) / entry.recentScores.length * 10) / 10
        : 50,
      streak: entry.streak,
      totalForecasts: entry.totalForecasts
    };
  }
  return weights;
}

// Get full leaderboard
export function getLeaderboard() {
  const rep = loadReputation();
  return Object.entries(rep)
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      emoji: entry.emoji,
      avgScore: entry.totalForecasts > 0
        ? Math.round(entry.totalScore / entry.totalForecasts * 10) / 10
        : 0,
      recentAvg: entry.recentScores.length > 0
        ? Math.round(entry.recentScores.reduce((a, b) => a + b, 0) / entry.recentScores.length * 10) / 10
        : 0,
      weight: entry.weight,
      streak: entry.streak,
      bestStreak: entry.bestStreak,
      totalForecasts: entry.totalForecasts,
      badges: entry.badges,
      recentHistory: entry.history.slice(-5)
    }))
    .sort((a, b) => b.recentAvg - a.recentAvg);
}

// Batch update — run against all forecasts for a given date
export function batchUpdateReputation(forecast, actual) {
  if (!forecast?.agents || !actual) return [];

  const results = [];
  for (const agent of forecast.agents) {
    if (!agent.result?.prediction) continue;
    const r = updateReputation(
      agent.id, agent.name, agent.emoji,
      agent.result.prediction, actual,
      forecast.targetDate
    );
    if (r) results.push(r);
  }
  return results;
}

// Get reputation-weighted consensus inputs
export function getWeightedConsensusInfo() {
  const weights = getAgentWeights();
  return {
    weights,
    hasHistory: Object.keys(weights).length > 0,
    topAgent: Object.entries(weights).sort((a, b) => b[1].weight - a[1].weight)[0]?.[0] || null
  };
}
