/** DB 测试共享：连接池、建表、清库 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { migrate } from '../../src/db';
import { LCurveService } from '../../src/service';
import { createApp } from '../../src/app';

let pool: pg.Pool | null = null;

export function testDbUrl(): string {
  if (process.env.LCURVE_TEST_DATABASE_URL) return process.env.LCURVE_TEST_DATABASE_URL;
  const infoFile = path.join(__dirname, '.embedded-pg.json');
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  return info.url;
}

export function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: testDbUrl(), max: 10 });
  return pool;
}

export async function resetDb(): Promise<void> {
  const p = getPool();
  await migrate(p);
  await p.query('TRUNCATE events, parts, projections');
}

export function makeService(): LCurveService {
  return new LCurveService(getPool());
}

export function makeApp() {
  return createApp(getPool());
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
