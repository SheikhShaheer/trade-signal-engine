import type {
  DecisionMemo,
  Decision,
  Direction,
  EnqueueOutcome,
  ExecutionEventType,
  ExecutionFill,
  ExecutionMode,
  ExecutionOrder,
  MarketSnapshot,
  OpenPosition,
  PipelineRunStats,
  PortfolioState,
  RankedMemo,
  ReviewItem,
  ReviewStatus,
  RiskGateResult,
  SignalCandidate,
  TradePlan,
  TradeRecord,
} from '../types.js';
import { getPool, withTransaction, type DbClient, type DbPool } from './pool.js';

type Queryable = Pick<DbPool, 'query'> | Pick<DbClient, 'query'>;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ---------------------------------------------------------------------------
// Pipeline runs
// ---------------------------------------------------------------------------

export class PipelineRunRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async start(mode: 'live' | 'once' | 'backtest' = 'live'): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      'INSERT INTO pipeline_runs (started_at, mode) VALUES (now(), $1) RETURNING id',
      [mode],
    );
    return rows[0]!.id;
  }

  async finish(runId: number, stats: PipelineRunStats): Promise<void> {
    await this.db.query(
      `UPDATE pipeline_runs
          SET finished_at = $2, duration_ms = $3, stats = $4, errors = $5
        WHERE id = $1`,
      [runId, stats.finishedAt, stats.durationMs, JSON.stringify(stats), JSON.stringify(stats.errors)],
    );
  }

  async recent(limit = 20): Promise<PipelineRunStats[]> {
    const { rows } = await this.db.query<{ id: number; stats: PipelineRunStats | null }>(
      'SELECT id, stats FROM pipeline_runs WHERE stats IS NOT NULL ORDER BY started_at DESC LIMIT $1',
      [limit],
    );
    return rows.filter((r) => r.stats !== null).map((r) => ({ ...(r.stats as PipelineRunStats), runId: r.id }));
  }
}

// ---------------------------------------------------------------------------
// Stage 1
// ---------------------------------------------------------------------------

export class SnapshotRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async insert(snapshot: MarketSnapshot, runId?: number): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO market_snapshots
         (run_id, instrument, correlation_group, captured_at, price, volume_ratio,
          higher_timeframe_trend, news_sentiment, setup_candidate, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        runId ?? null,
        snapshot.instrument,
        snapshot.correlationGroup,
        snapshot.capturedAt,
        snapshot.price,
        snapshot.volume.ratio,
        snapshot.higherTimeframeTrend,
        snapshot.news.aggregateSentiment,
        snapshot.setupCandidates.any,
        JSON.stringify(snapshot),
      ],
    );
    return rows[0]!.id;
  }

  async latestFor(instrument: string): Promise<MarketSnapshot | undefined> {
    const { rows } = await this.db.query<{ id: number; payload: MarketSnapshot }>(
      'SELECT id, payload FROM market_snapshots WHERE instrument = $1 ORDER BY captured_at DESC LIMIT 1',
      [instrument],
    );
    const row = rows[0];
    return row ? { ...row.payload, id: row.id } : undefined;
  }

  /** Chronological snapshots for replay. */
  async range(from: Date, to: Date, instruments?: string[]): Promise<MarketSnapshot[]> {
    const params: unknown[] = [from.toISOString(), to.toISOString()];
    let filter = '';
    if (instruments && instruments.length > 0) {
      params.push(instruments);
      filter = ' AND instrument = ANY($3)';
    }
    const { rows } = await this.db.query<{ id: number; payload: MarketSnapshot }>(
      `SELECT id, payload FROM market_snapshots
        WHERE captured_at >= $1 AND captured_at <= $2${filter}
        ORDER BY captured_at ASC, instrument ASC`,
      params,
    );
    return rows.map((r) => ({ ...r.payload, id: r.id }));
  }

  async count(): Promise<number> {
    const { rows } = await this.db.query<{ count: number }>('SELECT count(*)::int AS count FROM market_snapshots');
    return rows[0]?.count ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Stage 2
// ---------------------------------------------------------------------------

export class SignalRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async insert(candidate: SignalCandidate, snapshotId: number, runId?: number): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO signal_candidates
         (snapshot_id, run_id, instrument, captured_at, direction, triggered_count,
          agreement_count, disagreement_count, counter_trend, detectors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        snapshotId,
        runId ?? null,
        candidate.instrument,
        candidate.capturedAt,
        candidate.direction,
        candidate.triggeredDetectors.length,
        candidate.agreementCount,
        candidate.disagreementCount,
        candidate.counterTrend,
        JSON.stringify(candidate.detectors),
      ],
    );
    return rows[0]!.id;
  }
}

