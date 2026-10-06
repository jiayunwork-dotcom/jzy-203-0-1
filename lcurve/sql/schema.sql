-- 事件溯源 schema：事件为唯一事实来源，projections/parts 为可重建的读模型。

CREATE TABLE IF NOT EXISTS events (
  seq         BIGSERIAL PRIMARY KEY,
  event_id    TEXT NOT NULL UNIQUE,          -- 客户端事件编号，幂等键
  part_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  -- 在持有部件锁的事务内取 clock_timestamp()，保证与 seq 同调单调，
  -- “截至某时刻”的前缀回放才与当时在线看到的结果一致
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS events_part_seq_idx ON events (part_id, seq);
CREATE INDEX IF NOT EXISTS events_recorded_at_idx ON events (recorded_at);

-- 部件/改型关系读模型（由 part_registered / variant_declared 事件投影）
CREATE TABLE IF NOT EXISTS parts (
  part_id           TEXT PRIMARY KEY,
  name              TEXT,
  parent_id         TEXT,
  prior_strength    DOUBLE PRECISION,
  explicit_prior_lr DOUBLE PRECISION,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 部件当前状态快照（由事件流投影，重启后可整体重建）
CREATE TABLE IF NOT EXISTS projections (
  part_id   TEXT PRIMARY KEY,
  state     JSONB NOT NULL,
  last_seq  BIGINT NOT NULL
);
