/**
 * Deliberately simple lexicon sentiment. It exists so the news component of the
 * score is grounded in something inspectable rather than an opaque model; it is
 * the first thing to replace with a real classifier.
 */

const positiveTerms: Record<string, number> = {
  surge: 0.8, surges: 0.8, soar: 0.9, soars: 0.9, rally: 0.7, rallies: 0.7,
  gain: 0.5, gains: 0.5, jump: 0.6, jumps: 0.6, climb: 0.5, climbs: 0.5,
  breakout: 0.7, bullish: 0.8, upgrade: 0.6, upgraded: 0.6, adoption: 0.6,
  approval: 0.7, approved: 0.7, partnership: 0.5, inflow: 0.6, inflows: 0.6,
  record: 0.5, high: 0.3, buy: 0.4, accumulate: 0.5, optimism: 0.6,
  breakthrough: 0.7, launch: 0.4, launches: 0.4, integration: 0.4,
  institutional: 0.4, etf: 0.3, upside: 0.6, recovery: 0.5, rebound: 0.6,
};

const negativeTerms: Record<string, number> = {
  plunge: -0.9, plunges: -0.9, crash: -1, crashes: -1, slump: -0.7, slumps: -0.7,
  fall: -0.5, falls: -0.5, drop: -0.5, drops: -0.5, decline: -0.5, declines: -0.5,
  bearish: -0.8, downgrade: -0.6, downgraded: -0.6, hack: -0.9, hacked: -0.9,
  exploit: -0.8, breach: -0.8, lawsuit: -0.7, sue: -0.6, sued: -0.6,
  ban: -0.8, banned: -0.8, crackdown: -0.7, investigation: -0.6, fraud: -0.9,
  outflow: -0.6, outflows: -0.6, liquidation: -0.7, liquidations: -0.7,
  selloff: -0.7, sell: -0.3, warning: -0.5, risk: -0.3, delay: -0.4,
  rejected: -0.6, halt: -0.6, halted: -0.6, downside: -0.6, capitulation: -0.8,
};

const negators = new Set(['not', 'no', 'never', "isn't", "doesn't", "won't", 'without', 'denies', 'denied']);
const intensifiers: Record<string, number> = { very: 1.3, hugely: 1.4, massively: 1.5, slightly: 0.6, modestly: 0.7 };

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Headline sentiment in -1..+1. Returns 0 when no lexicon term appears. */
export function scoreSentiment(text: string): number {
  const tokens = tokenize(text);
  let total = 0;
  let matches = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    const base = positiveTerms[token] ?? negativeTerms[token];
    if (base === undefined) continue;

    let value = base;
    const previous = i > 0 ? (tokens[i - 1] as string) : undefined;
    if (previous) {
      if (negators.has(previous)) value = -value * 0.8;
      const intensity = intensifiers[previous];
      if (intensity !== undefined) value *= intensity;
    }
    total += value;
    matches += 1;
  }

  if (matches === 0) return 0;
  // Mean rather than sum, so a long headline is not automatically more extreme.
  return Math.max(-1, Math.min(1, total / matches));
}

/**
 * Recency-weighted aggregate. A 2-hour-old headline should outweigh a
 * 20-hour-old one, so weight decays linearly to a 0.2 floor across the window.
 */
export function aggregateSentiment(
  items: readonly { sentiment: number; publishedAt: string }[],
  maxAgeHours: number,
  now = Date.now(),
): number {
  if (items.length === 0) return 0;
  let weightedTotal = 0;
  let weightSum = 0;
  for (const item of items) {
    const ageHours = (now - new Date(item.publishedAt).getTime()) / 3_600_000;
    if (ageHours > maxAgeHours || ageHours < 0) continue;
    const weight = Math.max(0.2, 1 - ageHours / maxAgeHours);
    weightedTotal += item.sentiment * weight;
    weightSum += weight;
  }
  if (weightSum === 0) return 0;
  return Math.max(-1, Math.min(1, weightedTotal / weightSum));
}
