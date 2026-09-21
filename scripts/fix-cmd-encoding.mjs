#!/usr/bin/env node
/**
 * 把 Windows 批处理文件规范化成 Windows 能真正跑起来的样子。
 *
 * 两个都必须做对，少一个都会出问题：
 *
 * 1. **换行必须是 CRLF**。这是这次「双击没反应」的真正原因 ——
 *    仓库里的 .cmd 一直是 LF 换行（macOS 上的编辑器/工具写出来的），
 *    cmd.exe 对 LF-only 的批处理文件解析不可靠：`goto :label` 找不到标签、
 *    多行 `if (...)` 块会被拆坏，配上第一行的 `@echo off` 就变成
 *    「双击之后什么都不发生」。
 *
 * 2. **编码用 GBK，不带 BOM**。中文 Windows 的控制台代码页默认就是 936，
 *    GBK 文件天然就能正确读出来，不需要 chcp，也就不存在
 *    「文件读到一半才切代码页」这种不确定性。
 *    反过来 UTF-8（不管带不带 BOM）都要靠 chcp 65001 配合，
 *    而 BOM 还会让第一行变成 `锘緻echo off` 这种乱码命令。
 *
 *   node scripts/fix-cmd-encoding.mjs          # 规范化仓库里的 .cmd
 *   node scripts/fix-cmd-encoding.mjs --check  # 只检查，不改（构建时用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const iconv = require('iconv-lite');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

/** 所有需要按 Windows 规则处理的批处理文件 */
export function cmdFiles() {
  return fs
    .readdirSync(ROOT)
    .filter((f) => /\.(cmd|bat)$/i.test(f))
    .map((f) => path.join(ROOT, f))
    .concat(
      fs.existsSync(path.join(ROOT, 'scripts'))
        ? fs
            .readdirSync(path.join(ROOT, 'scripts'))
            .filter((f) => /\.(cmd|bat)$/i.test(f))
            .map((f) => path.join(ROOT, 'scripts', f))
        : [],
    );
}

/** 读成文本并去掉可能存在的 BOM */
export function readCmd(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/** 统一换行成 CRLF（先全部归一成 LF，再换，避免出现 \r\r\n） */
export function toCrlf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

/** 规范化一个文件；返回是否改动过 */
export function normalize(file) {
  const raw = fs.readFileSync(file);
  const text = readCmd(file);
  const crlf = toCrlf(text);
  const buf = iconv.encode(crlf, 'gbk');

  const same = raw.equals(buf);
  if (!same && !CHECK_ONLY) {
    fs.writeFileSync(file, buf);
  }
  return { changed: !same, bytes: buf.length };
}

export function inspect(buf) {
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const crlf = (buf.toString('latin1').match(/\r\n/g) || []).length;
  const loneLf = (buf.toString('latin1').match(/(?<!\r)\n/g) || []).length;
  const isGbk = (() => {
    try {
      const t = iconv.decode(buf, 'gbk');
      // GBK 解出来的文本不应该含替换字符
      return !t.includes('\ufffd');
    } catch {
      return false;
    }
  })();
  return { hasBom, crlf, loneLf, isGbk };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = cmdFiles();
  if (!files.length) {
    console.log('没找到 .cmd / .bat 文件');
    process.exit(0);
  }
  console.log(CHECK_ONLY ? '\n检查 Windows 批处理文件（CRLF + GBK，无 BOM）\n' : '\n规范化 Windows 批处理文件\n');
  let bad = 0;
  for (const f of files) {
    const info = inspect(fs.readFileSync(f));
    const problems = [];
    if (info.hasBom) problems.push('有 BOM');
    if (info.loneLf) problems.push(`${info.loneLf} 处 LF 换行（Windows 会解析失败）`);
    if (!info.crlf) problems.push('没有 CRLF 换行');
    if (!info.isGbk) problems.push('不是 GBK 编码');

    const name = path.relative(ROOT, f);
    if (!problems.length) {
      console.log(`  ✓ ${name}`);
      continue;
    }
    bad++;
    if (CHECK_ONLY) {
      console.log(`  ✗ ${name}：${problems.join('、')}`);
      console.log(`       修复：node scripts/fix-cmd-encoding.mjs`);
    } else {
      const { changed } = normalize(f);
      console.log(`  ${changed ? '✓ 已修复' : '· 无需改动'} ${name}（${problems.join('、')}）`);
    }
  }
  console.log(
    bad && CHECK_ONLY
      ? `\n✗ ${bad} 个文件不符合要求，Windows 用户会装不上\n`
      : '\n完成。\n',
  );
  process.exit(bad && CHECK_ONLY ? 1 : 0);
}
