#!/usr/bin/env node
import { launchUpdateHelper, prepareUpdate } from '../server/self-update.mjs';

try {
  console.log('正在读取 GitHub 更新清单并校验完整包…');
  const update = await prepareUpdate();
  if (!update.updated) {
    console.log(`✓ ${update.message || `当前已是最新版 v${update.version}`}`);
    process.exit(0);
  }

  console.log(update.repair
    ? `发现 v${update.version} 的本机构建与 GitHub 不一致，将强制重装完整包。`
    : `发现新版本：v${update.from} → v${update.version}`);
  launchUpdateHelper(update.stageRoot, update.version);
  console.log('完整包已校验通过。即将删除旧程序、保留用户数据，安装后自动重启。');
} catch (err) {
  console.error(`更新失败：${err?.message || String(err)}`);
  process.exitCode = 1;
}
