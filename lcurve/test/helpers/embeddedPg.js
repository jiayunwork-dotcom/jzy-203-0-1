/**
 * 测试用内嵌 PostgreSQL 16：直接使用 @embedded-postgres/* 平台包里的
 * initdb/postgres 二进制，以独立进程方式启动，供 DB 测试连接。
 * 仅用于本地/CI 测试；生产部署用 docker-compose 里的 postgres:16-alpine。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveBinDir() {
  const base = path.join(__dirname, '..', '..', 'node_modules', '@embedded-postgres');
  const plat = process.platform === 'linux' ? `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : null;
  const candidates = [
    plat && path.join(base, plat, 'native', 'bin'),
    ...fs.readdirSync(base).map((d) => path.join(base, d, 'native', 'bin')),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'initdb'))) return dir;
  }
  throw new Error(
    '找不到内嵌 PostgreSQL 二进制，请安装 @embedded-postgres/linux-x64 或 linux-arm64',
  );
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startEmbeddedPg() {
  const binDir = resolveBinDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcurve-pg-'));
  const dataDir = path.join(workDir, 'data');
  const sockDir = path.join(workDir, 'sock');
  fs.mkdirSync(sockDir);
  const port = 55000 + Math.floor(Math.random() * 9000);

  const init = spawnSync(path.join(binDir, 'initdb'), [
    '-D', dataDir, '-U', 'postgres', '--auth=trust', '--no-sync',
  ], { encoding: 'utf8' });
  if (init.status !== 0) {
    throw new Error(`initdb 失败: ${init.stderr}`);
  }

  const child = spawn(path.join(binDir, 'postgres'), [
    '-D', dataDir,
    '-p', String(port),
    '-k', sockDir,
    '-c', 'listen_addresses=127.0.0.1',
    '-c', 'fsync=off',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  // 等待就绪
  const pg = require('pg');
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try {
      const c = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 500 });
      await c.connect();
      await c.end();
      ready = true;
    } catch {
      await sleep(200);
    }
  }
  if (!ready) {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    throw new Error('内嵌 PostgreSQL 启动超时');
  }

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('CREATE DATABASE lcurve_test');
  await admin.end();

  return {
    pid: child.pid,
    workDir,
    port,
    url: `postgres://postgres@127.0.0.1:${port}/lcurve_test`,
  };
}

module.exports = { startEmbeddedPg };