// ---------------------------------------------------------------------------
// Stage 3
// ---------------------------------------------------------------------------

export class TradePlanRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async insert(plan: TradePlan, signalId: number, runId?: number): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO trade_plans
         (signal_id, run_id, instrument, direction, entry_low, entry_high, reference_entry,
          stop_loss, targets, risk_reward_ratio, invalidation, timeframe, confidence, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        signalId,
        runId ?? null,
        plan.instrument,
        plan.direction,
        plan.entryZone.low,
        plan.entryZone.high,
        plan.referenceEntry,
        plan.stopLoss,
        JSON.stringify(plan.targets),
        plan.riskRewardRatio,
        plan.invalidation,
        plan.timeframe,
        plan.confidence,
        JSON.stringify(plan),
      ],
    );
    return rows[0]!.id;
  }
}

// ---------------------------------------------------------------------------
// Stage 4 — written for blocked plans as well as passing ones
// ---------------------------------------------------------------------------

export class RiskGateRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async insert(result: RiskGateResult, planId: number, runId?: number): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO risk_gate_results
         (plan_id, run_id, overall_pass, aggregate_margin, quantity, notional, risk_amount, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        planId,
        runId ?? null,
        result.overallPass,
        result.aggregateMargin,
        result.sizing.quantity,
        result.sizing.notional,
        result.sizing.riskAmount,
        JSON.stringify(result),
      ],
    );
    const gateResultId = rows[0]!.id;
    for (const check of result.checks) {
      await this.db.query(
        `INSERT INTO risk_checks
           (gate_result_id, check_name, pass, detail, value_checked, limit_value, margin)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [gateResultId, check.check, check.pass, check.detail, check.valueChecked, check.limit, check.margin],
      );
    }
    return gateResultId;
  }
}

// ---------------------------------------------------------------------------
// Stage 6 + Stage 5
// ---------------------------------------------------------------------------

export interface MemoQuery {
  decisions?: Decision[];
  reviewStatuses?: ReviewStatus[];
  since?: Date;
  limit?: number;
  /** Keep only the freshest memo per instrument + direction. */
  latestPerIdea?: boolean;
}

export class MemoRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async insert(memo: DecisionMemo, planId: number, runId?: number): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO decision_memos
         (plan_id, run_id, instrument, direction, score, decision, rationale, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        planId,
        runId ?? null,
        memo.instrument,
        memo.direction,
        memo.score,
        memo.decision,
        memo.rationale,
        JSON.stringify(memo),
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Ranked list: approved first, then watchlist, then rejected, each ordered by
   * score descending. The top row is always "the best thing to look at now".
   *
   * `latestPerIdea` collapses to the freshest memo per instrument + direction.
   * A setup is re-derived on every scan, so without it a list meant to answer
   * "what should I look at" is mostly the same idea repeated with slightly
   * different levels. Off by default: audit and backtest views want every row.
   */
  async ranked(query: MemoQuery = {}): Promise<RankedMemo[]> {
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (query.decisions && query.decisions.length > 0) {
      params.push(query.decisions);
      conditions.push(`m.decision = ANY($${params.length})`);
    }
    if (query.reviewStatuses && query.reviewStatuses.length > 0) {
      params.push(query.reviewStatuses);
      conditions.push(`r.status = ANY($${params.length})`);
    }
    if (query.since) {
      params.push(query.since.toISOString());
      conditions.push(`m.created_at >= $${params.length}`);
    }
    params.push(query.limit ?? 100);
    const limitParam = `$${params.length}`;

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await this.db.query<{
      id: number;
      plan_id: number;
      payload: DecisionMemo;
      status: ReviewStatus | null;
      reviewed_by: string | null;
      reviewed_at: Date | null;
      notes: string | null;
      review_created_at: Date | null;
      expires_at: Date | null;
    }>(
      query.latestPerIdea
        ? `SELECT * FROM (
             SELECT DISTINCT ON (m.instrument, m.direction)
                    m.id, m.plan_id, m.payload, m.decision, m.score, m.created_at,
                    r.status, r.reviewed_by, r.reviewed_at, r.notes,
                    r.created_at AS review_created_at, r.expires_at
               FROM decision_memos m
               LEFT JOIN review_queue r ON r.memo_id = m.id
               ${where}
              ORDER BY m.instrument, m.direction, m.created_at DESC
           ) latest
          ORDER BY CASE decision WHEN 'approved' THEN 0 WHEN 'watchlist' THEN 1 ELSE 2 END,
                   score DESC, created_at DESC
          LIMIT ${limitParam}`
        : `SELECT m.id, m.plan_id, m.payload,
                  r.status, r.reviewed_by, r.reviewed_at, r.notes,
                  r.created_at AS review_created_at, r.expires_at
             FROM decision_memos m
             LEFT JOIN review_queue r ON r.memo_id = m.id
             ${where}
            ORDER BY CASE m.decision WHEN 'approved' THEN 0 WHEN 'watchlist' THEN 1 ELSE 2 END,
                     m.score DESC, m.created_at DESC
            LIMIT ${limitParam}`,
      params,
    );

    return rows.map((row) => ({
      ...row.payload,
      id: row.id,
      planId: row.plan_id,
      review:
        row.status === null
          ? undefined
          : {
              memoId: row.id,
              status: row.status,
              reviewedBy: row.reviewed_by ?? undefined,
              reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : undefined,
              notes: row.notes ?? undefined,
              createdAt: iso(row.review_created_at as Date),
              expiresAt: iso(row.expires_at as Date),
            },
    }));
  }

  async byId(memoId: number): Promise<RankedMemo | undefined> {
    const { rows } = await this.db.query<{
      id: number;
      plan_id: number;
      payload: DecisionMemo;
      status: ReviewStatus | null;
      reviewed_by: string | null;
      reviewed_at: Date | null;
      notes: string | null;
      review_created_at: Date | null;
      expires_at: Date | null;
    }>(
      `SELECT m.id, m.plan_id, m.payload,
              r.status, r.reviewed_by, r.reviewed_at, r.notes,
              r.created_at AS review_created_at, r.expires_at
         FROM decision_memos m
         LEFT JOIN review_queue r ON r.memo_id = m.id
        WHERE m.id = $1`,
      [memoId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      ...row.payload,
      id: row.id,
      planId: row.plan_id,
      review:
        row.status === null
          ? undefined
          : {
              memoId: row.id,
              status: row.status,
              reviewedBy: row.reviewed_by ?? undefined,
              reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : undefined,
              notes: row.notes ?? undefined,
              createdAt: iso(row.review_created_at as Date),
              expiresAt: iso(row.expires_at as Date),
            },
    };
  }

  async decisionCounts(since?: Date): Promise<Record<Decision, number>> {
    const params = since ? [since.toISOString()] : [];
    const where = since ? 'WHERE created_at >= $1' : '';
    const { rows } = await this.db.query<{ decision: Decision; count: number }>(
      `SELECT decision, count(*)::int AS count FROM decision_memos ${where} GROUP BY decision`,
      params,
    );
    const out: Record<Decision, number> = { approved: 0, watchlist: 0, rejected: 0 };
    for (const row of rows) out[row.decision] = row.count;
    return out;
  }
}

export class ReviewQueueRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  /**
   * Puts a memo in front of a human, de-duplicating against the same idea.
   *
   * A setup that stays valid is re-derived on every scan, so the naive version
   * of this queues the same idea every few minutes and re-asks about ideas the
   * reviewer already dismissed. Instrument + direction is treated as the
   * identity of an idea:
   *
   * - a human decision inside `duplicateCooldownMinutes` → `suppressed`
   * - an existing pending item → `superseded` by this fresher memo
   * - otherwise → `queued`
   *
   * Every memo still gets a row, so nothing is lost for audit or replay; the
   * status decides only whether it reaches the queue. Runs in a transaction
   * because two concurrent enqueues for one idea would otherwise both see no
   * pending row and both queue.
   */
  async enqueue(
    memoId: number,
    ttlMinutes: number,
    options: { supersedePendingDuplicates?: boolean; duplicateCooldownMinutes?: number } = {},
  ): Promise<EnqueueOutcome> {
    const { supersedePendingDuplicates = true, duplicateCooldownMinutes = 0 } = options;

    return withTransaction(async (client) => {
      const { rows: memoRows } = await client.query<{ instrument: string; direction: string }>(
        `SELECT instrument, direction FROM decision_memos WHERE id = $1`,
        [memoId],
      );
      const memo = memoRows[0];
      if (!memo) throw new Error(`memo ${memoId} does not exist`);

      // Lock the idea, not the row, so a concurrent enqueue for the same
      // instrument + direction waits rather than racing this decision.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `review:${memo.instrument}:${memo.direction}`,
      ]);

      // "Was this decided recently?" and "is something pending?" are asked
      // independently. Reading only the single newest row lets a superseded or
      // suppressed row — the very rows this method creates — hide the human
      // decision behind it, which let every second repeat back into the queue.
      const { rows: priorRows } = await client.query<{
        decided_recently: boolean;
        pending_memo_ids: number[] | null;
      }>(
        `SELECT
           max(r.reviewed_at) FILTER (WHERE r.status IN ('acknowledged', 'dismissed'))
             > now() - ($3 || ' minutes')::interval AS decided_recently,
           array_agg(r.memo_id) FILTER (WHERE r.status = 'pending') AS pending_memo_ids
         FROM review_queue r
         JOIN decision_memos m ON m.id = r.memo_id
        WHERE m.instrument = $1
          AND m.direction = $2
          AND r.memo_id <> $4`,
        [memo.instrument, memo.direction, String(duplicateCooldownMinutes), memoId],
      );
      const prior = priorRows[0];
      const pendingMemoIds = prior?.pending_memo_ids ?? [];

      let status: ReviewStatus = 'pending';
      let outcome: EnqueueOutcome = 'queued';

      if (prior?.decided_recently) {
        status = 'suppressed';
        outcome = 'suppressed';
      } else if (pendingMemoIds.length > 0 && supersedePendingDuplicates) {
        await client.query(
          `UPDATE review_queue SET status = 'superseded', superseded_by = $2 WHERE memo_id = ANY($1::bigint[])`,
          [pendingMemoIds, memoId],
        );
        outcome = 'superseded';
      }

      await client.query(
        `INSERT INTO review_queue (memo_id, status, expires_at)
         VALUES ($1, $2, now() + ($3 || ' minutes')::interval)
         ON CONFLICT (memo_id) DO NOTHING`,
        [memoId, status, String(ttlMinutes)],
      );

      return outcome;
    });
  }

  async pending(): Promise<ReviewItem[]> {
    const { rows } = await this.db.query<{
      memo_id: number;
      status: ReviewStatus;
      reviewed_by: string | null;
      reviewed_at: Date | null;
      notes: string | null;
      created_at: Date;
      expires_at: Date;
    }>(`SELECT * FROM review_queue WHERE status = 'pending' ORDER BY created_at DESC`);
    return rows.map((row) => ({
      memoId: row.memo_id,
      status: row.status,
      reviewedBy: row.reviewed_by ?? undefined,
      reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : undefined,
      notes: row.notes ?? undefined,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
    }));
  }

  /**
   * Records a human decision. `acknowledged` means a person read the memo and
   * accepted it as actionable; the system still places no orders. Only pending
   * items can be actioned, so a stale or already-reviewed memo cannot be
   * silently re-decided.
   */
  async recordDecision(
    memoId: number,
    action: 'acknowledged' | 'dismissed',
    actor: string,
    notes?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{ status: ReviewStatus; expires_at: Date; score: number }>(
        `SELECT r.status, r.expires_at, m.score
           FROM review_queue r JOIN decision_memos m ON m.id = r.memo_id
          WHERE r.memo_id = $1 FOR UPDATE`,
        [memoId],
      );
      const row = rows[0];
      if (!row) return { ok: false, reason: 'memo is not in the review queue' };
      if (row.status !== 'pending') return { ok: false, reason: `memo is already ${row.status}` };
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await client.query(`UPDATE review_queue SET status = 'expired' WHERE memo_id = $1`, [memoId]);
        return { ok: false, reason: 'memo expired before it was reviewed' };
      }

      await client.query(
        `UPDATE review_queue
            SET status = $2, reviewed_by = $3, reviewed_at = now(), notes = $4
          WHERE memo_id = $1`,
        [memoId, action, actor, notes ?? null],
      );
      await client.query(
        `INSERT INTO review_audit_log (memo_id, action, actor, notes, memo_score)
         VALUES ($1,$2,$3,$4,$5)`,
        [memoId, action, actor, notes ?? null, row.score],
      );
      return { ok: true };
    });
  }

  /** Marks overdue pending items expired so nothing is approved against a moved market. */
  async expireStale(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE review_queue SET status = 'expired' WHERE status = 'pending' AND expires_at < now()`,
    );
    return rowCount ?? 0;
  }

  async auditLog(limit = 50): Promise<
    { memoId: number; action: string; actor: string; notes: string | undefined; memoScore: number; createdAt: string }[]
  > {
    const { rows } = await this.db.query<{
      memo_id: number;
      action: string;
      actor: string;
      notes: string | null;
      memo_score: number;
      created_at: Date;
    }>('SELECT * FROM review_audit_log ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows.map((r) => ({
      memoId: r.memo_id,
      action: r.action,
      actor: r.actor,
      notes: r.notes ?? undefined,
      memoScore: r.memo_score,
      createdAt: iso(r.created_at),
    }));
  }

  /** True when a human dismissed this instrument + direction inside the cooldown window. */
  async recentHumanDismissal(
    instrument: string,
    direction: Direction,
    cooldownMinutes: number,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM review_queue r
           JOIN decision_memos m ON m.id = r.memo_id
          WHERE m.instrument = $1
            AND m.direction = $2
            AND r.status = 'dismissed'
            AND r.reviewed_at > now() - ($3 || ' minutes')::interval
       ) AS exists`,
      [instrument, direction, String(cooldownMinutes)],
    );
    return rows[0]?.exists ?? false;
  }
}

// ---------------------------------------------------------------------------
// Portfolio state consumed by the risk gate
// ---------------------------------------------------------------------------

export class PortfolioRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async current(fallbackEquity: number): Promise<PortfolioState> {
    const { rows } = await this.db.query<{
      equity: number;
      peak_equity: number;
      day_realised_pnl: number;
      as_of: Date;
    }>('SELECT equity, peak_equity, day_realised_pnl, as_of FROM portfolio_state ORDER BY as_of DESC LIMIT 1');

    const state = rows[0];
    const positions = await this.openPositions();

    if (!state) {
      return {
        equity: fallbackEquity,
        peakEquity: fallbackEquity,
        dayRealisedPnl: 0,
        openPositions: positions,
        asOf: new Date().toISOString(),
      };
    }

    return {
      equity: state.equity,
      peakEquity: Math.max(state.peak_equity, state.equity),
      dayRealisedPnl: state.day_realised_pnl,
      openPositions: positions,
      asOf: iso(state.as_of),
    };
  }

  async openPositions(): Promise<OpenPosition[]> {
    const { rows } = await this.db.query<{
      id: number;
      instrument: string;
      correlation_group: string;
      direction: 'long' | 'short';
      quantity: number;
      entry_price: number;
      stop_loss: number;
      take_profit: number | null;
      notional: number;
      opened_at: Date;
      memo_id: number | null;
      order_id: number | null;
      source: string;
    }>('SELECT * FROM open_positions WHERE closed_at IS NULL ORDER BY opened_at DESC');
    return rows.map((r) => ({
      id: r.id,
      instrument: r.instrument,
      correlationGroup: r.correlation_group,
      direction: r.direction,
      quantity: r.quantity,
      entryPrice: r.entry_price,
      stopLoss: r.stop_loss,
      takeProfit: r.take_profit ?? undefined,
      notional: r.notional,
      openedAt: iso(r.opened_at),
      memoId: r.memo_id ?? undefined,
      orderId: r.order_id ?? undefined,
      source: r.source === 'manual' ? 'manual' : 'bot',
    }));
  }

  async openBotPositions(): Promise<OpenPosition[]> {
    const all = await this.openPositions();
    return all.filter((p) => p.source !== 'manual');
  }

  async recordState(equity: number, peakEquity: number, dayRealisedPnl: number): Promise<void> {
    await this.db.query(
      'INSERT INTO portfolio_state (equity, peak_equity, day_realised_pnl) VALUES ($1,$2,$3)',
      [equity, peakEquity, dayRealisedPnl],
    );
  }

  async applyRealisedPnl(pnl: number): Promise<PortfolioState> {
    const current = await this.current(0);
    const equity = current.equity + pnl;
    const peakEquity = Math.max(current.peakEquity, equity);
    const dayRealisedPnl = current.dayRealisedPnl + pnl;
    await this.recordState(equity, peakEquity, dayRealisedPnl);
    return this.current(equity);
  }
}

// ---------------------------------------------------------------------------
// Paper/live execution persistence
// ---------------------------------------------------------------------------

export class ExecutionRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async isPaused(): Promise<boolean> {
    const { rows } = await this.db.query<{ paused: boolean }>('SELECT paused FROM bot_runtime WHERE id = 1');
    return rows[0]?.paused ?? false;
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.db.query('UPDATE bot_runtime SET paused = $1, updated_at = now() WHERE id = 1', [paused]);
  }

  async logEvent(input: {
    memoId?: number;
    orderId?: number;
    positionId?: number;
    eventType: ExecutionEventType;
    detail?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO execution_events (memo_id, order_id, position_id, event_type, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.memoId ?? null, input.orderId ?? null, input.positionId ?? null, input.eventType, input.detail ?? null],
    );
  }

  async recentTradeOnIdea(
    instrument: string,
    direction: Direction,
    cooldownMinutes: number,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM execution_orders o
          WHERE o.instrument = $1
            AND o.direction = $2
            AND o.status = 'filled'
            AND o.created_at > now() - ($3 || ' minutes')::interval
       ) AS exists`,
      [instrument, direction, String(cooldownMinutes)],
    );
    return rows[0]?.exists ?? false;
  }

  async createEntry(input: {
    memoId: number;
    mode: ExecutionMode;
    instrument: string;
    direction: Direction;
    quantity: number;
    requestedPrice: number;
    fillPrice: number;
    fee: number;
    correlationGroup: string;
    stopLoss: number;
    takeProfit: number;
    notional: number;
    externalOrderId?: number;
  }): Promise<{ orderId: number; positionId: number }> {
    return withTransaction(async (client) => {
      const { rows: orderRows } = await client.query<{ id: number }>(
        `INSERT INTO execution_orders (memo_id, mode, instrument, direction, quantity, requested_price, status)
         VALUES ($1,$2,$3,$4,$5,$6,'filled') RETURNING id`,
        [
          input.memoId,
          input.mode,
          input.instrument,
          input.direction,
          input.quantity,
          input.requestedPrice,
        ],
      );
      const orderId = orderRows[0]!.id;

      await client.query(
        `INSERT INTO execution_fills (order_id, price, quantity, fee, fill_type)
         VALUES ($1,$2,$3,$4,'entry')`,
        [orderId, input.fillPrice, input.quantity, input.fee],
      );

      const { rows: posRows } = await client.query<{ id: number }>(
        `INSERT INTO open_positions
           (instrument, correlation_group, direction, quantity, entry_price, stop_loss, notional,
            memo_id, order_id, take_profit, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'bot') RETURNING id`,
        [
          input.instrument,
          input.correlationGroup,
          input.direction,
          input.quantity,
          input.fillPrice,
          input.stopLoss,
          input.notional,
          input.memoId,
          orderId,
          input.takeProfit,
        ],
      );
      const positionId = posRows[0]!.id;

      await client.query(
        `INSERT INTO execution_events (memo_id, order_id, position_id, event_type, detail)
         VALUES ($1,$2,$3,'filled', $4)`,
        [
          input.memoId,
          orderId,
          positionId,
          input.externalOrderId
            ? `entry @ ${input.fillPrice} (binance ${input.externalOrderId})`
            : `entry @ ${input.fillPrice}`,
        ],
      );

      return { orderId, positionId };
    });
  }

  async createExit(input: {
    positionId: number;
    orderId?: number;
    memoId?: number;
    exitPrice: number;
    quantity: number;
    fee: number;
    realisedPnl: number;
    eventType: ExecutionEventType;
    externalOrderId?: number;
  }): Promise<void> {
    await withTransaction(async (client) => {
      const { rows: posRows } = await client.query<{
        entry_price: number;
        direction: Direction;
        instrument: string;
        order_id: number | null;
      }>(
        `UPDATE open_positions SET closed_at = now() WHERE id = $1 AND closed_at IS NULL
         RETURNING entry_price, direction, instrument, order_id`,
        [input.positionId],
      );
      const pos = posRows[0];
      if (!pos) throw new Error(`position ${input.positionId} not found or already closed`);

      const orderId = input.orderId ?? pos.order_id ?? undefined;

      if (orderId) {
        await client.query(
          `INSERT INTO execution_fills (order_id, price, quantity, fee, fill_type)
           VALUES ($1,$2,$3,$4,'exit')`,
          [orderId, input.exitPrice, input.quantity, input.fee],
        );
      }

      const { rows: stateRows } = await client.query<{
        equity: number;
        peak_equity: number;
        day_realised_pnl: number;
      }>('SELECT equity, peak_equity, day_realised_pnl FROM portfolio_state ORDER BY as_of DESC LIMIT 1');

      const prev = stateRows[0];
      const equity = (prev?.equity ?? 0) + input.realisedPnl;
      const peakEquity = Math.max(prev?.peak_equity ?? equity, equity);
      const dayPnl = (prev?.day_realised_pnl ?? 0) + input.realisedPnl;

      await client.query(
        'INSERT INTO portfolio_state (equity, peak_equity, day_realised_pnl) VALUES ($1,$2,$3)',
        [equity, peakEquity, dayPnl],
      );

      await client.query(
        `INSERT INTO execution_events (memo_id, order_id, position_id, event_type, detail)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          input.memoId ?? null,
          orderId ?? null,
          input.positionId,
          input.eventType,
          input.externalOrderId
            ? `exit @ ${input.exitPrice}, pnl ${input.realisedPnl.toFixed(2)} (binance ${input.externalOrderId})`
            : `exit @ ${input.exitPrice}, pnl ${input.realisedPnl.toFixed(2)}`,
        ],
      );
    });
  }

  async recentTrades(limit = 50): Promise<TradeRecord[]> {
    const { rows } = await this.db.query<{
      id: number;
      memo_id: number;
      mode: ExecutionMode;
      instrument: string;
      direction: Direction;
      quantity: number;
      requested_price: number;
      status: string;
      created_at: Date;
    }>(
      `SELECT * FROM execution_orders ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );

    const out: TradeRecord[] = [];
    for (const row of rows) {
      const { rows: fills } = await this.db.query<{
        id: number;
        order_id: number;
        price: number;
        quantity: number;
        fee: number;
        fill_type: 'entry' | 'exit';
        filled_at: Date;
      }>('SELECT * FROM execution_fills WHERE order_id = $1 ORDER BY filled_at', [row.id]);

      const entryFill = fills.find((f) => f.fill_type === 'entry');
      const exitFill = fills.find((f) => f.fill_type === 'exit');
      let realisedPnl: number | undefined;
      if (entryFill && exitFill) {
        const gross =
          row.direction === 'long'
            ? (exitFill.price - entryFill.price) * row.quantity
            : (entryFill.price - exitFill.price) * row.quantity;
        realisedPnl = gross - entryFill.fee - exitFill.fee;
      }

      out.push({
        order: {
          id: row.id,
          memoId: row.memo_id,
          mode: row.mode,
          instrument: row.instrument,
          direction: row.direction,
          quantity: row.quantity,
          requestedPrice: row.requested_price,
          status: row.status as ExecutionOrder['status'],
          createdAt: iso(row.created_at),
        },
        entryFill: entryFill
          ? {
              id: entryFill.id,
              orderId: entryFill.order_id,
              price: entryFill.price,
              quantity: entryFill.quantity,
              fee: entryFill.fee,
              fillType: 'entry',
              filledAt: iso(entryFill.filled_at),
            }
          : undefined,
        exitFill: exitFill
          ? {
              id: exitFill.id,
              orderId: exitFill.order_id,
              price: exitFill.price,
              quantity: exitFill.quantity,
              fee: exitFill.fee,
              fillType: 'exit',
              filledAt: iso(exitFill.filled_at),
            }
          : undefined,
        memoId: row.memo_id,
        instrument: row.instrument,
        direction: row.direction,
        realisedPnl,
      });
    }
    return out;
  }

  async lastTrade(): Promise<TradeRecord | undefined> {
    const trades = await this.recentTrades(1);
    return trades[0];
  }
}

export class BotRuntimeRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async status(): Promise<{
    paused: boolean;
    executionMode: ExecutionMode;
    approveThreshold: number;
    testnetConfigured: boolean;
    updatedAt?: string;
  }> {
    const { rows } = await this.db.query<{
      paused: boolean;
      execution_mode: ExecutionMode;
      approve_threshold: number;
      updated_at: Date;
    }>('SELECT paused, execution_mode, approve_threshold, updated_at FROM bot_runtime WHERE id = 1');
    const row = rows[0];
    return {
      paused: row?.paused ?? false,
      executionMode: row?.execution_mode ?? 'paper',
      approveThreshold: row?.approve_threshold ?? 7.5,
      testnetConfigured: false,
      updatedAt: row ? iso(row.updated_at) : undefined,
    };
  }

  async executionMode(): Promise<'paper' | 'testnet'> {
    const { rows } = await this.db.query<{ execution_mode: ExecutionMode }>(
      'SELECT execution_mode FROM bot_runtime WHERE id = 1',
    );
    const mode = rows[0]?.execution_mode ?? 'paper';
    return mode === 'testnet' ? 'testnet' : 'paper';
  }

  async setExecutionMode(mode: 'paper' | 'testnet'): Promise<void> {
    await this.db.query(
      'UPDATE bot_runtime SET execution_mode = $1, updated_at = now() WHERE id = 1',
      [mode],
    );
  }

  async syncExecutionMode(mode: ExecutionMode): Promise<void> {
    if (mode === 'live') return;
    await this.db.query(
      'UPDATE bot_runtime SET execution_mode = $1, updated_at = now() WHERE id = 1',
      [mode === 'testnet' ? 'testnet' : 'paper'],
    );
  }

  async pause(): Promise<void> {
    await this.db.query('UPDATE bot_runtime SET paused = true, updated_at = now() WHERE id = 1');
  }

  async resume(): Promise<void> {
    await this.db.query('UPDATE bot_runtime SET paused = false, updated_at = now() WHERE id = 1');
  }

  async approveThreshold(): Promise<number> {
    const { rows } = await this.db.query<{ approve_threshold: number }>(
      'SELECT approve_threshold FROM bot_runtime WHERE id = 1',
    );
    return rows[0]?.approve_threshold ?? 7.5;
  }

  async setApproveThreshold(threshold: number): Promise<void> {
    await this.db.query(
      'UPDATE bot_runtime SET approve_threshold = $1, updated_at = now() WHERE id = 1',
      [threshold],
    );
  }

  async syncApproveThreshold(threshold: number): Promise<void> {
    await this.setApproveThreshold(threshold);
  }
}

