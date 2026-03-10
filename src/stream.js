// Server-Sent Events streaming for live agent analysis

import { AGENTS, buildAgentPrompt, buildConsensusPrompt } from './agents.js';
import { buildDebatePrompt } from './debate.js';
import { callLLM } from './llm.js';
import { getLocalForecasts } from './local-forecasts.js';
import { getSevereParams } from './weather.js';
import { getAgentWeights } from './reputation.js';

export function setupSSE(app, getWeatherSummary) {
  app.get('/api/forecast/stream', async (req, res) => {
    const { lat, lon, location, date, debate } = {
      lat: req.query.lat || process.env.LATITUDE || '41.8781',
      lon: req.query.lon || process.env.LONGITUDE || '-87.6298',
      location: req.query.location || process.env.LOCATION_NAME || 'Chicago, IL',
      date: req.query.date || getTomorrowDate(),
      debate: req.query.debate === 'true'
    };

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    function send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    try {
      send('status', { phase: 'weather', message: 'Fetching weather data...' });
      const [summary, nwsForecasts, severeParams] = await Promise.all([
        getWeatherSummary(lat, lon),
        getLocalForecasts(lat, lon).catch(() => []),
        getSevereParams(lat, lon).catch(() => null)
      ]);
      send('weather', summary);

      const nwsForecast = nwsForecasts.find(f => f.source === 'nws') || null;
      const severeData = severeParams?.find(d => d.date === date) || null;

      if (severeData && severeData.severity?.level !== 'none') {
        send('status', { phase: 'severe', message: 'Severe weather detected: CAPE ' + severeData.maxCape + ' J/kg (' + severeData.severity.label + ')' });
      }

      // Launch agents one-by-one with streaming status updates
      send('status', { phase: 'agents', message: 'Dispatching agents...' });
      const agentResults = [];

      // Run in parallel but report as they finish
      const promises = AGENTS.map(async (agent) => {
        send('agent_start', { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color });
        const start = Date.now();

        try {
          const prompt = buildAgentPrompt(agent, summary, location, date, nwsForecast, severeData);
          const result = await callLLM(prompt);
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);

          const agentResult = {
            id: agent.id,
            name: agent.name,
            emoji: agent.emoji,
            color: agent.color,
            result,
            elapsed: parseFloat(elapsed),
            error: null
          };

          agentResults.push(agentResult);
          send('agent_done', agentResult);
          return agentResult;
        } catch (err) {
          const agentResult = {
            id: agent.id,
            name: agent.name,
            emoji: agent.emoji,
            color: agent.color,
            result: null,
            elapsed: ((Date.now() - start) / 1000),
            error: err.message
          };
          agentResults.push(agentResult);
          send('agent_error', agentResult);
          return agentResult;
        }
      });

      await Promise.all(promises);

      // Build consensus
      const successful = agentResults.filter(r => r.result);
      if (successful.length > 0) {
        send('status', { phase: 'consensus', message: 'Building consensus...' });
        const agentWeights = getAgentWeights();
        const consensusPrompt = buildConsensusPrompt(successful, location, date, agentWeights);
        const consensus = await callLLM(consensusPrompt);
        send('consensus', consensus);

        // Run debate if requested
        if (debate && successful.length > 1) {
          send('status', { phase: 'debate', message: 'Agents debating...' });

          const debatePromises = successful.map(async (agentResult) => {
            const agent = AGENTS.find(a => a.id === agentResult.id);
            if (!agent) return null;
            try {
              const prompt = buildDebatePrompt(agent, agentResults, consensus, location, date);
              const result = await callLLM(prompt);
              const resp = { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, debate: result };
              send('debate_response', resp);
              return resp;
            } catch (err) {
              return { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, debate: null, error: err.message };
            }
          });

          await Promise.all(debatePromises);
        }
      }

      send('complete', {
        timestamp: new Date().toISOString(),
        agentsSucceeded: successful.length,
        agentsFailed: agentResults.length - successful.length
      });

    } catch (err) {
      send('error', { message: err.message });
    }

    res.end();
  });
}

function getTomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
