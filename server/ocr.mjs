/**
 * 扫描版 PDF 的「批量识字」。
 *
 * 为什么要单独做这一步：
 *   文字型 PDF（电子版导出，占大多数）本来就有文字层，pdfjs 直接读就行 ——
 *   95 页实测 0.08 秒，不需要 OCR，准确率也是 100%。
 *   扫描型 PDF 抽不出任何文字，以前的做法是「把页面图片发给视觉模型」，
 *   而且是**每个阶段各发一遍**（分析、事例、规划、总结、题、Lab 共 6 遍），
 *   既慢又贵。一本 224 页的扫描教材就是这么卡住的。
 *
 * 所以这里把它反过来：先一次性把整份扫描件认成文字，缓存起来，
 * 之后所有阶段都读文字，不再反复把同一批图片发给模型。
 *
 * 为什么不用 PaddleOCR / MinerU：
 *   它们要 Python 运行时 + 几百 MB 模型，而这个平台是「装个 Node、双击安装器」
 *   分发到学生机器上的，加不动这层依赖。视觉模型本来就已经配好了，
 *   批量跑一次同样能做到「整份一次跑完」；代价是花一点额度，
 *   但比原来 6 个阶段各发一遍图片便宜得多。
 *
 * 这个文件**不碰 Node 内置模块**（服务端和 GitHub Pages 静态版共用），
 * 缓存的读写由调用方通过 cache 适配器注入。
 */
import { completeJSON } from './ai/client.mjs';

/** 一次请求认几页。太大容易输出被截断，太小请求数太多 */
export const OCR_BATCH = 6;

/** 这份文件是不是扫描版（没有文字层） */
export function isScannedDoc(file) {
  const m = file?.meta || {};
  if (typeof m.scanned === 'boolean') return m.scanned;
  // 老数据没有 scanned 字段，按同样的规则补算
  const pages = Number(m.pages) || 0;
  if (!pages) return false;
  return Number(m.emptyPages || 0) > pages / 2;
}

/**
 * 这页算不算「没有文字」。
 * 除了空字符串，还要认 pdfjs 解析失败时写进去的占位符 ——
 * 它正好 8 个字，用长度阈值会漏掉。
 */
export function isBlankPageText(t) {
  const s = String(t || '').trim();
  return s.length < 8 || /^（本页解析失败/.test(s);
}

/**
 * 把识别出来的文字写回文件的 blocks（按页对齐），返回这次填了多少页。
 * 页面上本来就有文字的（文字型 PDF 的少数页）不覆盖。
 */
export function applyOcrToBlocks(blocks, texts) {
  let hit = 0;
  const out = (blocks || []).map((b) => {
    const n = Number(b.page ?? (String(b.label || '').match(/\d+/) || [])[0]);
    const t = n > 0 ? texts?.[n] : '';
    if (!t) return b;
    if (!isBlankPageText(b.text)) return b; // 本来就有文字层，尊重原文
    hit++;
    return { ...b, text: t, ocr: true };
  });
  return { blocks: out, hit };
}

export const OCR_SYSTEM = `你在帮学生把**扫描件/拍照件**的页面转成可检索的文字。

要求：
- 逐页**完整转录**页面上的文字，不要翻译、不要总结、不要解释、不要补充你没看到的内容。
- 保留原有的标题层级和条目顺序。
- 表格用 Markdown 表格还原。
- 公式用普通文本写清楚（能用 LaTeX 也行）。
- 如果页面上有图表、框图、电路图、示意图，在转录文字后面另起一行写
  \`[图] 一句话说明这张图画的是什么\`（只描述看得见的内容）。
- 页面上确实没有文字也没有图，text 写空字符串。
- 只输出 JSON，格式：{"pages":[{"page":页码,"text":"这一页的文字"}]}`;

/** 一次批量识别 */
export async function ocrBatch(cfg, batch, { signal } = {}) {
  const { data } = await completeJSON(cfg, {
    system: OCR_SYSTEM,
    images: batch.map((p) => p.dataUrl).filter(Boolean),
    user:
      `下面是 ${batch.length} 页扫描件，页码依次是 ${batch.map((p) => p.page).join('、')}。\n` +
      '请逐页转录，并严格按 {"pages":[{"page":页码,"text":"..."}]} 返回。',
    maxTokens: 8000,
    temperature: 0,
    signal,
    retries: 0,
  });
  const out = {};
  for (const item of data?.pages || []) {
    const n = Number(item?.page);
    if (n > 0) out[n] = String(item?.text ?? '').trim();
  }
  return out;
}

/**
 * 把一份扫描件的页面图片批量认成文字。
 *
 * @param {object} opts
 * @param {Array<{page:number,dataUrl:string}>} opts.pages 页面图（按页升序）
 * @param {object} opts.cfg
 * @param {{read:()=>Promise<object|null>, write:(pages:object)=>Promise<void>}} [opts.cache]
 *        缓存适配器。服务端落盘、静态版落 localStorage。
 * @param {(msg:string)=>void} [opts.emit]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{pages:Record<number,string>, done:number, total:number, fromCache:boolean}>}
 */
export async function ocrPages({ pages, cfg, emit = () => {}, signal, cache } = {}) {
  const list = (pages || []).filter((p) => p && p.dataUrl && Number(p.page) > 0);
  const total = list.length;
  if (!total) return { pages: {}, done: 0, total: 0, fromCache: false };

  const cached = (await cache?.read?.()) || null;
  const has = (o, n) => Object.prototype.hasOwnProperty.call(o, n);
  if (cached) {
    const done = list.filter((p) => has(cached, Number(p.page))).length;
    if (done === total) {
      emit(`这份扫描件之前已经识别过，直接复用缓存（${total} 页）`);
      return { pages: cached, done, total, fromCache: true };
    }
  }

  const acc = cached ? { ...cached } : {};
  // 还没认过的页才发出去 —— 中途失败也能续着跑
  const todo = list.filter((p) => !has(acc, Number(p.page)));
  emit(`这是扫描版 PDF：正在把 ${todo.length} 页的文字识别出来（只做一次，之后会缓存）`);

  let done = 0;
  for (let i = 0; i < todo.length; i += OCR_BATCH) {
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    const batch = todo.slice(i, i + OCR_BATCH);
    emit(`正在识别扫描件文字 ${Math.min(i + OCR_BATCH, todo.length)}/${todo.length} 页`);
    const got = await ocrBatch(cfg, batch, { signal });
    for (const p of batch) {
      // 模型偶尔漏页；漏的记成空串，避免下次又整份重跑
      acc[Number(p.page)] = got[Number(p.page)] ?? '';
    }
    done = i + batch.length;
    await cache?.write?.(acc);
  }
  return { pages: acc, done, total, fromCache: false };
}
