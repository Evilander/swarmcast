// The SwarmCast orchestrator — runs all agents, builds consensus

import { AGENTS, buildAgentPrompt, buildConsensusPrompt } from './agents.js';
import { callLLM } from './llm.js';
import { getLocalForecasts } from './local-forecasts.js';
import { getAgentWeights } from './reputation.js';
import { getSevereParams } from './weather.js';

export async function runSwarm(weatherSummary, locationName, targetDate, locationCoords) {
  const startTime = Date.now();

  const lat = locationCoords?.lat || process.env.LATITUDE || '39.9870';
  const lon = locationCoords?.lon || process.env.LONGITUDE || '-90.7601';

  // Fetch NWS forecast + severe params in parallel
  let nwsForecast = null;
  let severeData = null;
  try {
    const [localForecasts, severeParams] = await Promise.all([
      getLocalForecasts(lat, lon).catch(() => []),
      getSevereParams(lat, lon).catch(() => null)
    ]);
    nwsForecast = localForecasts.find(f => f.source === 'nws') || null;
    // Find severe data for our target date
    if (severeParams) {
      severeData = severeParams.find(d => d.date === targetDate) || null;
    }
  } catch { /* external data unavailable */ }

  if (severeData?.severity?.level !== 'none') {
    console.log(`⚠️  Severe weather params detected: CAPE ${severeData?.maxCape} J/kg, Gusts ${severeData?.maxGusts} mph — ${severeData?.severity?.label}`);
  }

  // Run all agents in parallel
  console.log(`🐝 Dispatching ${AGENTS.length} agents...`);

  const agentPromises = AGENTS.map(async (agent) => {
    const agentStart = Date.now();
    console.log(`  ${agent.emoji} ${agent.name} analyzing...`);

    try {
      const prompt = buildAgentPrompt(agent, weatherSummary, locationName, targetDate, nwsForecast, severeData);
      const result = await callLLM(prompt);
      const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
      console.log(`  ${agent.emoji} ${agent.name} done (${elapsed}s) — confidence: ${result.confidence}%`);

      return {
        id: agent.id,
        name: agent.name,
        emoji: agent.emoji,
        color: agent.color,
        result,
        elapsed: parseFloat(elapsed),
        error: null
      };
    } catch (err) {
      console.error(`  ❌ ${agent.name} failed:`, err.message);
      return {
        id: agent.id,
        name: agent.name,
        emoji: agent.emoji,
        color: agent.color,
        result: null,
        elapsed: ((Date.now() - agentStart) / 1000),
        error: err.message
      };
    }
  });

  const agentResults = await Promise.all(agentPromises);
  const successful = agentResults.filter(r => r.result !== null);

  if (successful.length === 0) {
    throw new Error('All agents failed — no predictions to aggregate');
  }

  // Build consensus from successful agents
  console.log(`\n🧠 Building consensus from ${successful.length} agents...`);
  const consensusStart = Date.now();

  let consensus;
  if (successful.length === 1) {
    // Only one agent succeeded — use their prediction directly
    const solo = successful[0];
    consensus = {
      consensus: solo.result.prediction,
      overall_confidence: solo.result.confidence,
      agreement_score: 100,
      convergence_points: ['Single agent forecast — no comparison possible'],
      divergence_points: [],
      key_dissent: 'None — only one agent reporting',
      narrative: solo.result.reasoning,
      watch_items: [solo.result.wild_card]
    };
  } else {
    const agentWeights = getAgentWeights();
    const consensusPrompt = buildConsensusPrompt(successful, locationName, targetDate, agentWeights);
    consensus = await callLLM(consensusPrompt);
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Swarm complete in ${totalElapsed}s\n`);

  // Calculate agreement metrics from raw predictions
  const temps = successful.map(a => a.result.prediction.high_temp);
  const tempSpread = Math.max(...temps) - Math.min(...temps);

  const precipChances = successful.map(a => a.result.prediction.precip_chance);
  const precipSpread = Math.max(...precipChances) - Math.min(...precipChances);

  return {
    timestamp: new Date().toISOString(),
    location: locationName,
    targetDate,
    agents: agentResults,
    consensus,
    meta: {
      totalElapsed: parseFloat(totalElapsed),
      agentsSucceeded: successful.length,
      agentsFailed: agentResults.length - successful.length,
      tempSpread,
      precipSpread
    }
  };
}
