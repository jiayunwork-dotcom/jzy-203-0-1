/**
 * 启动入口：建库 → 从事件流重建投影（重启恢复）→ 监听。
 */

import { createApp } from './app';
import { createPool, migrate } from './db';
import { LCurveService } from './service';

async function main(): Promise<void> {
  const pool = createPool();

  // 数据库可能尚未就绪（compose 启动顺序），有限重试
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await migrate(pool);
      // 重启恢复：事件流是唯一事实来源，读模型随时可重建
      const { parts, events } = await new LCurveService(pool).rebuildProjections();
      console.log(`[lcurve] projections rebuilt from ${events} events across ${parts} parts`);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[lcurve] waiting for database (attempt ${attempt}/10)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;

  const port = Number(process.env.PORT ?? 3000);
  const app = createApp(pool);
  const server = app.listen(port, () => console.log(`[lcurve] listening on :${port}`));

  const shutdown = async () => {
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('[lcurve] fatal:', e);
  process.exit(1);
});