// ---------------------------------------------------------------------------
// News cache
// ---------------------------------------------------------------------------

export class NewsCacheRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async get(instrument: string, maxAgeSeconds: number): Promise<unknown | undefined> {
    const { rows } = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM news_cache
        WHERE instrument = $1 AND fetched_at > now() - ($2 || ' seconds')::interval
        ORDER BY fetched_at DESC LIMIT 1`,
      [instrument, String(maxAgeSeconds)],
    );
    return rows[0]?.payload;
  }

  async put(instrument: string, provider: string, payload: unknown): Promise<void> {
    await this.db.query('INSERT INTO news_cache (instrument, provider, payload) VALUES ($1,$2,$3)', [
      instrument,
      provider,
      JSON.stringify(payload),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Backtests
// ---------------------------------------------------------------------------

export class BacktestRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async createRun(label: string, config: unknown, from: Date, to: Date): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      'INSERT INTO backtest_runs (label, config, from_time, to_time) VALUES ($1,$2,$3,$4) RETURNING id',
      [label, JSON.stringify(config), from.toISOString(), to.toISOString()],
    );
    return rows[0]!.id;
  }

  async addResult(
    backtestId: number,
    row: {
      snapshotId: number;
      instrument: string;
      capturedAt: string;
      direction: string | undefined;
      score: number | undefined;
      decision: string | undefined;
      outcome: string;
      realisedR: number | undefined;
      payload: unknown;
    },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO backtest_results
         (backtest_id, snapshot_id, instrument, captured_at, direction, score, decision, outcome, realised_r, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        backtestId,
        row.snapshotId,
        row.instrument,
        row.capturedAt,
        row.direction ?? null,
        row.score ?? null,
        row.decision ?? null,
        row.outcome,
        row.realisedR ?? null,
        JSON.stringify(row.payload),
      ],
    );
  }

  async finishRun(backtestId: number, summary: unknown): Promise<void> {
    await this.db.query('UPDATE backtest_runs SET summary = $2 WHERE id = $1', [
      backtestId,
      JSON.stringify(summary),
    ]);
  }
}

export interface Repositories {
  runs: PipelineRunRepository;
  snapshots: SnapshotRepository;
  signals: SignalRepository;
  plans: TradePlanRepository;
  riskGate: RiskGateRepository;
  memos: MemoRepository;
  review: ReviewQueueRepository;
  portfolio: PortfolioRepository;
  execution: ExecutionRepository;
  bot: BotRuntimeRepository;
  newsCache: NewsCacheRepository;
  backtests: BacktestRepository;
}

export function createRepositories(db: Queryable = getPool()): Repositories {
  return {
    runs: new PipelineRunRepository(db),
    snapshots: new SnapshotRepository(db),
    signals: new SignalRepository(db),
    plans: new TradePlanRepository(db),
    riskGate: new RiskGateRepository(db),
    memos: new MemoRepository(db),
    review: new ReviewQueueRepository(db),
    portfolio: new PortfolioRepository(db),
    execution: new ExecutionRepository(db),
    bot: new BotRuntimeRepository(db),
    newsCache: new NewsCacheRepository(db),
    backtests: new BacktestRepository(db),
  };
}
