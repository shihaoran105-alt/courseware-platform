/**
 * 落盘日志。
 *
 * 为什么需要它：以前出错只有 console，而用户关掉终端/窗口就什么都没了 ——
 * 只能把「模型返回的 JSON 无法解析」这一句话贴过来。可这句话对应的畸形 JSON
 * 有七八种（没引号的键、省略号占位、注释、代码围栏…），光看报错根本猜不出是哪一种，
 * 只能一轮轮试。现在把**模型原始返回**一并写进 data/logs/，直接看文件就知道原因。
 *
 * 这个模块只在服务端用。它是 node-only 的，所以**不能**被 server/ai/client.mjs
 * 直接 import —— 那个文件会被编译成浏览器版。client.mjs 通过 setDiagnosticSink()
 * 把诊断信息回传过来，由 index.mjs 在启动时接到这里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = process.env.LOG_DIR || path.join(ROOT, 'data', 'logs');

/** 单个日志文件的上限，超了就轮转成 .1，避免长期跑把磁盘写满 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 单条明细最多留这么多字符（模型原始返回通常够看出发病位置了） */
const MAX_DETAIL = 6000;

/** 最近若干条留在内存里，供「查看日志」直接用，不用去翻文件 */
const recent = [];
const RECENT_MAX = 200;

/**
 * 把 API Key 之类抹掉再落盘。
 * 日志是准备被贴出来/发出去的，密钥不能跟着一起走。
 */
function redact(s) {
  return String(s ?? '')
    .replace(/\b(sk|gho|ghp|ghs|ghu)_[A-Za-z0-9_-]{6,}/g, '$1_***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1***')
    .replace(
      /("?(?:api[_-]?key|apikey|authorization|token|secret)"?\s*[:=]\s*")[^"]{6,}"/gi,
      '$1***"',
    );
}

const clamp = (s, n = MAX_DETAIL) => {
  const t = redact(s);
  return t.length > n ? `${t.slice(0, n)}\n…（共 ${t.length} 字，已截断）` : t;
};

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const fileFor = (d) => path.join(LOG_DIR, `error-${day(d)}.log`);

function rotateIfNeeded(file) {
  try {
    if (fs.statSync(file).size < MAX_FILE_BYTES) return;
    const bak = `${file}.1`;
    fs.rmSync(bak, { force: true });
    fs.renameSync(file, bak);
  } catch {
    /* 文件还不存在：正常，不用管 */
  }
}

function stringifyExtra(extra) {
  const lines = [];
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object' && !(v instanceof Error)) {
      try {
        lines.push(`  ${k}: ${clamp(JSON.stringify(v), 2000)}`);
      } catch {
        lines.push(`  ${k}: （无法序列化）`);
      }
      continue;
    }
    lines.push(`  ${k}: ${clamp(String(v), 2000)}`);
  }
  return lines.join('\n');
}

/**
 * 记一条错误。
 * @param {string} scope 出错的环节，例如 'ai.json' / 'stage.lab' / 'http'
 * @param {Error|string} err
 * @param {object} extra 附加上下文：project / stage / model / raw（模型原始返回）…
 */
export function logError(scope, err, extra = {}) {
  const at = new Date();
  const message = err instanceof Error ? err.message : String(err ?? '');
  const stack = err instanceof Error && err.stack ? err.stack : '';
  const raw = extra?.raw;

  const entry = {
    at: at.toISOString(),
    scope,
    message,
    stack: stack.split('\n').slice(0, 6).join('\n'),
    extra: { ...extra, raw: undefined },
    raw: raw ? clamp(raw) : '',
  };

  // 内存里留一份给「查看日志」用
  recent.push(entry);
  if (recent.length > RECENT_MAX) recent.shift();

  const block = [
    `[${entry.at}] ${scope}  ✗`,
    `  message: ${clamp(message, 1000)}`,
    stringifyExtra(extra),
    entry.stack && !raw ? '' : '',
    raw ? '  ---- 模型原始返回 ----' : '',
    raw ? entry.raw : '',
    raw ? '  ----------------------' : '',
  ]
    .filter((x) => x !== '')
    .join('\n');

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = fileFor(at);
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${block}\n\n`, 'utf8');
  } catch (e) {
    // 写日志失败绝不能影响主流程
    console.warn(`[log] 写日志失败：${e.message}`);
  }

  return entry;
}

/** 最近 N 条（新的在前），给「查看日志」用 */
export function recentErrors(n = 50) {
  const k = Math.max(1, Math.min(RECENT_MAX, Number(n) || 50));
  return recent.slice(-k).reverse();
}

/**
 * 读最近那个日志文件的尾部。
 *
 * 「查看日志」必须以**文件**为准：内存里只留本次进程记的，服务一重启就空了，
 * 用户重启完点进去看到「还没有记录」，会以为日志功能没生效 —— 而文件里明明有。
 */
export function readLogTail(maxBytes = 64 * 1024) {
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^error-.*\.log$/.test(f))
      .sort();
    if (!files.length) return '';
    const file = path.join(LOG_DIR, files[files.length - 1]);
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    if (len <= 0) return '';
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/** 文件里的原始文本切成一条条，给 JSON 版接口用（最新在前） */
export function parseLogBlocks(text, n = 50) {
  const blocks = String(text || '')
    .split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.slice(-Math.max(1, Math.min(RECENT_MAX, Number(n) || 50))).reverse();
}

/** 日志目录（界面上告诉用户去哪找） */
export function logDir() {
  return LOG_DIR;
}

/** 最近这段时间记了多少条 */
export function logCount() {
  return recent.length;
}
