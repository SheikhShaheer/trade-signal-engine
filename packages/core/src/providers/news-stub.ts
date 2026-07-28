import { createHash } from 'node:crypto';
import type { NewsItem } from '../types.js';
import { scoreSentiment } from './sentiment.js';
import type { NewsProvider } from './types.js';

/**
 * Offline news provider. Generates a deterministic headline set per instrument
 * per hour so the pipeline is fully runnable and testable without an API key,
 * and so replaying the same window twice produces the same news context.
 *
 * It is not a market signal. Swap in a real provider before trusting the
 * news component of any score.
 */

const templates: { text: string; slots: number }[] = [
  { text: '{label} volume climbs as traders position ahead of the weekly close', slots: 1 },
  { text: 'Analysts flag downside risk for {label} after a stalled rally', slots: 1 },
  { text: '{label} network activity hits a record high', slots: 1 },
  { text: 'Institutional inflows into {label} products continue for a third week', slots: 1 },
  { text: 'Regulatory investigation weighs on {label} sentiment', slots: 1 },
  { text: '{label} rebound gains pace on renewed adoption headlines', slots: 1 },
  { text: 'Exchange outflows accelerate for {label}', slots: 1 },
  { text: '{label} developers delay a planned upgrade', slots: 1 },
  { text: 'Derivatives liquidations spike across {label} markets', slots: 1 },
  { text: 'Quiet session for {label} as volatility compresses', slots: 1 },
];

function hashToInt(input: string): number {
  const digest = createHash('sha256').update(input).digest();
  return digest.readUInt32BE(0);
}

export class StubNewsProvider implements NewsProvider {
  readonly name = 'stub';

  constructor(private readonly now: () => number = () => Date.now()) {}

  async getNews(symbol: string, label: string, maxAgeHours: number): Promise<NewsItem[]> {
    const nowMs = this.now();
    const hourBucket = Math.floor(nowMs / 3_600_000);
    const seed = hashToInt(`${symbol}:${hourBucket}`);
    const count = seed % 4; // 0-3 headlines, so "no news" is a real outcome

    const items: NewsItem[] = [];
    for (let i = 0; i < count; i += 1) {
      const pick = hashToInt(`${symbol}:${hourBucket}:${i}`);
      const template = templates[pick % templates.length] as { text: string };
      const headline = template.text.replace('{label}', label);
      const ageHours = (pick % Math.max(1, Math.floor(maxAgeHours))) + (pick % 60) / 60;
      items.push({
        id: `stub-${symbol}-${hourBucket}-${i}`,
        headline,
        source: 'stub-feed',
        url: undefined,
        publishedAt: new Date(nowMs - ageHours * 3_600_000).toISOString(),
        sentiment: scoreSentiment(headline),
      });
    }

    return items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }
}
