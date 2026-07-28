import type { EngineConfig, InstrumentConfig } from '../../config/schema.js';
import { atrSeries, clamp, roundTo } from '../../indicators/index.js';
import type {
  MarketSnapshot,
  OpenPosition,
  PortfolioState,
  PositionSizing,
  RiskCheckResult,
  TradePlan,
} from '../../types.js';

export interface CheckContext {
  config: EngineConfig;
  plan: TradePlan;
  snapshot: MarketSnapshot;
  instrument: InstrumentConfig;
  portfolio: PortfolioState;
  sizing: PositionSizing;
}

/**
 * Headroom against a limit, 0..1. A check that barely squeaks under its cap
 * scores near 0 and drags the memo's score down; that is deliberate, since
 * "technically allowed" and "comfortable" are different things.
 */
function marginFor(value: number, limit: number): number {
  if (limit <= 0) return 0;
  return clamp(1 - value / limit);
}

function marginForBand(value: number, min: number, max: number): number {
  if (value < min || value > max) return 0;
  const centre = (min + max) / 2;
  const halfWidth = (max - min) / 2;
  if (halfWidth <= 0) return 0;
  return clamp(1 - Math.abs(value - centre) / halfWidth);
}

/**
 * Check 1 — position size. The size the plan implies must not risk more than
 * the configured fraction of equity at the stop.
 */
export function positionSizeCheck(ctx: CheckContext): RiskCheckResult {
  const { config, portfolio, sizing } = ctx;
  const limitPct = config.account.riskPerTradePct;
  const limitAmount = portfolio.equity * limitPct;
  const value = sizing.riskAmount;
  // Sizing rounds down to the instrument's quantity step, so risk should land
  // at or under the limit. A breach means the step is too coarse for this stop.
  const pass = value <= limitAmount + 1e-6;

  return {
    check: 'position-size',
    pass,
    valueChecked: roundTo(value, 2),
    limit: roundTo(limitAmount, 2),
    margin: marginFor(value, limitAmount),
    countsTowardMargin: false,
    detail: pass
      ? `risking ${value.toFixed(2)} ${config.account.currency} (${(sizing.riskPctOfEquity * 100).toFixed(2)}% of ` +
        `${portfolio.equity.toFixed(2)}) against a ${(limitPct * 100).toFixed(2)}% cap of ${limitAmount.toFixed(2)}`
      : `risk of ${value.toFixed(2)} exceeds the ${(limitPct * 100).toFixed(2)}% per-trade cap of ` +
        `${limitAmount.toFixed(2)}; the instrument's minimum size step (${ctx.instrument.quantityStep}) is too ` +
        `coarse for a stop this tight`,
  };
}

/**
 * Check 2 — exposure limits. Three separate caps: this instrument, its
 * correlated group, and the whole book. Returns one result per cap so the audit
 * trail shows which one was tight.
 */
export function exposureChecks(ctx: CheckContext): RiskCheckResult[] {
  const { config, plan, portfolio, sizing, instrument } = ctx;
  const equity = portfolio.equity;

  const notionalFor = (predicate: (p: OpenPosition) => boolean) =>
    portfolio.openPositions.filter(predicate).reduce((acc, p) => acc + p.notional, 0);

  const instrumentExisting = notionalFor((p) => p.instrument === plan.instrument);
  const groupExisting = notionalFor((p) => p.correlationGroup === instrument.correlationGroup);
  const portfolioExisting = notionalFor(() => true);

  const build = (
    name: string,
    existing: number,
    limitPct: number,
    scope: string,
  ): RiskCheckResult => {
    const proposed = existing + sizing.notional;
    const limit = equity * limitPct;
    const pass = proposed <= limit + 1e-6;
    return {
      check: name,
      pass,
      valueChecked: roundTo(proposed, 2),
      limit: roundTo(limit, 2),
      margin: marginFor(proposed, limit),
      countsTowardMargin: true,
      detail: pass
        ? `${scope} exposure would be ${proposed.toFixed(2)} of a ${limit.toFixed(2)} cap ` +
          `(${(limitPct * 100).toFixed(0)}% of equity); ${existing.toFixed(2)} already open`
        : `${scope} exposure would reach ${proposed.toFixed(2)}, over the ${limit.toFixed(2)} cap ` +
          `(${(limitPct * 100).toFixed(0)}% of equity); ${existing.toFixed(2)} already open`,
    };
  };

  return [
    build('exposure-instrument', instrumentExisting, config.exposure.maxPerInstrumentPct, `${plan.instrument}`),
    build('exposure-group', groupExisting, config.exposure.maxPerGroupPct, `${instrument.correlationGroup} group`),
    build('exposure-portfolio', portfolioExisting, config.exposure.maxPortfolioPct, 'portfolio-wide'),
  ];
}

/**
 * Check 3 — drawdown. A breach blocks every new plan regardless of how good it
 * looks, which is the entire point of a drawdown limit.
 */
export function drawdownCheck(ctx: CheckContext): RiskCheckResult {
  const { config, portfolio } = ctx;
  const peak = Math.max(portfolio.peakEquity, portfolio.equity);
  const drawdown = peak > 0 ? (peak - portfolio.equity) / peak : 0;
  const limit = config.account.maxDrawdownPct;
  const pass = drawdown < limit;

  return {
    check: 'drawdown',
    pass,
    valueChecked: roundTo(drawdown, 4),
    limit: roundTo(limit, 4),
    margin: marginFor(drawdown, limit),
    countsTowardMargin: true,
    detail: pass
      ? `account is ${(drawdown * 100).toFixed(2)}% below its ${peak.toFixed(2)} peak, inside the ` +
        `${(limit * 100).toFixed(1)}% limit`
      : `account is ${(drawdown * 100).toFixed(2)}% below its ${peak.toFixed(2)} peak, at or past the ` +
        `${(limit * 100).toFixed(1)}% limit — all new plans are blocked until equity recovers`,
  };
}

