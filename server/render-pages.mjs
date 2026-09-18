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

/**
 * 把 PDF 渲染成一张张 JPEG。
 *
 * @param {object} opts
 * @param {string} opts.pdfPath  预览 PDF 的磁盘路径
 * @param {string} opts.cacheKey 缓存目录名（一般用文件的 storedName）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{pages: Array<{page:number, dataUrl:string, bytes:number, file:string}>}>}
 */
export async function rasterizePdf({ pdfPath, cacheKey, signal, onProgress }) {
  const bin = findChrome();
  if (!bin) throw new Error('没找到 Chrome，无法把课件页面渲染成图片');
  if (!fs.existsSync(pdfPath)) throw new Error('预览 PDF 不存在：' + pdfPath);

  const dir = path.join(PAGE_CACHE_DIR, String(cacheKey || path.basename(pdfPath)).replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });

  // 缓存命中：已经有渲染好的页就直接用
  const cached = fs
    .readdirSync(dir)
    .filter((f) => /^p\d+\.jpg$/.test(f))
    .map((f) => ({ page: Number(f.match(/^p(\d+)\.jpg$/)[1]), file: path.join(dir, f) }))
    .sort((a, b) => a.page - b.page);
  if (cached.length) {
    return {
      pages: cached.map((c) => ({
        page: c.page,
        file: c.file,
        bytes: fs.statSync(c.file).size,
        dataUrl: `data:image/jpeg;base64,${fs.readFileSync(c.file).toString('base64')}`,
      })),
      fromCache: true,
    };
  }

  const { srv, port } = await startAssetServer(pdfPath);
  const debugPort = await freePort();
  const profile = path.join(CACHE_DIR, `chrome-raster-${process.pid}`);
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

    const pages = [];
    for (let start = 1; start <= total; start += BATCH) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      const end = Math.min(start + BATCH - 1, total);
      onProgress?.(`正在把课件页面转成图片 ${start}-${end}/${total}`);
      const out = await cdp.evaluate(
        `window.__rasterRange(${start}, ${end}, ${MAX_WIDTH}, ${JPEG_QUALITY})`,
      );
      const list = typeof out === 'string' ? JSON.parse(out) : out;
      for (const item of list || []) {
        if (!item?.dataUrl) continue;
        const b64 = String(item.dataUrl).split(',')[1] || '';
        const file = path.join(dir, `p${item.page}.jpg`);
        fs.writeFileSync(file, Buffer.from(b64, 'base64'));
        pages.push({ page: item.page, file, bytes: fs.statSync(file).size, dataUrl: item.dataUrl });
      }
    }
    pages.sort((a, b) => a.page - b.page);
    return { pages, fromCache: false };
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

/** 渲染好的页面缓存清掉（重新上传同一份文件时用） */
export function clearPageCache(cacheKey) {
  const dir = path.join(PAGE_CACHE_DIR, String(cacheKey || '').replace(/[^\w.-]/g, '_'));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
