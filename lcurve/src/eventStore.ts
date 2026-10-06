/**
 * 事件存储：追加写、幂等、按部件串行化、按时点回放。
 *
 * 并发语义：同一部件的事件在事务内先取 pg_advisory_xact_lock 再追加，
 * 等价于按获得锁的顺序串行处理；recorded_at 在锁内取 clock_timestamp()，
 * 与 seq 同调单调，因此"截至 T"的回放正好是当时已应用事件的前缀。
 */

import type { Pool, PoolClient } from 'pg';
import type { PartProjection } from './projection';

export interface StoredEvent {
  seq: number;
  eventId: string;
  partId: string;
  type: string;
  payload: Record<string, unknown>;
  /** ISO 8601（微秒精度，由数据库渲染，避免 JS Date 毫秒截断） */
  recordedAt: string;
}

const EVENT_COLS = `seq, event_id AS "eventId", part_id AS "partId", type, payload,
  to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt"`;

export async function lockPart(client: PoolClient, partId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [partId]);
}

export async function findEventByEventId(
  q: Pick<Pool, 'query'> | PoolClient,
  eventId: string,
): Promise<StoredEvent | null> {
  const r = await q.query(`SELECT ${EVENT_COLS} FROM events WHERE event_id = $1`, [eventId]);
  return r.rows[0] ?? null;
}

export async function insertEvent(
  client: PoolClient,
  partId: string,
  eventId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<StoredEvent> {
  const r = await client.query(
    `INSERT INTO events (event_id, part_id, type, payload, recorded_at)
     VALUES ($1, $2, $3, $4, clock_timestamp())
     RETURNING ${EVENT_COLS}`,
    [eventId, partId, type, JSON.stringify(payload)],
  );
  return r.rows[0];
}

export async function getEventsForPart(
  q: Pick<Pool, 'query'>,
  partId: string,
  asOf?: string,
): Promise<StoredEvent[]> {
  if (asOf) {
    const r = await q.query(
      `SELECT ${EVENT_COLS} FROM events
       WHERE part_id = $1 AND recorded_at <= $2::timestamptz
       ORDER BY seq`,
      [partId, asOf],
    );
    return r.rows;
  }
  const r = await q.query(`SELECT ${EVENT_COLS} FROM events WHERE part_id = $1 ORDER BY seq`, [partId]);
  return r.rows;
}

export async function getAllEvents(q: Pick<Pool, 'query'>): Promise<StoredEvent[]> {
  const r = await q.query(`SELECT ${EVENT_COLS} FROM events ORDER BY seq`);
  return r.rows;
}

export async function loadProjectionState(
  q: Pick<Pool, 'query'> | PoolClient,
  partId: string,
): Promise<PartProjection | null> {
  const r = await q.query('SELECT state FROM projections WHERE part_id = $1', [partId]);
  return r.rows[0] ? (r.rows[0].state as PartProjection) : null;
}

export async function saveProjectionState(
  client: PoolClient,
  proj: PartProjection,
  lastSeq: number,
): Promise<void> {
  await client.query(
    `INSERT INTO projections (part_id, state, last_seq) VALUES ($1, $2, $3)
     ON CONFLICT (part_id) DO UPDATE SET state = EXCLUDED.state, last_seq = EXCLUDED.last_seq`,
    [proj.partId, JSON.stringify(proj), lastSeq],
  );
}
