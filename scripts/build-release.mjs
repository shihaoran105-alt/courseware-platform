#!/usr/bin/env node
/**
 * 打包发行版。
 *
 * 为什么不用系统自带的 zip：macOS 的 zip / ditto 写中文文件名时**不设 UTF-8 标志位**
 * （general purpose flag bit 11）。Windows 看到没有这个标志的条目，就按本地代码页
 * （中文系统是 GBK）去解码那串 UTF-8 字节 —— 于是「课件讲解平台」变成「璇句欢璁茶В骞冲彴」。
 * 更糟的是里面的启动脚本文件名也一起乱掉，安装器最后 `call "...\一键安装并启动-Windows.cmd"`
 * 就找不到文件，装不上。
 *
 * 所以这里用 JSZip（项目里本来就有）来打包：它会正确设置 UTF-8 标志位，
 * 顺带还能排除 __MACOSX / ._* 这些 macOS 垃圾，并保留 .command 的可执行位。
 *
 *   node scripts/build-release.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const TOP = 'courseware-platform';

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;

/** 打进完整包的路径（显式列出，避免把 data / node_modules / 旧 zip 混进去） */
const INCLUDE_DIRS = ['server', 'public', 'static-src', 'scripts', 'docs'];
const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  'version.json',
  'README.md',
  '.env.example',
  '.gitignore',
  'start.sh',
  'macOS安装器.command',
  'Windows安装器.cmd',
  '一键安装并启动.command',
  '一键安装并启动-Windows.cmd',
  '检查更新.command',
  '检查更新-Windows.cmd',
  '使用指南-macOS.txt',
  '使用指南-Windows.txt',
];

/** macOS 的垃圾文件，一律不要 */
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|\._[^/]*)(\/|$)/;

/** 需要保留可执行位的文件 */
const EXEC = /\.(command|sh)$/;

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const rel = base ? `${base}/${name}` : name;
    if (JUNK.test(rel)) continue;
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else if (st.isFile()) out.push({ rel, full });
  }
  return out;
}

/** 收集要打包的文件 */
function collect() {
  const files = [];
  for (const f of INCLUDE_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) files.push({ rel: f, full });
    else console.warn(`  · 跳过（不存在）：${f}`);
  }
  for (const d of INCLUDE_DIRS) {
    const full = path.join(ROOT, d);
    if (!fs.existsSync(full)) continue;
    files.push(...walk(full, d));
  }
  return files;
}

/** 加进 zip，并把可执行位写进 external attributes */
function addToZip(zip, files, prefix) {
  for (const { rel, full } of files) {
    const buf = fs.readFileSync(full);
    const name = prefix ? `${prefix}/${rel}` : rel;
    // UNIX 平台 + 0755 让解出来之后还能直接双击运行
    zip.file(name, buf, { unixPermissions: EXEC.test(rel) ? 0o755 : 0o644, createFolders: false });
  }
}

async function writeZip(zip, outPath) {
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return buf.length;
}

/**
 * 自检：把刚写出的 zip 读回来，确认中文名条目的 UTF-8 标志位是设上的。
 * 这个坑太隐蔽了（本地看着一切正常，只有 Windows 用户会中招），必须自动检查。
 */
function verifyZip(file) {
  const buf = fs.readFileSync(file);
  let checked = 0;
  const bad = [];
  // 直接扫 central directory：PK\x01\x02 之后偏移 8 是 flag，偏移 46 是文件名
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x01 || buf[i + 3] !== 0x02) continue;
    const flag = buf.readUInt16LE(i + 8);
    const nameLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 46, i + 46 + nameLen);
    const isAscii = name.every((b) => b < 0x80);
    if (isAscii) continue;
    checked++;
    if (!(flag & 0x800)) bad.push(name.toString('utf8'));
  }
  return { checked, bad };
}

console.log(`\n打包 v${version} → dist/\n`);

const payloadFiles = collect();
console.log(`  完整包 ${payloadFiles.length} 个文件`);

// ---------- 1. 完整程序包 ----------
const payloadName = `courseware-platform-v${version}.zip`;
const payloadZip = new JSZip();
addToZip(payloadZip, payloadFiles, TOP);
const payloadPath = path.join(OUT, payloadName);
const payloadSize = await writeZip(payloadZip, payloadPath);
console.log(`  ✓ ${payloadName}（${(payloadSize / 1024 / 1024).toFixed(1)} MB）`);

const payloadBuf = fs.readFileSync(payloadPath);

// ---------- 2 & 3. 两个平台的外层安装包 ----------
// 外层的文件名可以用中文（它是磁盘上的文件，不在 zip 条目里），
// 但这一层同样要用 JSZip 写，保证万一有中文条目也是带标志位的。
const bundles = [
  {
    file: `课件讲解平台-macOS-v${version}.zip`,
    items: [
      ['macOS安装器.command', path.join(ROOT, 'macOS安装器.command')],
      ['使用指南-macOS.txt', path.join(ROOT, '使用指南-macOS.txt')],
      [payloadName, null], // 用上面已经打好的 buffer
    ],
  },
  {
    file: `课件讲解平台-Windows-v${version}.zip`,
    items: [
      ['Windows安装器.cmd', path.join(ROOT, 'Windows安装器.cmd')],
      ['使用指南-Windows.txt', path.join(ROOT, '使用指南-Windows.txt')],
      [payloadName, null],
    ],
  },
];

for (const b of bundles) {
  const zip = new JSZip();
  for (const [name, full] of b.items) {
    const buf = full ? fs.readFileSync(full) : payloadBuf;
    zip.file(name, buf, { unixPermissions: EXEC.test(name) ? 0o755 : 0o644, createFolders: false });
  }
  const size = await writeZip(zip, path.join(OUT, b.file));
  console.log(`  ✓ ${b.file}（${(size / 1024 / 1024).toFixed(1)} MB）`);
}

// ---------- 4. 自检 ----------
console.log('\n自检：中文文件名的 UTF-8 标志位');
let failed = 0;
for (const f of [payloadName, ...bundles.map((b) => b.file)]) {
  const { checked, bad } = verifyZip(path.join(OUT, f));
  if (bad.length) {
    failed++;
    console.log(`  ✗ ${f}：${bad.length} 个中文条目没设 UTF-8 标志，Windows 上会乱码`);
    bad.slice(0, 3).forEach((n) => console.log(`       ${n}`));
  } else {
    console.log(`  ✓ ${f}（${checked} 个中文条目全部带 UTF-8 标志）`);
  }
}

console.log(
  failed
    ? '\n✗ 有安装包未通过自检，不要发出去\n'
    : '\n完成。dist/ 里的三个 zip 可以直接分发；外层 zip 给用户，里面装着对应的安装器。\n',
);
process.exit(failed ? 1 : 0);
