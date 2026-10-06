/**
 * 事件存储与投影持久化。
 *
 * 关键机制：
 *  - 追加事件在单事务内完成：先取部件级 advisory 锁（pg_advisory_xact_lock），
 *    把同一部件的事件追加串行化 —— 并发提交的最终状态与按获得锁的顺序
 *    串行处理完全一致。
 *  - 幂等：event_id 是客户端提供的幂等键（主键）。重复提交同一事件编号且
 *    内容一致 → 返回 duplicate，不重复生效；内容不一致 → 409。
 *  - 追加后用同一个纯函数归约器（projection.ts）重放该部件的全部事件并
 *    重写投影表 —— 在线投影、时点回推、重启重建三条路径共享同一套语义。
 *  - 时点回推：recorded_at <= asOf 的事件按 seq 重放，即得当时在线看到的状态。
 */
import { Pool, PoolClient } from 'pg';
import { ConflictError } from './errors';
import {
  applyEvent,
  BatchEvent,
  BatchState,
  PartState,
  reduceEvents,
} from './projection';

export interface StoredEvent extends BatchEvent {
  seq: number;
  recordedAt: Date;
}

export interface AppendResult {
  outcome: 'applied' | 'duplicate';
  eventId: string;
  seq: number;
  recordedAt: Date;
  state: PartState;
}

export interface InheritanceEdge {
  childId: string;
  parentId: string;
  priorLearningRate: number | null;
  strength: number;
}

export interface PartRow {
  partId: string;
  name: string;
  createdAt: Date;
}

/** 事件载荷的规范形式（键序固定、只含有效字段），用于幂等比较。 */
function payloadOf(ev: BatchEvent): Record<string, unknown> {
  const p: Record<string, unknown> = { batchId: ev.batchId };
  if (ev.firstUnit !== undefined) p.firstUnit = ev.firstUnit;
  if (ev.lastUnit !== undefined) p.lastUnit = ev.lastUnit;
  if (ev.totalHours !== undefined) p.totalHours = ev.totalHours;
  if (ev.allowsGap === true) p.allowsGap = true;
  return p;
}

/** 递归按排序键序列化，用于载荷内容等价比较。 */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

function rowToEvent(row: {
  event_id: string;
  type: BatchEvent['type'];
  payload: Record<string, unknown>;
}): BatchEvent {
  const p = row.payload ?? {};
  return {
    eventId: row.event_id,
    type: row.type,
    batchId: p.batchId as string,
    firstUnit: p.firstUnit as number | undefined,
    lastUnit: p.lastUnit as number | undefined,
    totalHours: p.totalHours as number | undefined,
    allowsGap: p.allowsGap === true,
  };
}

