/**
 * 「模型说课件里没有内容」诊断脚本（只读，不改任何东西）。
 *
 *   node 诊断读图.mjs                  # 自动找安装目录
 *   node 诊断读图.mjs "C:\path\to\dir"  # 手动指定
 *   node 诊断读图.mjs <目录> ch13       # 顺便找文件名含 ch13 的项目
 *
 * 它会回答四个问题：
 *   1. 平台能不能找到 Chrome / Edge？
 *   2. 真的能把某一页渲染成图片吗？（会真渲一页试试）
 *   3. 出问题的那个项目，生成时到底发了几页图给模型？（analysis.pagesRead）
 *   4. 页图缓存里有没有空文件？
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const keyword = (args.find((a) => !a.includes('/') && !a.includes('\\')) || '').toLowerCase();
const explicit = args.find((a) => a.includes('/') || a.includes('\\'));

/** 常见安装位置 */
function findInstallDir() {
  if (explicit && fs.existsSync(path.join(explicit, 'server', 'index.mjs'))) return explicit;
  const cands = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', '课件讲解平台'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'courseware-platform'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', '课件讲解平台'),
    path.join(os.homedir(), 'dev', 'courseware-platform'),
    '/opt/courseware-platform',
  ].filter(Boolean);
  return cands.find((d) => fs.existsSync(path.join(d, 'server', 'index.mjs'))) || '';
}

const dir = findInstallDir();
if (!dir) {
  console.log('✗ 没找到安装目录。请手动指定：node 诊断读图.mjs "C:\\Users\\你\\AppData\\Local\\Programs\\课件讲解平台"');
  process.exit(1);
}
console.log(`安装目录：${dir}\n`);

const load = (rel) => import(pathToFileURL(path.join(dir, rel)).href);

/* ---------------- 1. 找得到浏览器吗 ---------------- */
console.log('【1】平台能不能找到浏览器');
let chromeState;
try {
  ({ chromeState } = await load('server/render-pages.mjs'));
  const s = chromeState();
  console.log(`  可用：${s.available ? '是 ✓' : '否 ✗'}`);
  console.log(`  路径：${s.path || '(空)'}`);
  if (!s.available) {
    console.log('  ⚠ 这就是根因：找不到浏览器 → 所有「读图」会降级成纯文字，');
    console.log('     课件里画成图片的代码块、图表全都读不到。装个 Chrome 或用 Edge。');
  }
  console.log('  环境变量里的候选：');
  for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    console.log(`    ${k} = ${process.env[k] || '(未设置)'}`);
  }
} catch (e) {
  console.log(`  读取失败：${e.message}`);
}

