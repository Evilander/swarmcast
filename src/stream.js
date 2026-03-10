import { AGENTS, buildAgentPrompt, buildConsensusPrompt } from './agents.js';
import { buildDebatePrompt } from './debate.js';
import { callLLM } from './llm.js';
import { validateAgentResult, validateConsensusResult } from './llm-schemas.js';
import { config } from './config.js';
import { getLocalForecasts } from './local-forecasts.js';
import { getAgentWeights } from './reputation.js';
import { getSevereParams } from './weather.js';

export function setupSSE(app, getWeatherSummary) {
  app.get('/api/forecast/stream', async (req, res) => {
    const latitude = sanitizeNumber(req.query.lat, config.weather.latitude, -90, 90);
    const longitude = sanitizeNumber(req.query.lon, config.weather.longitude, -180, 180);
    const location = sanitizeLocation(req.query.location || config.weather.locationName);
    const date = sanitizeDate(req.query.date || getTomorrowDate());
    const debate = req.query.debate === 'true';

    const controller = new AbortController();
    let closed = false;
    req.on('close', () => {
      closed = true;
      controller.abort(new Error('Client disconnected.'));
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const heartbeat = setInterval(() => {
      if (!closed) {
        res.write(': keep-alive\n\n');
      }
    }, config.streaming.heartbeatMs);

    const send = (event, data) => {
      if (!closed && !res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      send('status', { phase: 'weather', message: 'Fetching weather data...' });
      const [summary, localForecasts, severeParams] = await Promise.all([
        getWeatherSummary(latitude, longitude, { signal: controller.signal }),
        getLocalForecasts(latitude, longitude, { signal: controller.signal }).catch(() => []),
        getSevereParams(latitude, longitude, { signal: controller.signal }).catch(() => null)
      ]);
      if (closed) {
        return;
      }

      send('weather', summary);
      const nwsForecast = localForecasts.find((forecast) => forecast.source === 'nws') || null;
      const severeData = severeParams?.find((day) => day.date === date) || null;

      if (severeData && severeData.severity?.level !== 'none') {
        send('status', {
          phase: 'severe',
          message: `Severe weather detected: CAPE ${severeData.maxCape} J/kg (${severeData.severity.label})`
        });
      }

      send('status', { phase: 'agents', message: 'Dispatching agents...' });
      const agentResults = [];

      await Promise.all(AGENTS.map(async (agent) => {
        send('agent_start', { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color });
        const startedAt = Date.now();
        try {
          const prompt = buildAgentPrompt(agent, summary, location, date, nwsForecast, severeData);
          const result = validateAgentResult(await callLLM(prompt, { signal: controller.signal }));
          const payload = {
            id: agent.id,
            name: agent.name,
            emoji: agent.emoji,
            color: agent.color,
            result,
            elapsed: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
            error: null
          };
          agentResults.push(payload);
          send('agent_done', payload);
          return payload;
        } catch (error) {
          const payload = {
            id: agent.id,
            name: agent.name,
            emoji: agent.emoji,
            color: agent.color,
            result: null,
            elapsed: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
            error: error instanceof Error ? error.message : String(error)
          };
          agentResults.push(payload);
          if (!controller.signal.aborted) {
            send('agent_error', payload);
          }
          return payload;
        }
      }));

      if (closed) {
        return;
      }

      const successful = agentResults.filter((result) => result.result);
      if (successful.length > 0) {
        send('status', { phase: 'consensus', message: 'Building consensus...' });
        const consensus = validateConsensusResult(await callLLM(
          buildConsensusPrompt(successful, location, date, getAgentWeights()),
          { signal: controller.signal }
        ));
        send('consensus', consensus);

        if (debate && successful.length > 1) {
          send('status', { phase: 'debate', message: 'Agents debating...' });
          await Promise.all(successful.map(async (result) => {
            const agent = AGENTS.find((entry) => entry.id === result.id);
            if (!agent) {
              return null;
            }

            try {
              const debateResult = await callLLM(
                buildDebatePrompt(agent, agentResults, consensus, location, date),
                { signal: controller.signal }
              );
              const payload = {
                id: agent.id,
                name: agent.name,
                emoji: agent.emoji,
                color: agent.color,
                debate: debateResult
              };
              send('debate_response', payload);
              return payload;
            } catch (error) {
              return {
                id: agent.id,
                name: agent.name,
                emoji: agent.emoji,
                color: agent.color,
                debate: null,
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }));
        }
      }

      send('complete', {
        timestamp: new Date().toISOString(),
        agentsSucceeded: successful.length,
        agentsFailed: agentResults.length - successful.length
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        send('error', {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) {
        res.end();
      }
    }
  });
}

function getTomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function sanitizeNumber(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return Number(fallback);
  }
  return parsed;
}

function sanitizeLocation(value) {
  const location = String(value || '').trim();
  return location ? location.slice(0, 100) : config.weather.locationName;
}

function sanitizeDate(value) {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : getTomorrowDate();
}
