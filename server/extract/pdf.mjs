/** PDF 逐页文字抽取（pdfjs-dist，Node 环境无 worker 模式） */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cleanText } from './util.mjs';

/** 把一页的 textContent 按 y 坐标还原成行 */
function pageToLines(content) {
  const items = (content.items || []).filter((it) => typeof it.str === 'string');
  const rows = new Map();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = Math.round((it.transform?.[5] ?? 0) / 3) * 3;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: it.transform?.[4] ?? 0, str: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF 的 y 轴向上
    .map(([, parts]) =>
      parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

export async function extractPdf(buf, { name }) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0,
  }).promise;

  const blocks = [];
  const pageCount = doc.numPages;
  for (let i = 1; i <= pageCount; i++) {
    let lines = [];
    try {
      const page = await doc.getPage(i);
      lines = pageToLines(await page.getTextContent());
      page.cleanup();
    } catch (err) {
      lines = [`（本页解析失败：${err.message}）`];
    }
    blocks.push({
      type: 'page',
      label: `第 ${i} 页`,
      page: i,
      text: cleanText(lines.join('\n')),
    });
  }
  try {
    await doc.destroy();
  } catch {
    /* 忽略 */
  }

  const imageOnly = blocks.filter((b) => b.text.length < 8).length;
  const totalChars = blocks.reduce((n, b) => n + b.text.length, 0);
  // 有没有文字层，决定后面走哪条路：
  //   文字型 → 直接抽文字就够了，根本不用转图片，更不用 OCR（95 页实测 0.08 秒）
  //   扫描型 → 抽不出字，得先把图上的字认出来（见 server/ocr.mjs）
  const scanned = imageOnly > pageCount / 2;
  return {
    kind: 'pdf',
    name,
    blocks,
    meta: {
      pages: pageCount,
      textChars: totalChars,
      textPages: pageCount - imageOnly,
      emptyPages: imageOnly,
      scanned,
      note: scanned
        ? '这份 PDF 没有可提取的文字层（扫描件/拍照件）。生成时会先用视觉模型把每页文字批量识别出来，只做一次并缓存'
        : '',
    },
  };
}
