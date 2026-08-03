import type { EngineConfig } from './schema.js';

/**
 * The single source of truth for every threshold in the engine.
 *
 * Defaults chosen with the operator: $10,000 equity, 1% risk per trade,
 * 10% max drawdown, crypto majors on Binance.
 */
export const defaultConfig: EngineConfig = {
  instruments: [
    { symbol: 'BTCUSDT', label: 'Bitcoin', correlationGroup: 'crypto-major', quantityStep: 0.00001, priceDecimals: 2 },
    { symbol: 'ETHUSDT', label: 'Ethereum', correlationGroup: 'crypto-major', quantityStep: 0.0001, priceDecimals: 2 },
    { symbol: 'SOLUSDT', label: 'Solana', correlationGroup: 'crypto-l1-alt', quantityStep: 0.001, priceDecimals: 3 },
    { symbol: 'BNBUSDT', label: 'BNB', correlationGroup: 'crypto-l1-alt', quantityStep: 0.001, priceDecimals: 2 },
    { symbol: 'XRPUSDT', label: 'XRP', correlationGroup: 'crypto-payments', quantityStep: 0.1, priceDecimals: 4 },
    { symbol: 'ADAUSDT', label: 'Cardano', correlationGroup: 'crypto-l1-alt', quantityStep: 0.1, priceDecimals: 4 },
    { symbol: 'AVAXUSDT', label: 'Avalanche', correlationGroup: 'crypto-l1-alt', quantityStep: 0.01, priceDecimals: 3 },
    { symbol: 'LINKUSDT', label: 'Chainlink', correlationGroup: 'crypto-infra', quantityStep: 0.01, priceDecimals: 3 },
  ],

  account: {
    startingEquity: 10_000,
    currency: 'USD',
    riskPerTradePct: 0.01,
    maxDrawdownPct: 0.1,
  },

  // Notional caps have to be read against the sizing maths, not chosen in
  // isolation: risking 1% of equity behind a 2% stop implies a 50% notional
  // position. Caps tighter than that would silently block almost every valid
  // plan rather than catching genuine over-concentration.
  exposure: {
    maxPerInstrumentPct: 0.6,
    maxPerGroupPct: 0.8,
    maxPortfolioPct: 1.0,
  },

  volatility: {
    atrPeriod: 14,
    atrTimeframe: '4h',
    normalisationLookback: 100,
    maxAtrRatio: 2.0,
    minAtrRatio: 0.3,
  },

  // Equity-relative ceilings: 1.5% per trade / 3% per day works the same on
  // a $10 account as on a $10,000 one. Absolute dollar caps would either
  // ignore tiny accounts or silently block larger ones.
  maxLoss: {
    perTradePctOfEquity: 0.015,
    perDayPctOfEquity: 0.03,
  },

  planning: {
    entryZoneAtrMultiple: 0.25,
    stopAtrMultiple: 1.5,
    targetRMultiples: [1.5, 2.5, 4],
    minAcceptableRiskReward: 1.0,
  },

  scoring: {
    weights: {
      signalStrength: 0.3,
      trendAlignment: 0.2,
      riskRewardQuality: 0.2,
      riskGateMargin: 0.15,
      newsConfirmation: 0.15,
    },
    riskRewardFloor: 1.5,
    riskRewardCeiling: 3.0,
    detectorAgreementBonus: 0.12,
    thresholds: {
      approve: 7.5,
      watchlist: 5.0,
    },
  },

  detectors: {
    breakout: { enabled: true, lookback: 20, minAtrClearance: 0.15, minVolumeRatio: 1.3 },
    pullback: { enabled: true, maPeriod: 20, maxAtrDistance: 0.5 },
    momentum: {
      enabled: true,
      rsiPeriod: 14,
      rsiBullish: 55,
      rsiBearish: 45,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      maxCounterImpulseRatio: 0.25,
    },
    trend: { enabled: true, higherTimeframe: '1d', fastMaPeriod: 50, slowMaPeriod: 200, flatThresholdPct: 0.005 },
    reversal: { enabled: true, rsiPeriod: 14, overbought: 70, oversold: 30, levelLookback: 30, minWickRatio: 0.5 },
  },

  scanner: {
    timeframes: ['15m', '1h', '4h', '1d'],
    candleLimit: 300,
    volumeAveragePeriod: 20,
    maPeriods: [20, 50, 200],
    keyLevelLookback: 60,
    levelProximityAtr: 0.5,
    volumeSpikeRatio: 1.5,
  },

  schedule: {
    pipelineIntervalSec: 300,
    newsIntervalSec: 900,
    jitterSec: 10,
    maxRunDurationSec: 240,
  },

  data: {
    requestSpacingMs: 250,
    requestTimeoutMs: 15_000,
    maxRetries: 3,
    retryBackoffMs: 750,
    newsMaxAgeHours: 24,
  },

  review: {
    pendingTtlMinutes: 240,
    retainRejected: true,
    supersedePendingDuplicates: true,
    duplicateCooldownMinutes: 120,
  },

  execution: {
    mode: 'paper',
    autoDecisions: ['approved'],
    slippageBps: 5,
    feeBps: 10,
    paused: false,
  },
};
