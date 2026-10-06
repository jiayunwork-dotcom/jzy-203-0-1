/**
 * 集成测试基建。
 *
 * 数据库来源（按优先级）：
 *  1. DATABASE_URL 环境变量（docker compose 场景）；
 *  2. 否则启动本地内嵌 PostgreSQL 16：直接使用 embedded-postgres 包随附的
 *     zonky 平台二进制（node_modules/@embedded-postgres/<platform>-<arch>/native），
 *     用 initdb/pg_ctl 拉起一个临时实例 —— 本地无 Docker 也能跑完整集成测试。
 *
 * 若两者都不可用：默认跳过数据库测试并打印警告；设置 REQUIRE_DB=1 则直接失败
 * （CI/compose 中使用，防止“静默跳过”）。
 */
import { execFile } from 'child_process';
import { Express } from 'express';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Pool } from 'pg';
import { promisify } from 'util';
import { createApp } from '../src/api';
import { migrate } from '../src/db';
import { Service } from '../src/service';
import { Store } from '../src/store';

const execFileP = promisify(execFile);

export interface TestContext {
  app: Express;
  store: Store;
  service: Service;
}

let pool: Pool | null = null;
let embeddedStop: (() => Promise<void>) | null = null;
let dbAvailable = false;

function platformSuffix(): string {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${platform}-${arch}`;
}

function embeddedBinDir(): string {
  if (process.env.PG_BIN_DIR) return process.env.PG_BIN_DIR;
  return path.join(
    __dirname,
    '..',
    'node_modules',
    '@embedded-postgres',
    platformSuffix(),
    'native',
    'bin',
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startEmbedded(): Promise<string> {
  const binDir = embeddedBinDir();
  if (!fs.existsSync(path.join(binDir, 'initdb'))) {
    throw new Error(`找不到内嵌 PostgreSQL 二进制：${binDir}`);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pg-'));
  const port = await freePort();
  await execFileP(path.join(binDir, 'initdb'), [
    '-D', dataDir, '-U', 'test', '--auth=trust', '--no-instructions', '-E', 'UTF8',
  ]);
  await execFileP(path.join(binDir, 'pg_ctl'), [
    '-D', dataDir,
    '-l', path.join(dataDir, 'server.log'),
    '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`,
    '-w', 'start',
  ]);
  embeddedStop = async () => {
    await execFileP(path.join(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop']).catch(
      () => undefined,
    );
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  const admin = new Pool({
    connectionString: `postgres://test@127.0.0.1:${port}/postgres`,
    connectionTimeoutMillis: 10000,
  });
  await admin.query('CREATE DATABASE lc_test');
  await admin.end();
  return `postgres://test@127.0.0.1:${port}/lc_test`;
}

export async function setup(): Promise<void> {
  let url = process.env.DATABASE_URL ?? null;
  if (!url) {
    try {
      url = await startEmbedded();
    } catch (e) {
      if (process.env.REQUIRE_DB) throw e;
      console.warn(
        `[integration] 内嵌 PostgreSQL 不可用，跳过数据库集成测试：${(e as Error).message}`,
      );
      return;
    }
  }
  try {
    pool = new Pool({ connectionString: url, connectionTimeoutMillis: 10000 });
    await migrate(pool);
    dbAvailable = true;
  } catch (e) {
    if (process.env.REQUIRE_DB) throw e;
    console.warn(`[integration] 数据库不可达，跳过数据库集成测试：${(e as Error).message}`);
  }
}

export function isDbAvailable(): boolean {
  return dbAvailable;
}

export async function teardown(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (embeddedStop) {
    await embeddedStop();
    embeddedStop = null;
  }
}

export async function resetDb(): Promise<void> {
  if (!pool) return;
  await pool.query(
    'TRUNCATE events, proj_batches, proj_parts, inheritance, parts RESTART IDENTITY CASCADE',
  );
}

export function makeApp(): TestContext {
  if (!pool) throw new Error('database not available');
  const store = new Store(pool);
  const service = new Service(store);
  return { app: createApp(service, store), store, service };
}