/**
 * Check 4 — volatility regime. Compares current ATR to the instrument's own
 * recent norm. A "normal" 1.5-ATR stop in an instrument trading at 3x its usual
 * range is not a normal stop, so an abnormal reading blocks the plan.
 */
export function volatilityCheck(ctx: CheckContext): RiskCheckResult {
  const { config, snapshot } = ctx;
  const { atrPeriod, atrTimeframe, normalisationLookback, maxAtrRatio, minAtrRatio } = config.volatility;
  const context = snapshot.timeframes[atrTimeframe];

  if (!context) {
    return {
      check: 'volatility',
      pass: false,
      valueChecked: 0,
      limit: maxAtrRatio,
      margin: 0,
      countsTowardMargin: true,
      detail: `no ${atrTimeframe} data, so the volatility regime cannot be established`,
    };
  }

  const series = atrSeries(context.candles, atrPeriod);
  if (!series || series.length < 2) {
    return {
      check: 'volatility',
      pass: false,
      valueChecked: 0,
      limit: maxAtrRatio,
      margin: 0,
      countsTowardMargin: true,
      detail: `insufficient ${atrTimeframe} history to compute an ATR baseline (need ${atrPeriod + 2} candles)`,
    };
  }

  const current = series[series.length - 1] as number;
  const window = series.slice(Math.max(0, series.length - normalisationLookback));
  const baseline = window.reduce((a, b) => a + b, 0) / window.length;
  const ratio = baseline > 0 ? current / baseline : 0;
  const pass = ratio <= maxAtrRatio && ratio >= minAtrRatio;

  let detail: string;
  if (pass) {
    detail =
      `${atrTimeframe} ATR of ${current.toFixed(4)} is ${ratio.toFixed(2)}x its ${window.length}-period ` +
      `baseline of ${baseline.toFixed(4)}, inside the ${minAtrRatio}–${maxAtrRatio}x normal band`;
  } else if (ratio > maxAtrRatio) {
    detail =
      `${atrTimeframe} ATR of ${current.toFixed(4)} is ${ratio.toFixed(2)}x its baseline of ` +
      `${baseline.toFixed(4)}, above the ${maxAtrRatio}x ceiling — the instrument is abnormally volatile`;
  } else {
    detail =
      `${atrTimeframe} ATR of ${current.toFixed(4)} is only ${ratio.toFixed(2)}x its baseline of ` +
      `${baseline.toFixed(4)}, below the ${minAtrRatio}x floor — the instrument is too quiet for this setup`;
  }

  return {
    check: 'volatility',
    pass,
    valueChecked: roundTo(ratio, 3),
    limit: maxAtrRatio,
    margin: marginForBand(ratio, minAtrRatio, maxAtrRatio),
    countsTowardMargin: true,
    detail,
  };
}

/**
 * Check 5 — max loss. Two absolute ceilings the percentage-based sizing check
 * cannot express: worst case on this trade, and worst case for the day once
 * today's realised losses are counted.
 */
export function maxLossChecks(ctx: CheckContext): RiskCheckResult[] {
  const { config, portfolio, sizing } = ctx;
  const currency = config.account.currency;

  const perTradeLimit = config.maxLoss.perTradeAbsolute;
  const perTradePass = sizing.riskAmount <= perTradeLimit + 1e-6;

  const realisedLoss = Math.max(0, -portfolio.dayRealisedPnl);
  const dayWorstCase = realisedLoss + sizing.riskAmount;
  const perDayLimit = config.maxLoss.perDayAbsolute;
  const perDayPass = dayWorstCase <= perDayLimit + 1e-6;

  return [
    {
      check: 'max-loss-per-trade',
      pass: perTradePass,
      valueChecked: roundTo(sizing.riskAmount, 2),
      limit: roundTo(perTradeLimit, 2),
      margin: marginFor(sizing.riskAmount, perTradeLimit),
      countsTowardMargin: true,
      detail: perTradePass
        ? `worst case at the stop is ${sizing.riskAmount.toFixed(2)} ${currency}, inside the ` +
          `${perTradeLimit.toFixed(2)} per-trade ceiling`
        : `worst case at the stop is ${sizing.riskAmount.toFixed(2)} ${currency}, over the ` +
          `${perTradeLimit.toFixed(2)} per-trade ceiling`,
    },
    {
      check: 'max-loss-per-day',
      pass: perDayPass,
      valueChecked: roundTo(dayWorstCase, 2),
      limit: roundTo(perDayLimit, 2),
      margin: marginFor(dayWorstCase, perDayLimit),
      countsTowardMargin: true,
      detail: perDayPass
        ? `today's realised loss of ${realisedLoss.toFixed(2)} plus this trade's ${sizing.riskAmount.toFixed(2)} ` +
          `is ${dayWorstCase.toFixed(2)} ${currency}, inside the ${perDayLimit.toFixed(2)} daily ceiling`
        : `today's realised loss of ${realisedLoss.toFixed(2)} plus this trade's ${sizing.riskAmount.toFixed(2)} ` +
          `would reach ${dayWorstCase.toFixed(2)} ${currency}, over the ${perDayLimit.toFixed(2)} daily ceiling`,
    },
  ];
}
