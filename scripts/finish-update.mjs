import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const [root, stageRoot, parentPidRaw, version] = process.argv.slice(2);
const parentPid = Number(parentPidRaw);
const keep = new Set(['data', '.env', '.git', 'node_modules']);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(root, 'data', 'update.log');

function log(message) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

function parentAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  for (let i = 0; i < 120 && parentAlive(); i += 1) await delay(250);
  if (parentAlive()) throw new Error('旧服务未能停止');

  log(`开始安装 v${version}`);
  for (const name of fs.readdirSync(root)) {
    if (!keep.has(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  fs.cpSync(stageRoot, root, { recursive: true, force: true });
  fs.rmSync(stageRoot, { recursive: true, force: true });

  if (process.platform !== 'win32') {
    for (const file of ['start.sh', '一键安装并启动.command', '检查更新.command']) {
      const target = path.join(root, file);
      if (fs.existsSync(target)) fs.chmodSync(target, 0o755);
    }
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: root, env: process.env, stdio: 'ignore' });
  if (install.status !== 0) log('npm install 未成功，尝试使用现有依赖启动');

  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  server.unref();
  log(`v${version} 安装完成，服务已重新启动`);
} catch (err) {
  log(`更新失败：${err?.stack || err}`);
  process.exitCode = 1;
}
