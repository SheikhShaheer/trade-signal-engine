import {
  type Decision,
  type EngineConfig,
  getTestnetCredentials,
  type Repositories,
  type ReviewStatus,
  type Timeframe,
} from '@tse/core';
import { HttpError, Router } from './router.js';

const decisions: readonly Decision[] = ['approved', 'watchlist', 'rejected'];
const reviewStatuses: readonly ReviewStatus[] = [
  'pending',
  'acknowledged',
  'dismissed',
  'expired',
  'superseded',
  'suppressed',
];

function parseList<T extends string>(raw: string | null, allowed: readonly T[], field: string): T[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = values.filter((v) => !allowed.includes(v as T));
  if (invalid.length > 0) {
    throw new HttpError(400, `invalid ${field}: ${invalid.join(', ')}. Allowed: ${allowed.join(', ')}`);
  }
  return values as T[];
}

function parseMemoId(raw: string | undefined): number {
  const id = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'memo id must be a positive integer');
  return id;
}

export interface RouteDeps {
  config: EngineConfig;
  repositories: Repositories;
  defaultReviewer: string;
}

/** HTTP API for the paper-trading bot dashboard. */
export function buildRoutes(deps: RouteDeps): Router {
  const { config, repositories, defaultReviewer } = deps;
  const router = new Router();

  router.get('/api/health', async () => {
    const bot = await repositories.bot.status();
    return {
      status: 200,
      body: {
        ok: true,
        autoExecution: true,
        mode: config.execution.mode,
        paused: bot.paused,
        instruments: config.instruments.length,
        thresholds: {
          ...config.scoring.thresholds,
          approve: bot.approveThreshold,
        },
        time: new Date().toISOString(),
      },
    };
  });

  router.get('/api/config', async () => {
    const [approveThreshold, signalTimeframe] = await Promise.all([
      repositories.bot.approveThreshold(),
      repositories.bot.signalTimeframe(),
    ]);
    return {
      status: 200,
      body: {
        account: config.account,
        exposure: config.exposure,
        volatility: { ...config.volatility, atrTimeframe: signalTimeframe },
        maxLoss: config.maxLoss,
        planning: config.planning,
        scoring: {
          ...config.scoring,
          thresholds: {
            ...config.scoring.thresholds,
            approve: approveThreshold,
          },
        },
        review: config.review,
        execution: config.execution,
        schedule: config.schedule,
        instruments: config.instruments,
        signalTimeframe,
        chartTimeframes: config.scanner.timeframes,
      },
    };
  });

  router.get('/api/bot/status', async () => {
    const [bot, portfolio, openPositions, lastTrade] = await Promise.all([
      repositories.bot.status(),
      repositories.portfolio.current(config.account.startingEquity),
      repositories.portfolio.openBotPositions(),
      repositories.execution.lastTrade(),
    ]);
    const testnetConfigured = Boolean(getTestnetCredentials());
    const unrealisedPnl = openPositions.reduce((sum, p) => sum + (p.unrealisedPnl ?? 0), 0);
    const totalPnl = portfolio.dayRealisedPnl + unrealisedPnl;
    return {
      status: 200,
      body: {
        mode: bot.executionMode,
        paused: bot.paused,
        approveThreshold: bot.approveThreshold,
        signalTimeframe: bot.signalTimeframe,
        testnetConfigured,
        updatedAt: bot.updatedAt,
        equity: portfolio.equity,
        markEquity: portfolio.equity + unrealisedPnl,
        dayRealisedPnl: portfolio.dayRealisedPnl,
        unrealisedPnl,
        totalPnl,
        openCount: openPositions.length,
        openPositions,
        lastTrade: lastTrade ?? null,
      },
    };
  });

  router.put('/api/bot/signal-timeframe', async (ctx) => {
    const body = (ctx.body ?? {}) as { timeframe?: unknown };
    const timeframe = body.timeframe;
    if (typeof timeframe !== 'string' || !config.scanner.timeframes.includes(timeframe as Timeframe)) {
      throw new HttpError(
        400,
        `timeframe must be one of: ${config.scanner.timeframes.join(', ')}`,
      );
    }
    await repositories.bot.setSignalTimeframe(timeframe as Timeframe);
    return { status: 200, body: { ok: true, timeframe } };
  });

  router.put('/api/bot/approve-threshold', async (ctx) => {
    const body = (ctx.body ?? {}) as { threshold?: unknown };
    const threshold = typeof body.threshold === 'number' ? body.threshold : Number.NaN;
    const watchlist = config.scoring.thresholds.watchlist;
    if (!Number.isFinite(threshold) || threshold <= watchlist || threshold > 10) {
      throw new HttpError(
        400,
        `threshold must be a number greater than ${watchlist} (watchlist cutoff) and at most 10`,
      );
    }
    await repositories.bot.setApproveThreshold(threshold);
    return { status: 200, body: { ok: true, threshold } };
  });

  router.put('/api/bot/execution-mode', async (ctx) => {
    const body = (ctx.body ?? {}) as { mode?: unknown };
    if (body.mode !== 'paper' && body.mode !== 'testnet') {
      throw new HttpError(400, 'mode must be "paper" or "testnet"');
    }
    if (body.mode === 'testnet' && !getTestnetCredentials()) {
      throw new HttpError(
        400,
        'testnet mode requires BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET in .env',
      );
    }
    await repositories.bot.setExecutionMode(body.mode);
    return { status: 200, body: { ok: true, mode: body.mode } };
  });

  router.post('/api/bot/pause', async () => {
    await repositories.bot.pause();
    return { status: 200, body: { ok: true, paused: true } };
  });

  router.post('/api/bot/resume', async () => {
    await repositories.bot.resume();
    return { status: 200, body: { ok: true, paused: false } };
  });

  router.get('/api/trades', async (ctx) => {
    const limitRaw = ctx.query.get('limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
      throw new HttpError(400, 'limit must be an integer between 1 and 500');
    }
    const trades = await repositories.execution.recentTrades(limit);
    return { status: 200, body: { trades, count: trades.length } };
  });

  router.get('/api/positions', async () => {
    const positions = await repositories.portfolio.openBotPositions();
    return { status: 200, body: { positions, count: positions.length } };
  });

  router.get('/api/memos', async (ctx) => {
    const limitRaw = ctx.query.get('limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
      throw new HttpError(400, 'limit must be an integer between 1 and 500');
    }
    const sinceRaw = ctx.query.get('sinceHours');
    const sinceHours = sinceRaw ? Number.parseFloat(sinceRaw) : undefined;
    if (sinceRaw && (!Number.isFinite(sinceHours) || (sinceHours as number) <= 0)) {
      throw new HttpError(400, 'sinceHours must be a positive number');
    }

    const historyRaw = ctx.query.get('history');
    if (historyRaw !== null && historyRaw !== 'true' && historyRaw !== 'false') {
      throw new HttpError(400, 'history must be true or false');
    }

    const memos = await repositories.memos.ranked({
      decisions: parseList(ctx.query.get('decision'), decisions, 'decision'),
      reviewStatuses: parseList(ctx.query.get('reviewStatus'), reviewStatuses, 'reviewStatus'),
      since: sinceHours ? new Date(Date.now() - sinceHours * 3_600_000) : undefined,
      limit,
      latestPerIdea: historyRaw !== 'true',
    });
    return { status: 200, body: { memos, count: memos.length } };
  });

  router.get('/api/memos/:id', async (ctx) => {
    const memo = await repositories.memos.byId(parseMemoId(ctx.params.id));
    if (!memo) throw new HttpError(404, 'memo not found');
    return { status: 200, body: memo };
  });

  router.post('/api/memos/:id/review', async (ctx) => {
    const memoId = parseMemoId(ctx.params.id);
    const body = (ctx.body ?? {}) as { action?: unknown; reviewer?: unknown; notes?: unknown };

    if (body.action !== 'acknowledged' && body.action !== 'dismissed') {
      throw new HttpError(400, 'action must be "acknowledged" or "dismissed"');
    }
    const reviewer =
      typeof body.reviewer === 'string' && body.reviewer.trim() !== '' ? body.reviewer.trim() : defaultReviewer;
    const notes = typeof body.notes === 'string' && body.notes.trim() !== '' ? body.notes.trim() : undefined;

    if (body.action === 'acknowledged' && !notes) {
      throw new HttpError(400, 'acknowledging a memo requires a note explaining the decision');
    }

    const memo = await repositories.memos.byId(memoId);
    if (!memo) throw new HttpError(404, 'memo not found');
    if (!memo.review) {
      throw new HttpError(
        409,
        `memo ${memoId} was ${memo.decision} and is not in the watchlist queue`,
      );
    }

    const result = await repositories.review.recordDecision(memoId, body.action, reviewer, notes);
    if (!result.ok) throw new HttpError(409, result.reason ?? 'review could not be recorded');

    const updated = await repositories.memos.byId(memoId);
    return { status: 200, body: { ok: true, memo: updated } };
  });

  router.get('/api/review/pending', async () => {
    const expired = await repositories.review.expireStale();
    const memos = await repositories.memos.ranked({
      reviewStatuses: ['pending'],
      limit: 200,
    });
    return { status: 200, body: { memos, count: memos.length, expiredOnRead: expired } };
  });

  router.get('/api/watchlist', async (ctx) => {
    const limitRaw = ctx.query.get('limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
    const memos = await repositories.memos.ranked({
      decisions: ['watchlist'],
      limit: Number.isInteger(limit) && limit > 0 ? limit : 100,
      latestPerIdea: true,
    });
    return { status: 200, body: { memos, count: memos.length } };
  });

  router.get('/api/review/audit', async (ctx) => {
    const limitRaw = ctx.query.get('limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
      throw new HttpError(400, 'limit must be an integer between 1 and 500');
    }
    return { status: 200, body: { entries: await repositories.review.auditLog(limit) } };
  });

  router.get('/api/portfolio', async () => ({
    status: 200,
    body: await repositories.portfolio.current(config.account.startingEquity),
  }));

  router.put('/api/portfolio', async (ctx) => {
    const body = (ctx.body ?? {}) as { equity?: unknown };
    const equity = typeof body.equity === 'number' ? body.equity : Number.NaN;
    if (!Number.isFinite(equity) || equity < 10) {
      throw new HttpError(400, 'equity must be a number of at least 10');
    }

    const current = await repositories.portfolio.current(config.account.startingEquity);
    await repositories.portfolio.recordState(equity, equity, current.dayRealisedPnl);
    return {
      status: 200,
      body: await repositories.portfolio.current(config.account.startingEquity),
    };
  });

  router.get('/api/runs', async () => ({
    status: 200,
    body: { runs: await repositories.runs.recent(20) },
  }));

  router.get('/api/stats', async () => {
    const [counts, runs, openPositions, snapshots, bot] = await Promise.all([
      repositories.memos.decisionCounts(new Date(Date.now() - 24 * 3_600_000)),
      repositories.runs.recent(1),
      repositories.portfolio.openBotPositions(),
      repositories.snapshots.count(),
      repositories.bot.status(),
    ]);
    const lastRun = runs[0] ?? null;
    return {
      status: 200,
      body: {
        last24h: counts,
        openPositions: openPositions.length,
        snapshotsStored: snapshots,
        lastRun,
        bot: { paused: bot.paused, mode: bot.executionMode },
        executedLastRun: lastRun?.executed ?? 0,
      },
    };
  });

  return router;
}
