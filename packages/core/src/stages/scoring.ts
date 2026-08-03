import type { EngineConfig } from '../config/schema.js';
import { clamp, normaliseRange, roundTo } from '../indicators/index.js';
import type {
  Decision,
  DecisionMemo,
  MarketSnapshot,
  RiskGateResult,
  ScoreComponent,
  SignalCandidate,
  TradePlan,
} from '../types.js';

/**
 * Stage 6. Combines five weighted components into a 0-10 score, then applies the
 * configured decision thresholds.
 *
 * The breakdown is part of the output, not an internal detail: a score a human
 * cannot take apart is a number they have no reason to trust.
 */
export class DecisionScorer {
  constructor(private readonly config: EngineConfig) {}

  score(
    candidate: SignalCandidate,
    plan: TradePlan,
    riskGate: RiskGateResult,
    snapshot: MarketSnapshot,
  ): { score: number; components: ScoreComponent[] } {
    const weights = this.config.scoring.weights;

    const components: ScoreComponent[] = [
      this.signalStrengthComponent(candidate, weights.signalStrength),
      this.trendAlignmentComponent(candidate, snapshot, weights.trendAlignment),
      this.riskRewardComponent(plan, weights.riskRewardQuality),
      this.riskGateMarginComponent(riskGate, weights.riskGateMargin),
      this.newsComponent(candidate, snapshot, weights.newsConfirmation),
    ];

    const score = roundTo(
      components.reduce((acc, c) => acc + c.contribution, 0),
      2,
    );
    return { score: clamp(score, 0, 10), components };
  }

  /**
   * Mean strength of triggered detectors, lifted by independent agreement.
   * Three detectors at 0.6 each is a stronger case than one at 0.8, because
   * they are looking at different things.
   */
  private signalStrengthComponent(candidate: SignalCandidate, weight: number): ScoreComponent {
    const triggered = candidate.triggeredDetectors.filter((d) => d.direction === candidate.direction);
    const meanStrength =
      triggered.length > 0 ? triggered.reduce((acc, d) => acc + d.strength, 0) / triggered.length : 0;

    const agreementBonus = Math.max(0, triggered.length - 1) * this.config.scoring.detectorAgreementBonus;
    const disagreementPenalty = candidate.disagreementCount * 0.15;
    const raw = clamp(meanStrength + agreementBonus - disagreementPenalty);

    const names = triggered.map((d) => d.name).join(', ') || 'none';
    return {
      component: 'signal-strength',
      weight,
      raw: roundTo(raw, 3),
      contribution: roundTo(raw * weight * 10, 3),
      basis:
        `${triggered.length} detector(s) agree (${names}) with mean strength ${meanStrength.toFixed(2)}` +
        (candidate.disagreementCount > 0 ? `; ${candidate.disagreementCount} detector(s) disagree` : ''),
    };
  }

  /**
   * With the higher-timeframe trend scores high, against it scores near zero.
   * A flat higher timeframe is neutral rather than a penalty: there is nothing
   * to be aligned with.
   */
  private trendAlignmentComponent(
    candidate: SignalCandidate,
    snapshot: MarketSnapshot,
    weight: number,
  ): ScoreComponent {
    const htfTrend = snapshot.higherTimeframeTrend;
    const context = snapshot.timeframes[this.config.detectors.trend.higherTimeframe];
    const separation = Math.abs(context?.trendStrength ?? 0);
    const conviction = normaliseRange(separation, this.config.detectors.trend.flatThresholdPct, 0.04);

    let raw: number;
    let basis: string;

    if (htfTrend === 'flat') {
      raw = 0.5;
      basis = `higher-timeframe (${this.config.detectors.trend.higherTimeframe}) trend is flat: neither aligned nor opposed`;
    } else if (candidate.counterTrend) {
      // A strongly trending higher timeframe makes a counter-trend idea worse,
      // not better, so conviction reduces the score here.
      raw = clamp(0.25 * (1 - conviction));
      basis =
        `counter-trend: ${candidate.direction} against a ${htfTrend} ` +
        `${this.config.detectors.trend.higherTimeframe} trend (${(separation * 100).toFixed(2)}% MA separation)`;
    } else {
      raw = clamp(0.6 + conviction * 0.4);
      basis =
        `aligned with the ${htfTrend} ${this.config.detectors.trend.higherTimeframe} trend ` +
        `(${(separation * 100).toFixed(2)}% MA separation)`;
    }

    return {
      component: 'trend-alignment',
      weight,
      raw: roundTo(raw, 3),
      contribution: roundTo(raw * weight * 10, 3),
      basis,
    };
  }

