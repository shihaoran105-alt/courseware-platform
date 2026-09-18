#!/usr/bin/env node
/**
 * 版本号管理。
 *
 *   node scripts/bump-version.mjs minor "这次加了什么" [更多条目...]
 *   node scripts/bump-version.mjs patch "这次修了什么" [更多条目...]
 *   node scripts/bump-version.mjs show
 *
 * 约定（用户在对话里说的话 → 对应的操作）：
 *   「标记为版本更新」    → minor，1.0.0 → 1.1.0
 *   「标记为小补丁迭代」  → patch，1.0.0 → 1.0.1
 *
 * 会同时更新 version.json 和 package.json，并在 history 最前面插入一条记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = path.join(ROOT, 'version.json');
const PKG_FILE = path.join(ROOT, 'package.json');

const [, , action, ...rest] = process.argv;

function read() {
  return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
}

/** 1.2.3 → [1,2,3]，非法版本号直接报错，别悄悄算出一个奇怪的版本 */
function parse(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`版本号格式不对：${v}（应该是 1.2.3 这样）`);
  return m.slice(1).map(Number);
}

export function bump(current, kind) {
  const [maj, min, pat] = parse(current);
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (kind === 'major') return `${maj + 1}.0.0`;
  throw new Error(`不认识的类型：${kind}（可用 minor / patch / major）`);
}

function write(data) {
  data.releasedAt = new Date().toISOString();
  fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
    pkg.version = data.version;
    fs.writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  } catch {
    /* package.json 不在或坏了都不影响版本号本身 */
  }
}

if (!action || action === 'show') {
  const d = read();
  console.log(`当前版本：${d.version}（${String(d.releasedAt).slice(0, 10)}）\n`);
  for (const h of d.history || []) {
    console.log(`  ${h.version}  ${h.date}  ${h.title || ''}`);
    for (const c of h.changes || []) console.log(`      · ${c}`);
    console.log('');
  }
  process.exit(0);
}

if (!['minor', 'patch', 'major'].includes(action)) {
  console.error(`用法：node scripts/bump-version.mjs minor|patch|major "更新说明" [...]`);
  process.exit(1);
}

const notes = rest.filter((x) => String(x).trim());
if (!notes.length) {
  console.error('至少给一条更新说明，否则用户在「更新内容」里会看到一片空白。');
  process.exit(1);
}

const data = read();
const prev = data.version;
const next = bump(prev, action);

data.history = data.history || [];
data.history.unshift({
  version: next,
  date: new Date().toISOString().slice(0, 10),
  title: notes[0],
  changes: notes,
});
data.version = next;
write(data);

console.log(`✓ ${prev} → ${next}（${action === 'minor' ? '版本更新' : action === 'patch' ? '小补丁迭代' : '大版本'}）`);
for (const n of notes) console.log(`    · ${n}`);
