/**
 * 把 PDF 的每一页渲染成图片，交给视觉模型读。
 *
 * 为什么需要它：我们之前只把 PDF / PPTX 的**文字层**发给模型，
 * 于是图（电路图、框图、照片）它完全看不到，表格还会被文字层挤成一坨
 * （比如表头解析成 `SignedOne'sTwo's magnitudecomplementcomplement`）。
 * 发页面截图能同时解决这两件事 —— 实测一页只要约 370 tokens，不贵。
 *
 * 实现上刻意不引入新依赖：
 *   · 浏览器端项目里本来就带着 pdf.js（public/vendor/）
 *   · 这台机器上已经有 Chrome（生成预览 PDF 时也在用 LibreOffice）
 * 所以这里起一个临时 HTTP 服务把 pdf.js 和 PDF 喂给 headless Chrome，
 * 让它在页面里把每一页画到 canvas，再取回 base64。
 *
 * 结果按文件缓存到磁盘，同一份课件重跑分析不会重复渲染。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { CACHE_DIR, PUBLIC_DIR, ROOT } from './config.mjs';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/**
 * 页面对象。dataUrl 做成**惰性**的：一份 95 页的课件全量转 base64 是十几 MB，
 * 而批改一道题、精讲一道题往往只需要其中一两页。只有真正被读到的页才编码。
 */
function lazyPage({ page, file }) {
  let memo = '';
  return {
    page,
    file,
    get bytes() {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    },
    get dataUrl() {
      if (!memo) memo = `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
      return memo;
    },
  };
}

const PAGE_CACHE_DIR = path.join(CACHE_DIR, 'pages');
fs.mkdirSync(PAGE_CACHE_DIR, { recursive: true });

export function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || '';
}

export function chromeState() {
  const bin = findChrome();
  return { available: Boolean(bin), path: bin, note: bin ? '' : '没找到 Chrome，无法把页面渲染成图片' };
}

/** 单页渲染宽度上限；太宽只会烧 token，读图并不需要 2000px */
const MAX_WIDTH = Number(process.env.PAGE_IMAGE_WIDTH) || 1100;
const JPEG_QUALITY = Number(process.env.PAGE_IMAGE_QUALITY) || 0.82;
/** 一次取回多少页（CDP 一次传太多 base64 会很慢） */
const BATCH = 6;

/**
 * 「这页要不要读图」的阈值和挑选规则都在 page-select.mjs，服务端和静态版共用一份。
 * 这里既 import（自己要用 selectPages）又 re-export（对外保持原有导出名）。
 */
import { selectPages, pageNeedsImage, IMG_RATIO_MIN, PATH_SEGS_MIN } from './page-select.mjs';

export { selectPages, pageNeedsImage, IMG_RATIO_MIN, PATH_SEGS_MIN };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const MIME = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** 临时静态服务：只暴露 pdf.js 和这一个 PDF，其他一律 404 */
function startAssetServer(pdfPath) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '').split('?')[0]);
      let file = '';
      if (rel === '/doc.pdf') file = pdfPath;
      else if (rel === '/pdf.min.mjs') file = path.join(PUBLIC_DIR, 'vendor', 'pdf.min.mjs');
      else if (rel === '/pdf.worker.min.mjs') file = path.join(PUBLIC_DIR, 'vendor', 'pdf.worker.min.mjs');
      else if (rel === '/r.html') file = path.join(ROOT, 'server', 'raster.html');
      // 每页指标的算法和静态版共用同一份，这里把它一起喂给页面
      else if (rel === '/page-select.mjs') file = path.join(ROOT, 'server', 'page-select.mjs');
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/** 极简 CDP 客户端，只用到 Runtime.evaluate */
async function connectCdp(port, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      target = (list || []).find((t) => t.type === 'page');
      if (target) break;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!target) throw new Error('Chrome 调试端口没起来');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连接 Chrome 失败')), { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    }
    return r.result?.result?.value;
  };
  return { ws, send, evaluate, close: () => ws.close() };
}

/** 缓存目录里已经渲染好的页 -> [{page, file}] */
function renderedPages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^p\d+\.jpg$/.test(f))
    .map((f) => ({ page: Number(f.match(/^p(\d+)\.jpg$/)[1]), file: path.join(dir, f) }))
    .sort((a, b) => a.page - b.page);
}

/** 每页的统计结果缓存在缓存目录里，算一次就够了 */
function readStats(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'));
    return Array.isArray(d) && d.length ? d : null;
  } catch {
    return null;
  }
}

/** 某个文件的页面缓存目录 */
function pageDir(cacheKey, pdfPath) {
  return path.join(PAGE_CACHE_DIR, String(cacheKey || path.basename(pdfPath)).replace(/[^\w.-]/g, '_'));
}

/**
 * 开一个一次性的 headless Chrome，把这份 PDF 载进 pdf.js，再把控制权交给 fn。
 * 页面渲染和页面统计都需要这一步，所以抽出来共用。
 */
async function withPdfInChrome({ bin, pdfPath, signal }, fn) {
  if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
  const { srv, port } = await startAssetServer(pdfPath);
  const debugPort = await freePort();
  const profile = path.join(CACHE_DIR, `chrome-raster-${process.pid}-${debugPort}`);
  const chrome = spawn(
    bin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp = null;
  try {
    cdp = await connectCdp(debugPort);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/r.html` });

    // 等 pdf.js 把文档读进来
    let total = 0;
    for (let i = 0; i < 100; i++) {
      total = await cdp.evaluate('window.__PDF_PAGES || 0');
      if (total) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!total) {
      const err = await cdp.evaluate('window.__PDF_ERR || ""');
      throw new Error(err || 'pdf.js 没能读取这份 PDF');
    }
    return await fn({ cdp, total });
  } finally {
    try {
      cdp?.close();
    } catch {
      /* 忽略 */
    }
    try {
      chrome.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
    srv.close();
    // Chrome 被杀掉之后可能还在收尾写文件，删 profile 失败无所谓：
    // 下次启动会用新的目录，旧的留在 cache 里不影响功能
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* 忽略 */
    }
  }
}

