/**
 * 构建 GitHub Pages 静态版 → docs/
 *
 * 做法：把前端原样复制过去，再把「智能层」从 server/ 编译成浏览器 ESM，
 * 这样服务端版和静态版共用同一套提示词、客户端和流水线，不会各改一份。
 *
 *   node scripts/build-static.mjs
 *
 * 产物 docs/ 可直接提交到 GitHub，仓库设置里把 Pages 指向 /docs 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs');
const SRC = path.join(ROOT, 'static-src');

const log = (...a) => console.log(' ', ...a);
const ensure = (p) => fs.mkdirSync(p, { recursive: true });
const copy = (from, to) => {
  ensure(path.dirname(to));
  fs.copyFileSync(from, to);
};

/** 把 server/ai/*.mjs 转成浏览器 ESM：改扩展名 + 改 import 路径 */
function compileModule(fromFile, toFile, rewrites = []) {
  let code = fs.readFileSync(fromFile, 'utf8');
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  ensure(path.dirname(toFile));
  fs.writeFileSync(toFile, code, 'utf8');
}

console.log('\n构建 GitHub Pages 静态版 → docs/\n');

// ---------- 0. 清空旧产物 ----------
if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
ensure(OUT);
ensure(path.join(OUT, 'engine'));
ensure(path.join(OUT, 'vendor'));

// ---------- 1. 前端（原样复制，两种模式共用） ----------
for (const f of ['app.js', 'quiz-lab.js', 'icons.js', 'slides.js', 'styles.css', 'i18n.js', 'i18n-dict.js']) {
  copy(path.join(ROOT, 'public', f), path.join(OUT, f));
  log('前端  ' + f);
}

// ---------- 2. 智能层（从 server/ 编译） ----------
compileModule(path.join(ROOT, 'server/ai/prompts.mjs'), path.join(OUT, 'engine/prompts.js'));
compileModule(path.join(ROOT, 'server/ai/client.mjs'), path.join(OUT, 'engine/ai.js'));
compileModule(path.join(ROOT, 'server/ai/pipeline.mjs'), path.join(OUT, 'engine/pipeline.js'), [
  ["from './client.mjs'", "from './ai.js'"],
  ["from './prompts.mjs'", "from './prompts.js'"],
]);
compileModule(path.join(ROOT, 'server/export.mjs'), path.join(OUT, 'engine/export.js'));
compileModule(path.join(ROOT, 'server/providers.mjs'), path.join(OUT, 'engine/providers.js'));
// 角色判定和服务器版共用；静态版靠它才能按「课件/习题/实验/标准答案」分流
compileModule(path.join(ROOT, 'server/roles.mjs'), path.join(OUT, 'engine/roles.js'));
// 模式清单与推荐：前端弹窗和静态版引擎共用同一份
compileModule(path.join(ROOT, 'server/stages.mjs'), path.join(OUT, 'engine/stages.js'), [
  ["from './roles.mjs'", "from './roles.js'"],
]);
log('引擎  prompts.js / ai.js / pipeline.js / export.js / providers.js / roles.js / stages.js');

// ---------- 3. 静态版专属引擎 ----------
for (const f of ['extract.js', 'store.js', 'backend.js']) {
  copy(path.join(SRC, f), path.join(OUT, 'engine', f));
  log('引擎  ' + f);
}
copy(path.join(SRC, 'boot.js'), path.join(OUT, 'static-boot.js'));
// 版本清单：静态版靠它检测 GitHub Pages 上有没有新部署。
// 必须去掉 packageSha256 —— docs/ 会被打进完整包，而 packageSha256 又必须等于
// 完整包的摘要，留着就成了「sha → version.json → docs/version.json → zip → sha」
// 的死循环，每次构建 sha 都不一样。静态站本身也不读这个字段，校验由服务端的
// self-update.mjs 读仓库根目录那份 version.json 完成。
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  delete manifest.packageSha256;
  fs.writeFileSync(path.join(OUT, 'version.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log('版本  version.json（已去掉 packageSha256）');
}
log('引导  static-boot.js');

// ---------- 4. 第三方库 ----------
const NM = path.join(ROOT, 'node_modules');
const vendor = [
  ['pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['jszip/dist/jszip.min.js', 'jszip.min.js'],
];
for (const [from, to] of vendor) {
  const src = path.join(NM, from);
  if (!fs.existsSync(src)) {
    console.error(`\n✗ 缺少依赖文件 ${from}，请先 npm install\n`);
    process.exit(1);
  }
  copy(src, path.join(OUT, 'vendor', to));
  log('依赖  vendor/' + to);
}

// ---------- 5. index.html：改相对路径 + 注入引导脚本 ----------
let html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="./styles.css">');
html = html.replace(
  '<script src="icons.js"></script>',
  [
    '<script src="./vendor/jszip.min.js"></script>',
    '<script src="./static-boot.js"></script>',
    '<script src="./icons.js"></script>',
  ].join('\n'),
);
html = html.replace('<title>课件讲解平台</title>', '<title>课件讲解平台 · 纯静态版</title>');
// 加一句静态版说明，避免访客以为有服务器
html = html.replace(
  '<div class="tag">上传课件 · 分析内容 · 讲解事例 · 落地教学</div>',
  '<div class="tag">纯静态 · 数据只存在你的浏览器里</div>',
);
fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');
log('页面  index.html');

// ---------- 6. 其他 ----------
fs.writeFileSync(path.join(OUT, '.nojekyll'), '', 'utf8');
log('其他  .nojekyll（避免 GitHub Pages 用 Jekyll 处理）');

// ---------- 报告 ----------
let total = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else total += fs.statSync(p).size;
  }
};
walk(OUT);
console.log(`\n完成：docs/ 共 ${(total / 1024 / 1024).toFixed(2)} MB\n`);
console.log('下一步：');
console.log('  1) 把 docs/ 提交到 GitHub');
console.log('  2) 仓库 Settings → Pages → Source 选 "Deploy from a branch"，目录选 /docs');
console.log('  3) 等一两分钟，访问 https://<你的用户名>.github.io/<仓库名>/\n');
