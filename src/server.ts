/**
 * 服务入口：建库表 → 从事件流重建投影（重启恢复）→ 监听。
 */
import { createApp } from './api';
import { createPool, migrate } from './db';
import { Service } from './service';
import { Store } from './store';

async function main(): Promise<void> {
  const pool = createPool();
  await migrate(pool);
  const store = new Store(pool);
  await store.rebuildProjections(); // 重启后从事件流恢复投影
  const service = new Service(store);
  const app = createApp(service, store);
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`learning-curve service listening on :${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