  private riskRewardComponent(plan: TradePlan, weight: number): ScoreComponent {
    const { riskRewardFloor, riskRewardCeiling } = this.config.scoring;
    const raw = normaliseRange(plan.riskRewardRatio, riskRewardFloor, riskRewardCeiling);
    return {
      component: 'risk-reward',
      weight,
      raw: roundTo(raw, 3),
      contribution: roundTo(raw * weight * 10, 3),
      basis:
        `computed R:R of ${plan.riskRewardRatio.toFixed(2)} to TP1 against a ${riskRewardFloor}–` +
        `${riskRewardCeiling} scoring band`,
    };
  }

  /** Headroom against risk limits. A plan that barely passes scores low here. */
  private riskGateMarginComponent(riskGate: RiskGateResult, weight: number): ScoreComponent {
    const raw = clamp(riskGate.aggregateMargin);
    // Only margin-relevant checks are averaged, so naming the tightest check
    // from the full list would contradict the number next to it.
    const relevant = riskGate.checks.filter((c) => c.countsTowardMargin);
    const tightest = [...relevant].sort((a, b) => a.margin - b.margin)[0];
    return {
      component: 'risk-gate-margin',
      weight,
      raw: roundTo(raw, 3),
      contribution: roundTo(raw * weight * 10, 3),
      basis: tightest
        ? `mean headroom ${(raw * 100).toFixed(0)}% across ${relevant.length} limit checks; ` +
          `tightest is ${tightest.check} at ${(tightest.margin * 100).toFixed(0)}%`
        : 'no limit checks contributed a margin',
    };
  }

  /**
   * Does news support or contradict the technical direction? No news is 0.5
   * (neutral), not 0 — absence of news is not evidence against the setup.
   */
  private newsComponent(candidate: SignalCandidate, snapshot: MarketSnapshot, weight: number): ScoreComponent {
    const sentiment = snapshot.news.aggregateSentiment;
    const count = snapshot.news.itemCount;

    if (count === 0) {
      return {
        component: 'news-confirmation',
        weight,
        raw: 0.5,
        contribution: roundTo(0.5 * weight * 10, 3),
        basis: `no headlines in the last ${this.config.data.newsMaxAgeHours}h from ${snapshot.news.provider}: treated as neutral`,
      };
    }

    // Signed agreement: positive sentiment supports a long, opposes a short.
    const directional = candidate.direction === 'long' ? sentiment : -sentiment;
    const raw = clamp((directional + 1) / 2);
    const verdict = directional > 0.15 ? 'supports' : directional < -0.15 ? 'contradicts' : 'is neutral on';

    return {
      component: 'news-confirmation',
      weight,
      raw: roundTo(raw, 3),
      contribution: roundTo(raw * weight * 10, 3),
      basis:
        `${count} headline(s) from ${snapshot.news.provider} with aggregate sentiment ` +
        `${sentiment >= 0 ? '+' : ''}${sentiment.toFixed(2)}, which ${verdict} the ${candidate.direction} case`,
    };
  }

  /**
   * A failed risk gate is rejected regardless of score. The score threshold
   * only ever chooses between approved and watchlist for plans that already
   * passed the gate.
   */
  decide(score: number, riskGatePassed: boolean): Decision {
    if (!riskGatePassed) return 'rejected';
    const { approve, watchlist } = this.effectiveThresholds();
    if (score >= approve) return 'approved';
    if (score >= watchlist) return 'watchlist';
    return 'rejected';
  }

  /** Override the file default; used when the operator changes the bar in Settings. */
  setApproveThreshold(threshold: number): void {
    this.approveThresholdOverride = threshold;
  }

