// Shape validators for LLM JSON responses.
// These don't enforce exact types everywhere — they ensure the critical
// fields exist and are roughly the right shape so downstream code
// doesn't silently produce undefined values.

export function validateAgentResult(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new LLMShapeError('Agent result must be an object.');
  }

  if (typeof parsed.confidence !== 'number' && typeof parsed.confidence !== 'string') {
    throw new LLMShapeError('Agent result missing "confidence".');
  }
  parsed.confidence = Number(parsed.confidence);
  if (!Number.isFinite(parsed.confidence)) {
    parsed.confidence = 50;
  }

  if (typeof parsed.reasoning !== 'string' || !parsed.reasoning) {
    throw new LLMShapeError('Agent result missing "reasoning".');
  }

  if (!parsed.prediction || typeof parsed.prediction !== 'object') {
    throw new LLMShapeError('Agent result missing "prediction" object.');
  }

  const pred = parsed.prediction;
  const requiredNumeric = ['high_temp', 'low_temp', 'precip_chance'];
  for (const field of requiredNumeric) {
    if (pred[field] == null) {
      throw new LLMShapeError(`Agent prediction missing "${field}".`);
    }
    pred[field] = Number(pred[field]);
    if (!Number.isFinite(pred[field])) {
      throw new LLMShapeError(`Agent prediction "${field}" is not a valid number.`);
    }
  }

  if (typeof pred.condition !== 'string') {
    pred.condition = 'Unknown';
  }
  if (typeof pred.severe_risk !== 'string') {
    pred.severe_risk = 'none';
  }

  return parsed;
}

export function validateConsensusResult(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new LLMShapeError('Consensus result must be an object.');
  }

  if (!parsed.consensus || typeof parsed.consensus !== 'object') {
    throw new LLMShapeError('Consensus result missing "consensus" object.');
  }

  const c = parsed.consensus;
  const requiredNumeric = ['high_temp', 'low_temp', 'precip_chance'];
  for (const field of requiredNumeric) {
    if (c[field] == null) {
      throw new LLMShapeError(`Consensus missing "${field}".`);
    }
    c[field] = Number(c[field]);
    if (!Number.isFinite(c[field])) {
      throw new LLMShapeError(`Consensus "${field}" is not a valid number.`);
    }
  }

  if (typeof c.condition !== 'string') {
    c.condition = 'Unknown';
  }
  if (typeof c.severe_risk !== 'string') {
    c.severe_risk = 'none';
  }

  if (parsed.overall_confidence != null) {
    parsed.overall_confidence = Number(parsed.overall_confidence);
    if (!Number.isFinite(parsed.overall_confidence)) {
      parsed.overall_confidence = 50;
    }
  } else {
    parsed.overall_confidence = 50;
  }

  if (parsed.agreement_score != null) {
    parsed.agreement_score = Number(parsed.agreement_score);
    if (!Number.isFinite(parsed.agreement_score)) {
      parsed.agreement_score = 50;
    }
  } else {
    parsed.agreement_score = 50;
  }

  if (typeof parsed.narrative !== 'string') {
    parsed.narrative = '';
  }

  if (!Array.isArray(parsed.convergence_points)) {
    parsed.convergence_points = [];
  }
  if (!Array.isArray(parsed.divergence_points)) {
    parsed.divergence_points = [];
  }
  if (!Array.isArray(parsed.watch_items)) {
    parsed.watch_items = [];
  }

  return parsed;
}

export class LLMShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMShapeError';
  }
}
