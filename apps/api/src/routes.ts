import {
  type Decision,
  type EngineConfig,
  type Repositories,
  type ReviewStatus,
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

/**
 * Read-only reporting plus one mutating endpoint: recording that a human
 * reviewed a memo.
 *
 * There is no endpoint that places, sizes or sends an order anywhere. The most
 * this API can do is write "a person looked at this and accepted it" into an
 * audit log.
 */
export function buildRoutes(deps: RouteDeps): Router {
  const { config, repositories, defaultReviewer } = deps;
  const router = new Router();

  router.get('/api/health', async () => ({
    status: 200,
    body: {
      ok: true,
      autoExecution: false,
      instruments: config.instruments.length,
      thresholds: config.scoring.thresholds,
      time: new Date().toISOString(),
    },
  }));

  router.get('/api/config', async () => ({
    status: 200,
    body: {
      account: config.account,
      exposure: config.exposure,
      volatility: config.volatility,
      maxLoss: config.maxLoss,
      planning: config.planning,
      scoring: config.scoring,
      review: config.review,
      schedule: config.schedule,
      instruments: config.instruments,
    },
  }));

  // The ranked list: approved first, then watchlist, then rejected, each by
  // score descending. One entry per instrument + direction, because a live setup
  // is re-derived on every scan; `?history=true` returns every repeat instead.
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

  /**
   * Stage 5. `acknowledged` records that a human read the memo and accepted it
   * as actionable; `dismissed` records that they passed on it. Neither sends an
   * order anywhere — the operator still places any trade manually.
   */
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
      // Requiring a note on acknowledgement is the friction that makes this a
      // conscious act rather than a reflexive click.
      throw new HttpError(400, 'acknowledging a memo requires a note explaining the decision');
    }

    const memo = await repositories.memos.byId(memoId);
    if (!memo) throw new HttpError(404, 'memo not found');
    if (!memo.review) {
      throw new HttpError(
        409,
        `memo ${memoId} was ${memo.decision} and never entered the review queue, so it cannot be reviewed`,
      );
    }

    const result = await repositories.review.recordDecision(memoId, body.action, reviewer, notes);
    if (!result.ok) throw new HttpError(409, result.reason ?? 'review could not be recorded');

    const updated = await repositories.memos.byId(memoId);
    return {
      status: 200,
      body: {
        ok: true,
        memo: updated,
        reminder: 'This records a human decision only. No order was placed by this system.',
      },
    };
  });

  router.get('/api/review/pending', async () => {
    const expired = await repositories.review.expireStale();
    const memos = await repositories.memos.ranked({
      reviewStatuses: ['pending'],
      limit: 200,
    });
    return { status: 200, body: { memos, count: memos.length, expiredOnRead: expired } };
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

  /**
   * Operator-maintained account size. The engine only reads portfolio state —
   * it never opens positions — so this is how a $10 (or any) account is set.
   *
   * Peak is reset to the new equity on purpose: changing account size is an
   * operator action, not a trading loss. Keeping the old peak would make a
   * move from $10,000 → $10 look like a 99% drawdown and block every plan.
   */
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
    const [counts, runs, pending, snapshots] = await Promise.all([
      repositories.memos.decisionCounts(new Date(Date.now() - 24 * 3_600_000)),
      repositories.runs.recent(1),
      repositories.review.pending(),
      repositories.snapshots.count(),
    ]);
    return {
      status: 200,
      body: {
        last24h: counts,
        pendingReview: pending.length,
        snapshotsStored: snapshots,
        lastRun: runs[0] ?? null,
      },
    };
  });

  return router;
}
