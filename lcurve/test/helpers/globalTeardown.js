const fs = require('node:fs');
const path = require('node:path');

const INFO_FILE = path.join(__dirname, '.embedded-pg.json');

module.exports = async () => {
  try {
    const info = JSON.parse(fs.readFileSync(INFO_FILE, 'utf8'));
    if (info.pid) {
      try { process.kill(info.pid, 'SIGTERM'); } catch {}
      // 给 postgres 一点时间退出，然后强杀兜底
      await new Promise((r) => setTimeout(r, 500));
      try { process.kill(info.pid, 0); process.kill(info.pid, 'SIGKILL'); } catch {}
    }
    if (info.workDir) fs.rmSync(info.workDir, { recursive: true, force: true });
    fs.rmSync(INFO_FILE, { force: true });
  } catch {
    // 清理失败不阻塞测试退出
  }
};
