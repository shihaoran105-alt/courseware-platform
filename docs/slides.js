/* ============================================================
   课件页面渲染
   把「预览 PDF」逐页画成图片，用来替代原来「课件原文」的文字区域。
   这样看到的就是原文件在常规大小下的样子，而不是提取出来的纯文本。

   渲染结果按 (url, page, width) 缓存在内存 + IndexedDB，
   翻页来回看不会重复解算。
   ============================================================ */

const slideDocs = new Map(); // url → PDFDocumentProxy
const slideCache = new Map(); // key → dataURL
const IDB_NAME = 'courseware-slides';
const IDB_STORE = 'renders';

let pdfReady = null;
let idbPromise = null;

/**
 * 拿到 pdf.js 实例。
 * index.html 里通常已经用一个 module 脚本把它挂到 window 上；
 * 万一没挂上（脚本顺序变了、被拦截了），这里自己动态加载一份，保证一定能渲染。
 */
function whenPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfReady) return pdfReady;
  pdfReady = (async () => {
    try {
      const m = await import('./vendor/pdf.min.mjs');
      m.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
      window.pdfjsLib = m;
      return m;
    } catch (err) {
      throw new Error('pdf.js 加载失败：' + (err.message || err));
    }
  })();
  return pdfReady;
}

/* ------------------------------ 渲染结果缓存 ------------------------------ */

function openIdb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 2500);
    } catch {
      resolve(null);
    }
  });
  return idbPromise;
}

async function idbGet(key) {
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(IDB_STORE, 'readonly');
      const r = t.objectStore(IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut(key, value) {
  const db = await openIdb();
  if (!db) return;
  try {
    const t = db.transaction(IDB_STORE, 'readwrite');
    t.objectStore(IDB_STORE).put(value, key);
  } catch {
    /* 存不下就算了，内存里还有 */
  }
}

/* ------------------------------ 渲染 ------------------------------ */

async function loadDoc(url) {
  if (slideDocs.has(url)) return slideDocs.get(url);
  const pdfjs = await whenPdfjs();
  const doc = await pdfjs.getDocument({ url, isEvalSupported: false, verbosity: 0 }).promise;
  slideDocs.set(url, doc);
  return doc;
}

/** 这个 PDF 一共几页 */
async function slideCount(url) {
  if (!url) return 0;
  try {
    return (await loadDoc(url)).numPages;
  } catch {
    return 0;
  }
}

/**
 * 渲染某一页，返回 dataURL PNG。
 * @param {string} url 预览 PDF 地址
 * @param {number} page 页码（从 1 开始）
 * @param {{width?:number}} opts width 是目标像素宽（默认 1100，接近常规缩放下的一页）
 */
async function renderSlide(url, page, { width = 1100 } = {}) {
  if (!url) return null;
  const key = `${url}#${page}@${width}`;
  if (slideCache.has(key)) return slideCache.get(key);

  const cached = await idbGet(key);
  if (cached) {
    slideCache.set(key, cached);
    return cached;
  }

  const doc = await loadDoc(url);
  const n = Math.max(1, Math.min(page, doc.numPages));
  const pdfPage = await doc.getPage(n);

  const base = pdfPage.getViewport({ scale: 1 });
  const scale = Math.max(0.5, Math.min(width / base.width, 3));
  const viewport = pdfPage.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL('image/png');

  slideCache.set(key, dataUrl);
  idbPut(key, dataUrl);
  return dataUrl;
}

/**
 * 把某页挂到某个容器里（先放个骨架，渲染完再替换）
 * @returns {Promise<void>}
 */
async function mountSlide(container, url, page, opts = {}) {
  if (!container) return;
  if (!url) {
    container.innerHTML = '<div class="slide-missing">这一页没有可用的课件截图<br><span>（上传 PPTX / PDF 后会自动生成）</span></div>';
    return;
  }
  const key = `${url}#${page}@${opts.width || 1100}`;
  if (container.dataset.slideKey === key && container.querySelector('img')) return;

  container.dataset.slideKey = key;
  container.innerHTML = '<div class="slide-loading"><span class="spin"></span>正在渲染课件页面…</div>';
  try {
    const dataUrl = await renderSlide(url, page, opts);
    if (container.dataset.slideKey !== key) return; // 翻页太快，这次结果作废
    container.innerHTML = `<img src="${dataUrl}" alt="课件第 ${page} 页" class="slide-img">`;
  } catch (err) {
    container.innerHTML = `<div class="slide-missing">课件截图渲染失败<br><span>${String(err.message || err)}</span></div>`;
  }
}

/** 清掉某个 PDF 的内存缓存（文件重新上传后用） */
function forgetSlides(url) {
  for (const k of [...slideCache.keys()]) if (k.startsWith(url + '#')) slideCache.delete(k);
  slideDocs.delete(url);
}

/* 以普通脚本加载，挂到 window 供 app.js / quiz-lab.js 调用 */
window.mountSlide = mountSlide;
window.slideCount = slideCount;
window.renderSlide = renderSlide;
window.forgetSlides = forgetSlides;