async function writeProjection(
  client: PoolClient,
  partId: string,
  state: PartState,
  eventCount: number,
  lastSeq: number,
): Promise<void> {
  await client.query('DELETE FROM proj_batches WHERE part_id = $1', [partId]);
  for (const b of state.batches) {
    await client.query(
      `INSERT INTO proj_batches (part_id, batch_id, first_unit, last_unit, total_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [partId, b.batchId, b.firstUnit, b.lastUnit, b.totalHours, b.status],
    );
  }
  await client.query(
    `INSERT INTO proj_parts (part_id, event_count, max_unit, last_seq)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (part_id) DO UPDATE SET
       event_count = EXCLUDED.event_count,
       max_unit    = EXCLUDED.max_unit,
       last_seq    = EXCLUDED.last_seq`,
    [partId, eventCount, state.maxUnit, lastSeq],
  );
}

export class Store {
  constructor(private readonly pool: Pool) {}

  // ---------- 部件 ----------

  async createPart(partId: string, name: string): Promise<void> {
    await this.pool.query('INSERT INTO parts (part_id, name) VALUES ($1, $2)', [partId, name]);
  }

  async getPart(partId: string): Promise<PartRow | null> {
    const r = await this.pool.query(
      'SELECT part_id, name, created_at FROM parts WHERE part_id = $1',
      [partId],
    );
    if (r.rows.length === 0) return null;
    return { partId: r.rows[0].part_id, name: r.rows[0].name, createdAt: r.rows[0].created_at };
  }

  async listParts(): Promise<PartRow[]> {
    const r = await this.pool.query('SELECT part_id, name, created_at FROM parts ORDER BY part_id');
    return r.rows.map((row) => ({ partId: row.part_id, name: row.name, createdAt: row.created_at }));
  }

  // ---------- 改型继承 ----------

  async getInheritance(childId: string): Promise<InheritanceEdge | null> {
    const r = await this.pool.query(
      'SELECT child_id, parent_id, prior_learning_rate, strength FROM inheritance WHERE child_id = $1',
      [childId],
    );
    if (r.rows.length === 0) return null;
    return {
      childId: r.rows[0].child_id,
      parentId: r.rows[0].parent_id,
      priorLearningRate: r.rows[0].prior_learning_rate,
      strength: r.rows[0].strength,
    };
  }

  async listInheritanceEdges(): Promise<Map<string, string>> {
    const r = await this.pool.query('SELECT child_id, parent_id FROM inheritance');
    return new Map(r.rows.map((row) => [row.child_id as string, row.parent_id as string]));
  }

  async setInheritance(
    childId: string,
    parentId: string,
    priorLearningRate: number | null,
    strength: number,
  ): Promise<InheritanceEdge> {
    await this.pool.query(
      `INSERT INTO inheritance (child_id, parent_id, prior_learning_rate, strength)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (child_id) DO UPDATE SET
         parent_id = EXCLUDED.parent_id,
         prior_learning_rate = EXCLUDED.prior_learning_rate,
         strength = EXCLUDED.strength`,
      [childId, parentId, priorLearningRate, strength],
    );
    return { childId, parentId, priorLearningRate, strength };
  }

  async deleteInheritance(childId: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM inheritance WHERE child_id = $1', [childId]);
    return (r.rowCount ?? 0) > 0;
  }

  // ---------- 事件流 ----------

  async listEvents(partId: string, asOf?: Date): Promise<StoredEvent[]> {
    const rows = asOf
      ? (
          await this.pool.query(
            `SELECT event_id, type, payload, seq, recorded_at FROM events
             WHERE part_id = $1 AND recorded_at <= $2 ORDER BY seq`,
            [partId, asOf],
          )
        ).rows
      : (
          await this.pool.query(
            'SELECT event_id, type, payload, seq, recorded_at FROM events WHERE part_id = $1 ORDER BY seq',
            [partId],
          )
        ).rows;
    return rows.map((row) => ({
      ...rowToEvent(row),
      seq: Number(row.seq),
      recordedAt: row.recorded_at,
    }));
  }

  /**
   * 追加一个事件（事务内：部件级 advisory 锁 → 幂等检查 → 重放校验 →
   * 插入事件 → 重写该部件投影）。领域校验失败会回滚并抛出 DomainError。
   */
  async appendEvent(partId: string, ev: BatchEvent): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 串行化同一部件的事件追加；锁在事务提交时释放
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [partId]);

      const existing = await client.query(
        'SELECT part_id, type, payload, seq, recorded_at FROM events WHERE event_id = $1',
        [ev.eventId],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        const same =
          row.part_id === partId &&
          row.type === ev.type &&
          canonical(row.payload) === canonical(payloadOf(ev));
        if (!same) {
          throw new ConflictError(`事件编号 ${ev.eventId} 已以不同内容提交过`);
        }
        await client.query('COMMIT');
        const proj = await this.getProjection(partId);
        return {
          outcome: 'duplicate',
          eventId: ev.eventId,
          seq: Number(row.seq),
          recordedAt: row.recorded_at,
          state: proj.state,
        };
      }

      const rows = (
        await client.query(
          'SELECT event_id, type, payload FROM events WHERE part_id = $1 ORDER BY seq',
          [partId],
        )
      ).rows;
      const events = rows.map(rowToEvent);
      const state = reduceEvents(events);
      const newState = applyEvent(state, ev); // 领域校验失败 → 抛错 → 回滚

      const ins = await client.query(
        `INSERT INTO events (event_id, part_id, type, payload)
         VALUES ($1, $2, $3, $4) RETURNING seq, recorded_at`,
        [ev.eventId, partId, ev.type, JSON.stringify(payloadOf(ev))],
      );
      const seq = Number(ins.rows[0].seq);
      await writeProjection(client, partId, newState, events.length + 1, seq);
      await client.query('COMMIT');
      return {
        outcome: 'applied',
        eventId: ev.eventId,
        seq,
        recordedAt: ins.rows[0].recorded_at,
        state: newState,
      };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* 连接已断开时忽略 */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  // ---------- 投影 ----------

  async getProjection(partId: string): Promise<{ state: PartState; eventCount: number }> {
    const batches = await this.pool.query(
      `SELECT batch_id, first_unit, last_unit, total_hours, status
       FROM proj_batches WHERE part_id = $1 ORDER BY first_unit`,
      [partId],
    );
    const meta = await this.pool.query(
      'SELECT event_count, max_unit FROM proj_parts WHERE part_id = $1',
      [partId],
    );
    const bs: BatchState[] = batches.rows.map((row) => ({
      batchId: row.batch_id,
      firstUnit: row.first_unit,
      lastUnit: row.last_unit,
      totalHours: row.total_hours,
      status: row.status,
    }));
    const maxUnit =
      meta.rows.length > 0
        ? (meta.rows[0].max_unit as number)
        : bs.reduce((m, b) => Math.max(m, b.lastUnit), 0);
    const eventCount = meta.rows.length > 0 ? (meta.rows[0].event_count as number) : 0;
    return { state: { batches: bs, maxUnit }, eventCount };
  }

  /** 服务重启后调用：清空投影表并从事件流整体重建。 */
  async rebuildProjections(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE proj_batches, proj_parts');
      const partRows = (await client.query('SELECT DISTINCT part_id FROM events')).rows;
      for (const { part_id: partId } of partRows) {
        const rows = (
          await client.query(
            'SELECT event_id, type, payload, seq FROM events WHERE part_id = $1 ORDER BY seq',
            [partId],
          )
        ).rows;
        const state = reduceEvents(rows.map(rowToEvent));
        const lastSeq = rows.length > 0 ? Number(rows[rows.length - 1].seq) : 0;
        await writeProjection(client, partId, state, rows.length, lastSeq);
      }
      await client.query('COMMIT');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }
}
