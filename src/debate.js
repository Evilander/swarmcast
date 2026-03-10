// Debate round — agents respond to each other's predictions and the consensus

import { AGENTS } from './agents.js';
import { callLLM } from './llm.js';

export function buildDebatePrompt(agent, allResults, consensus, locationName, targetDate) {
  const otherPredictions = allResults
    .filter(r => r.id !== agent.id && r.result)
    .map(r => `${r.emoji} ${r.name} (${r.result.confidence}% conf): High ${r.result.prediction.high_temp}°F / Low ${r.result.prediction.low_temp}°F, ${r.result.prediction.condition}, precip ${r.result.prediction.precip_chance}%, severe: ${r.result.prediction.severe_risk}
  Reasoning: ${r.result.reasoning}
  Dissent: ${r.result.dissent}`)
    .join('\n\n');

  return `You are ${agent.name} (${agent.emoji}). You've already made your forecast. Now you're seeing what the other agents predicted.

=== YOUR ORIGINAL FORECAST ===
High: ${allResults.find(r => r.id === agent.id)?.result?.prediction?.high_temp}°F
Low: ${allResults.find(r => r.id === agent.id)?.result?.prediction?.low_temp}°F
Condition: ${allResults.find(r => r.id === agent.id)?.result?.prediction?.condition}
Precip: ${allResults.find(r => r.id === agent.id)?.result?.prediction?.precip_chance}%
Confidence: ${allResults.find(r => r.id === agent.id)?.result?.confidence}%
Reasoning: ${allResults.find(r => r.id === agent.id)?.result?.reasoning}

=== OTHER AGENTS' FORECASTS ===
${otherPredictions}

=== CONSENSUS ===
High: ${consensus.consensus.high_temp}°F / Low: ${consensus.consensus.low_temp}°F
Condition: ${consensus.consensus.condition}
Overall confidence: ${consensus.overall_confidence}%
Agreement score: ${consensus.agreement_score}%

=== YOUR TASK ===
React to the other predictions. Do you want to revise anything? Challenge something? Agree? Be specific.

Respond in this EXACT JSON format (no markdown, no code blocks, just JSON):
{
  "revised_confidence": <your new confidence 0-100, can stay same>,
  "revised_prediction": <null if no change, or { "high_temp": N, "low_temp": N, "condition": "...", "precip_chance": N } if you want to update>,
  "reaction": "<2-3 sentences reacting to other agents>",
  "strongest_agreement": "<which agent you most agree with and why, 1 sentence>",
  "strongest_challenge": "<which agent you most disagree with and why, 1 sentence>"
}`;
}

export async function runDebateRound(agentResults, consensus, locationName, targetDate) {
  console.log(`\n💬 Starting debate round...`);
  const startTime = Date.now();

  const successful = agentResults.filter(r => r.result);

  const debatePromises = successful.map(async (agentResult) => {
    const agent = AGENTS.find(a => a.id === agentResult.id);
    if (!agent) return null;

    try {
      const prompt = buildDebatePrompt(agent, agentResults, consensus, locationName, targetDate);
      const result = await callLLM(prompt);
      console.log(`  ${agent.emoji} ${agent.name} responded`);
      return {
        id: agent.id,
        name: agent.name,
        emoji: agent.emoji,
        color: agent.color,
        debate: result
      };
    } catch (err) {
      console.error(`  ❌ ${agent.name} debate failed:`, err.message);
      return {
        id: agent.id,
        name: agent.name,
        emoji: agent.emoji,
        color: agent.color,
        debate: null,
        error: err.message
      };
    }
  });

  const debateResults = (await Promise.all(debatePromises)).filter(Boolean);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`💬 Debate complete in ${elapsed}s\n`);

  return {
    round: 1,
    elapsed: parseFloat(elapsed),
    responses: debateResults
  };
}
