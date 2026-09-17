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
  return {
    kind: 'pdf',
    name,
    blocks,
    meta: {
      pages: pageCount,
      emptyPages: imageOnly,
      note: imageOnly > pageCount / 2 ? '多数页面没有可提取文字，可能是扫描版 PDF（本平台暂不做 OCR）' : '',
    },
  };
}
