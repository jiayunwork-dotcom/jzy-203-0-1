/**
 * PostgreSQL 连接与建表（幂等迁移）。
 *
 * 表结构：
 *  - parts        部件
 *  - inheritance  改型继承（每部件至多一个母型；prior_learning_rate 为空表示跟随母型拟合值）
 *  - events       事件流（追加唯一事实来源；seq 全局递增，recorded_at 用于时点回推）
 *  - proj_batches 当前批次区间投影（由事件流推出，可整体重建）
 *  - proj_parts   每部件投影元信息
 */
import { Pool } from 'pg';

export const DEFAULT_DATABASE_URL =
  'postgres://lc:lc@localhost:5432/learning_curve';

export function createPool(connectionString?: string): Pool {
  return new Pool({
    connectionString: connectionString ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
}

export const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS parts (
  part_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS inheritance (
  child_id             TEXT PRIMARY KEY REFERENCES parts(part_id) ON DELETE CASCADE,
  parent_id            TEXT NOT NULL REFERENCES parts(part_id),
  prior_learning_rate  DOUBLE PRECISION,
  strength             DOUBLE PRECISION NOT NULL DEFAULT 8,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  part_id     TEXT NOT NULL REFERENCES parts(part_id),
  seq         BIGINT GENERATED ALWAYS AS IDENTITY,
  type        TEXT NOT NULL CHECK (type IN ('record','correct','void')),
  payload     JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS events_part_seq_idx ON events (part_id, seq);
CREATE INDEX IF NOT EXISTS events_recorded_at_idx ON events (recorded_at);

CREATE TABLE IF NOT EXISTS proj_batches (
  part_id     TEXT NOT NULL REFERENCES parts(part_id) ON DELETE CASCADE,
  batch_id    TEXT NOT NULL,
  first_unit  INTEGER NOT NULL,
  last_unit   INTEGER NOT NULL,
  total_hours DOUBLE PRECISION NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active','voided')),
  PRIMARY KEY (part_id, batch_id)
);

CREATE TABLE IF NOT EXISTS proj_parts (
  part_id     TEXT PRIMARY KEY REFERENCES parts(part_id) ON DELETE CASCADE,
  event_count INTEGER NOT NULL DEFAULT 0,
  max_unit    INTEGER NOT NULL DEFAULT 0,
  last_seq    BIGINT NOT NULL DEFAULT 0
);
`;

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(MIGRATIONS);
}