/* ---------------- 2. 真渲一页试试 ---------------- */
console.log('\n【2】真渲染一页试试');
try {
  const { rasterizePdf } = await load('server/render-pages.mjs');
  const { loadAll, getProject } = await load('server/store.mjs');
  loadAll();
  const cache = path.join(dir, 'data', 'cache');
  const ids = fs.existsSync(cache) ? fs.readdirSync(cache).filter((f) => f.endsWith('.json') && !f.startsWith('_')) : [];
  const projects = ids.map((f) => getProject(f.replace(/\.json$/, ''))).filter(Boolean);
  console.log(`  项目数：${projects.length}`);

  // 找一份有预览 PDF 的
  let target = null;
  for (const p of projects) {
    const f = (p.files || []).find((x) => x.previewPdf);
    if (f) { target = { project: p, file: f }; break; }
  }
  if (!target) {
    console.log('  （没有带预览 PDF 的文件，跳过）');
  } else {
    const pdfPath = path.join(dir, 'data', 'media', target.project.id, path.basename(target.file.previewPdf));
    console.log(`  用《${target.file.originalName}》试渲染`);
    console.log(`  PDF: ${fs.existsSync(pdfPath) ? '存在' : '不存在 → ' + pdfPath}`);
    if (fs.existsSync(pdfPath)) {
      const t0 = Date.now();
      const out = await rasterizePdf({ pdfPath, cacheKey: '__diagnose__', mode: 'auto' });
      const sizes = out.pages.map((p) => fs.statSync(p.file).size);
      console.log(`  结果：${out.pages.length} 页（选中 ${out.selected} / 共 ${out.total}），用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(`  图片大小：${sizes.slice(0, 6).join(', ')}${sizes.length > 6 ? ' …' : ''} 字节`);
      console.log(sizes.length && sizes.every((n) => n > 0)
        ? '  ✓ 渲染正常，图片有内容'
        : '  ✗ 渲染出来的图是空的 —— 这就是根因');
      fs.rmSync(path.join(dir, 'data', 'cache', 'pages', '__diagnose__'), { recursive: true, force: true });
    }
  }
} catch (e) {
  console.log(`  渲染出错：${e.message}`);
}

/* ---------------- 3. 出问题的项目发了几页图 ---------------- */
console.log('\n【3】各项目「生成时发了几页图」');
try {
  const { loadAll, getProject } = await load('server/store.mjs');
  loadAll();
  const cache = path.join(dir, 'data', 'cache');
  const ids = fs.readdirSync(cache).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  const rows = [];
  for (const id of ids) {
    const p = getProject(id.replace(/\.json$/, ''));
    if (!p) continue;
    const names = (p.files || []).map((x) => x.originalName || '').join(' ');
    if (keyword && !names.toLowerCase().includes(keyword)) continue;
    // 逐份文件的关键状态：预览 PDF 在不在、被判成扫描件没有、OCR 补了哪几页
    const detail = (p.files || []).map((x) => {
      const blocks = x.blocks || [];
      const ocrBlocks = blocks.filter((b) => b.ocr === true).length;
      const blank = blocks.filter((b) => String(b.text || '').trim().length < 8).length;
      return (
        `${x.originalName}` +
        ` | 预览PDF:${x.previewPdf ? '有' : '★没有'} 文字${x.chars || 0}字` +
        ` | 页:${blocks.length} 空白:${blank}` +
        ` | 判定扫描件:${x.meta?.scanned ? '是' : '否'} OCR补:${x.meta?.ocrPages ?? 0}页(块标记${ocrBlocks})`
      );
    });
    rows.push({
      name: p.name,
      files: (p.files || []).map((x) => x.originalName).join(' / '),
      detail,
      pagesRead: p.analysis?.pagesRead,
      generatedAt: p.analysis?.generatedAt,
      segs: (p.analysis?.narration?.segments || []).length,
    });
  }
  rows.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${r.name}  → 读了 ${r.pagesRead ?? '0 或未记录'} 页图，${r.segs} 段稿`);
    console.log(`      ${r.generatedAt || '(未生成)'}  |  ${r.files}`);
    for (const d of r.detail) console.log(`        · ${d}`);
  }
  console.log('\n  说明：pagesRead 是 0 / 未记录 → 生成时一页图都没发出去；');
  console.log('        数字大于 0 → 图发出去了，问题在模型那边。');
} catch (e) {
  console.log(`  读取失败：${e.message}`);
}

/* ---------------- 4. 缓存里有没有空图 ---------------- */
console.log('\n【4】页图缓存');
try {
  const pagesDir = path.join(dir, 'data', 'cache', 'pages');
  if (!fs.existsSync(pagesDir)) {
    console.log('  还没有任何页图缓存（说明从来没成功渲染过）');
  } else {
    let total = 0, empty = 0;
    const bad = [];
    for (const d of fs.readdirSync(pagesDir)) {
      const full = path.join(pagesDir, d);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (!/\.jpg$/.test(f)) continue;
        total++;
        if (fs.statSync(path.join(full, f)).size === 0) { empty++; if (bad.length < 5) bad.push(`${d}/${f}`); }
      }
    }
    console.log(`  共 ${total} 张，其中 0 字节 ${empty} 张`);
    if (empty) console.log(`  空图例子：${bad.join(', ')}`);
  }
} catch (e) {
  console.log(`  读取失败：${e.message}`);
}

/* ---------------- 5. 最近的报错日志 ---------------- */
console.log('\n【5】最近的报错日志（最后 30 行）');
try {
  const logDir = path.join(dir, 'data', 'logs');
  if (!fs.existsSync(logDir)) {
    console.log('  （还没有日志）');
  } else {
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log')).sort();
    if (!files.length) console.log('  （还没有日志）');
    else {
      const last = path.join(logDir, files[files.length - 1]);
      const text = fs.readFileSync(last, 'utf8').split('\n');
      console.log(`  ${files[files.length - 1]}`);
      for (const l of text.slice(-30)) console.log('  ' + l);
    }
  }
} catch (e) {
  console.log(`  读取失败：${e.message}`);
}

console.log('\n完成。把上面全部输出原样发回来。');
