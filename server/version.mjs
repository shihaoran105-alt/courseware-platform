/**
 * 版本号读取。
 *
 * version.json 放在仓库根目录，三种角色都要用它：
 *   - 服务端：GET /api/version 每次读盘返回
 *   - 静态版：构建时复制进 docs/，前端带 cache-bust 拉它
 *   - 我（改代码的人）：用 scripts/bump-version.mjs 改它
 *
 * 刻意不缓存到内存：这是一份几十字节的小文件，而「改了版本号页面却不知道」
 * 正是这个功能最需要避免的事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

export const VERSION_FILE = path.join(ROOT, 'version.json');

const FALLBACK = {
  version: '0.0.0',
  releasedAt: '',
  history: [],
};

export function readVersion() {
  try {
    const raw = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    return {
      version: String(raw.version || FALLBACK.version),
      releasedAt: raw.releasedAt || '',
      history: Array.isArray(raw.history) ? raw.history : [],
    };
  } catch {
    return { ...FALLBACK };
  }
}
