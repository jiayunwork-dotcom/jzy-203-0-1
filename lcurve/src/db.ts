import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { Pool } = pg;

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString?: string): pg.Pool {
  return new Pool({
    connectionString:
      connectionString ??
      process.env.DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5432/lcurve',
    max: 10,
  });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const sql = readFileSync(join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(sql);
}