  effectiveApproveThreshold(): number {
    return this.effectiveThresholds().approve;
  }

  private approveThresholdOverride?: number;

  private effectiveThresholds(): { approve: number; watchlist: number } {
    const base = this.config.scoring.thresholds;
    return {
      approve: this.approveThresholdOverride ?? base.approve,
      watchlist: base.watchlist,
    };
  }

  buildMemo(input: {
    candidate: SignalCandidate;
    plan: TradePlan;
    riskGate: RiskGateResult;
    snapshot: MarketSnapshot;
  }): DecisionMemo {
    const { candidate, plan, riskGate, snapshot } = input;
    const { score, components } = this.score(candidate, plan, riskGate, snapshot);
    const decision = this.decide(score, riskGate.overallPass);

    return {
      instrument: plan.instrument,
      planId: plan.id,
      direction: plan.direction,
      score,
      decision,
      tradePlan: plan,
      signalsFired: candidate.triggeredDetectors,
      riskGateResult: riskGate,
      scoreBreakdown: components,
      rationale: this.buildRationale({ candidate, plan, riskGate, snapshot, score, decision, components }),
      timestamp: new Date().toISOString(),
    };
  }

  /** Plain-English summary: what fired, what the plan is, and why this decision. */
  private buildRationale(input: {
    candidate: SignalCandidate;
    plan: TradePlan;
    riskGate: RiskGateResult;
    snapshot: MarketSnapshot;
    score: number;
    decision: Decision;
    components: ScoreComponent[];
  }): string {
    const { candidate, plan, riskGate, snapshot, score, decision, components } = input;
    const sentences: string[] = [];

    const names = candidate.triggeredDetectors
      .filter((d) => d.direction === candidate.direction)
      .map((d) => d.name);
    sentences.push(
      `${plan.instrument} ${plan.direction} on the ${plan.timeframe}: ` +
        `${names.length > 0 ? names.join(' + ') : 'no'} detector(s) fired, ` +
        `${candidate.counterTrend ? 'against' : 'with'} the ${snapshot.higherTimeframeTrend} higher-timeframe trend.`,
    );

    sentences.push(
      `Plan is entry ${plan.entryZone.low}–${plan.entryZone.high}, stop ${plan.stopLoss}, ` +
        `first target ${plan.targets[0]} for a computed ${plan.riskRewardRatio.toFixed(2)}:1; ` +
        `invalidated by a ${plan.invalidation}.`,
    );

    if (riskGate.overallPass) {
      sentences.push(
        `Risk gate passed all ${riskGate.checks.length} checks at ${riskGate.sizing.quantity} units ` +
          `(${riskGate.sizing.notional.toFixed(2)} notional, ${riskGate.sizing.riskAmount.toFixed(2)} at risk), ` +
          `with ${(riskGate.aggregateMargin * 100).toFixed(0)}% mean headroom.`,
      );
    } else {
      const failed = riskGate.checks.filter((c) => !c.pass);
      sentences.push(
        `Risk gate blocked this plan on ${failed.length} check(s): ` +
          `${failed.map((c) => c.detail).join('; ')}.`,
      );
    }

    const weakest = [...components].sort((a, b) => a.raw - b.raw)[0];
    const strongest = [...components].sort((a, b) => b.raw - a.raw)[0];
    const { approve, watchlist } = this.effectiveThresholds();
    const decisionReason =
      decision === 'rejected' && !riskGate.overallPass
        ? 'rejected because the risk gate failed, which overrides the score'
        : decision === 'rejected'
          ? `rejected because ${score.toFixed(2)} is below the ${watchlist} watchlist cutoff`
          : decision === 'watchlist'
            ? `queued to the watchlist: ${score.toFixed(2)} clears ${watchlist} but not the ${approve} approval bar`
            : `queued for approval: ${score.toFixed(2)} clears the ${approve} bar`;

    sentences.push(
      `Scored ${score.toFixed(2)}/10 and ${decisionReason}` +
        (strongest && weakest ? `; strongest component was ${strongest.component}, weakest was ${weakest.component}.` : '.'),
    );

    return sentences.join(' ');
  }
}