/** 把 __pageStats 的返回值解析成数组 */
function parseStats(raw) {
  const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(list) ? list.filter((x) => Number(x?.page) > 0) : [];
}

/**
 * 只算每页的统计（不渲染），结果落盘缓存。
 * 给「生成前先告诉用户自动模式会读几页」用。
 * @returns {Promise<Array<{page:number,imgRatio:number,pathSegs:number}>>}
 */
export async function pageStats({ pdfPath, cacheKey, signal } = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('没找到 Chrome，无法分析课件页面');
  if (!fs.existsSync(pdfPath)) throw new Error('预览 PDF 不存在：' + pdfPath);
  const dir = pageDir(cacheKey, pdfPath);
  fs.mkdirSync(dir, { recursive: true });
  const cached = readStats(dir);
  if (cached) return cached;

  const stats = await withPdfInChrome({ bin, pdfPath, signal }, ({ cdp }) =>
    cdp.evaluate('window.__pageStats()').then(parseStats),
  );
  if (stats.length) {
    try {
      fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(stats));
    } catch {
      /* 缓存写失败不影响这次使用 */
    }
  }
  return stats;
}

/**
 * 把 PDF 渲染成一张张 JPEG。
 *
 * auto 模式下先算每页统计，只渲染「图片/表格/框图多」的那些页 ——
 * 纯文字页只把提取出来的文字交给模型，省掉那些页的图片 token。
 *
 * @param {object} opts
 * @param {string} opts.pdfPath  预览 PDF 的磁盘路径
 * @param {string} opts.cacheKey 缓存目录名（一般用文件的 storedName）
 * @param {AbortSignal} [opts.signal]
 * @param {'auto'|'all'|'text'} [opts.mode] 读图模式，默认 auto
 * @returns {Promise<{pages: Array, total:number, selected:number, mode:string, fromCache:boolean}>}
 */
export async function rasterizePdf({ pdfPath, cacheKey, signal, onProgress, mode = 'auto' }) {
  const bin = findChrome();
  if (!bin) throw new Error('没找到 Chrome，无法把课件页面渲染成图片');
  if (!fs.existsSync(pdfPath)) throw new Error('预览 PDF 不存在：' + pdfPath);

  const dir = pageDir(cacheKey, pdfPath);
  fs.mkdirSync(dir, { recursive: true });

  // 只读文字：一页都不用渲染
  if (mode === 'text') return { pages: [], total: 0, selected: 0, mode, fromCache: true };

  let stats = readStats(dir);

  // 缓存够用就别开 Chrome：统计有了，而且该挑的页都已渲染过
  if (stats) {
    const want = selectPages(stats, mode);
    const have = new Map(renderedPages(dir).map((p) => [p.page, p]));
    if (want.every((n) => have.has(n))) {
      return {
        pages: want.map((n) => lazyPage(have.get(n))),
        total: stats.length,
        selected: want.length,
        mode,
        fromCache: true,
      };
    }
  }

  const fresh = await withPdfInChrome({ bin, pdfPath, signal }, async ({ cdp, total }) => {
    // 1) 先要统计 —— auto 模式靠它决定挑哪些页
    if (!stats) {
      onProgress?.('正在分析课件页面（判断哪些页需要读图）…');
      stats = parseStats(await cdp.evaluate('window.__pageStats()'));
    }
    // 统计拿不到（老版本 pdf.js、异常 PDF）时退回全渲染，
    // 宁可多花 token，也不能让图悄悄消失
    const useMode = stats.length ? mode : 'all';
    const want = selectPages(stats, useMode);
    const have = new Set(renderedPages(dir).map((p) => p.page));
    const todo = want.filter((n) => !have.has(n));

    // 2) 只渲染缺的那几页
    for (let i = 0; i < todo.length; i += BATCH) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      const chunk = todo.slice(i, i + BATCH);
      onProgress?.(
        `正在把需要读图的页面渲染出来 ${Math.min(i + BATCH, todo.length)}/${todo.length}（共 ${total} 页，挑了 ${want.length} 页）`,
      );
      const list = JSON.parse(
        await cdp.evaluate(
          `window.__rasterPages(${JSON.stringify(chunk)}, ${MAX_WIDTH}, ${JPEG_QUALITY})`,
        ),
      );
      for (const item of list || []) {
        if (!item?.dataUrl) continue;
        const b64 = String(item.dataUrl).split(',')[1] || '';
        fs.writeFileSync(path.join(dir, `p${item.page}.jpg`), Buffer.from(b64, 'base64'));
      }
    }
    return { useMode, want };
  });

  if (stats?.length) {
    try {
      fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(stats));
    } catch {
      /* 忽略 */
    }
  }

  const byPage = new Map(renderedPages(dir).map((p) => [p.page, p]));
  return {
    pages: fresh.want.map((n) => byPage.get(n)).filter(Boolean).map(lazyPage),
    total: stats?.length || 0,
    selected: fresh.want.length,
    mode: fresh.useMode,
    fromCache: false,
  };
}

/** 渲染好的页面缓存清掉（重新上传同一份文件时用） */
export function clearPageCache(cacheKey) {
  const dir = path.join(PAGE_CACHE_DIR, String(cacheKey || '').replace(/[^\w.-]/g, '_'));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
