/* ============================================================
   浏览器端文件解析（静态版专用）
   依赖：pdf.js（PDF）、JSZip（PPTX/DOCX/XLSX）
   与 server/extract/ 保持同样的输出结构：{ kind, name, blocks, media, meta, text }
   ============================================================ */

/* ------------------------------ 依赖自举 ------------------------------ */

/**
 * 保证 pdf.js / JSZip 已就绪。
 * 正常情况下 static-boot.js 和 index.html 已经把它们准备好了；
 * 这里再兜一次底，避免脚本顺序变化就整个解析不了。
 */
let libsReady = null;
function ensureLibs() {
  if (libsReady) return libsReady;
  libsReady = (async () => {
    if (window.pdfjsReady) {
      await window.pdfjsReady;
    } else if (!window.pdfjsLib) {
      const m = await import('../vendor/pdf.min.mjs');
      m.GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.min.mjs';
      window.pdfjsLib = m;
    }
    if (!window.JSZip) {
      await import('../vendor/jszip.min.js');
    }
  })();
  return libsReady;
}

/* ------------------------------ 小工具 ------------------------------ */

function decodeEntities(s = '') {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

function cleanText(s = '') {
  return String(s).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function matchAll(xml, re) {
  const out = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = rx.exec(xml)) !== null) {
    out.push(m);
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return out;
}

function resolveZipPath(baseFile, target) {
  const baseParts = baseFile.split('/').slice(0, -1);
  for (const p of target.split('/')) {
    if (p === '.' || p === '') continue;
    if (p === '..') baseParts.pop();
    else baseParts.push(p);
  }
  return baseParts.join('/');
}

function stripTags(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && String(x).trim() !== '') : []);

/* ------------------------------ 编码嗅探 ------------------------------ */

/** 浏览器原生支持 gbk 解码，不需要 iconv-lite */
function decodeBuffer(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8 (BOM)' };
  }
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(u8), encoding: 'utf-16le' };
  }
  const utf8 = new TextDecoder('utf-8').decode(u8);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad === 0 || bad / Math.max(utf8.length, 1) < 0.002) return { text: utf8, encoding: 'utf-8' };
  try {
    const gbk = new TextDecoder('gbk').decode(u8);
    const badGbk = (gbk.match(/\uFFFD/g) || []).length;
    if (badGbk < bad) return { text: gbk, encoding: 'gbk/gb18030' };
  } catch {
    /* 浏览器不支持 gbk 时忽略 */
  }
  return { text: utf8, encoding: 'utf-8 (有乱码)' };
}

/* ------------------------------ 纯文本 / Markdown ------------------------------ */

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const CN_HEADING_RE = /^第\s*[一二三四五六七八九十百零\d]+\s*[章节讲部分课题]\s*[、.．:：]?\s*(.*)$/;
const LIST_RE = /^\s*([-*+•·]|\d+[.、)）])\s+/;

function blocksFromPlainText(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const joined = para.join('\n').trim();
    para = [];
    if (!joined) return;
    const CHUNK = 1200;
    for (let i = 0; i < joined.length; i += CHUNK) {
      blocks.push({ type: 'paragraph', label: i === 0 ? '段落' : '段落（续）', text: joined.slice(i, i + CHUNK) });
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    const md = line.match(HEADING_RE);
    if (md) {
      flush();
      blocks.push({ type: 'heading', level: md[1].length, label: md[2].trim().slice(0, 40), text: md[2].trim() });
      continue;
    }
    const cn = line.trim().match(CN_HEADING_RE);
    if (cn && line.trim().length <= 40) {
      flush();
      blocks.push({ type: 'heading', level: 2, label: line.trim().slice(0, 40), text: line.trim() });
      continue;
    }
    if (LIST_RE.test(line)) {
      para.push('· ' + line.trim().replace(LIST_RE, ''));
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/* ------------------------------ PDF ------------------------------ */

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
    .sort((a, b) => b[0] - a[0])
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

async function extractPdf(buf, name) {
  // boot.js 会预加载 pdf.js，这里等它ready
  if (window.pdfjsReady) await window.pdfjsReady;
  const pdfjs = window.pdfjsLib;
  if (!pdfjs) throw new Error('pdf.js 未加载，无法解析 PDF');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 }).promise;
  const blocks = [];
  for (let i = 1; i <= doc.numPages; i++) {
    let lines = [];
    try {
      const page = await doc.getPage(i);
      lines = pageToLines(await page.getTextContent());
      page.cleanup();
    } catch (err) {
      lines = ['（本页解析失败：' + err.message + '）'];
    }
    blocks.push({ type: 'page', label: `第 ${i} 页`, page: i, text: cleanText(lines.join('\n')) });
  }
  const empty = blocks.filter((b) => b.text.length < 8).length;
  try {
    await doc.destroy();
  } catch {
    /* 忽略 */
  }
  return {
    kind: 'pdf',
    name,
    blocks,
    meta: {
      pages: doc.numPages,
      emptyPages: empty,
      note: empty > doc.numPages / 2 ? '多数页面没有可提取文字，可能是扫描版 PDF（本平台暂不做 OCR）' : '',
    },
  };
}

/* ------------------------------ PPTX ------------------------------ */

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

async function loadRels(zip, partFile) {
  const dir = partFile.split('/').slice(0, -1).join('/');
  const base = partFile.split('/').pop();
  const entry = zip.file(`${dir}/_rels/${base}.rels`);
  const map = new Map();
  if (!entry) return map;
  const xml = await entry.async('string');
  for (const m of matchAll(xml, /<Relationship\b[^>]*\/?>/g)) {
    const tag = m[0];
    const id = (tag.match(/Id="([^"]*)"/) || [])[1];
    const target = (tag.match(/Target="([^"]*)"/) || [])[1];
    const type = (tag.match(/Type="([^"]*)"/) || [])[1] || '';
    if (id && target && !/^https?:/i.test(target) && !target.startsWith('/')) {
      map.set(id, { target: resolveZipPath(partFile, target), type });
    }
  }
  return map;
}

function shapesFromSlideXml(xml) {
  const shapes = [];
  for (const m of matchAll(xml, /<p:(sp|graphicFrame)\b[\s\S]*?<\/p:\1>/g)) {
    const chunk = m[0];
    const phType = (chunk.match(/<p:ph\b[^>]*\btype="([^"]*)"/) || [])[1] || '';
    const isTitle = /title|ctrTitle/i.test(phType);
    const paragraphs = [];
    for (const p of matchAll(chunk, /<a:p>[\s\S]*?<\/a:p>/g)) {
      const text = matchAll(p[0], /<a:t>([\s\S]*?)<\/a:t>/g)
        .map((r) => decodeEntities(r[1]))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) paragraphs.push(text);
    }
    if (paragraphs.length) shapes.push({ role: isTitle ? 'title' : 'body', paragraphs });
  }
  return shapes;
}

function extractNotes(xml) {
  const paragraphs = [];
  for (const p of matchAll(xml, /<a:p>[\s\S]*?<\/a:p>/g)) {
    const text = matchAll(p[0], /<a:t>([\s\S]*?)<\/a:t>/g)
      .map((r) => decodeEntities(r[1]))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) paragraphs.push(text);
  }
  return cleanText(paragraphs.filter((t) => !/^\d{1,3}$/.test(t)).join('\n'));
}

/** 图片太大就不内嵌，避免把 IndexedDB 撑爆 */
const MAX_MEDIA_BYTES = 400 * 1024;
const MAX_MEDIA_COUNT = 24;

async function extractPptx(buf, name) {
  const zip = await window.JSZip.loadAsync(buf);
  const presEntry = zip.file('ppt/presentation.xml');
  const presXml = presEntry ? await presEntry.async('string') : '';
  const presRels = await loadRels(zip, 'ppt/presentation.xml');
  const slideSize = presXml.match(/<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  const aspect = slideSize ? Number(slideSize[1]) / Number(slideSize[2]) : 16 / 9;

  const ordered = [];
  for (const m of matchAll(presXml, /<p:sldId\b[^>]*\/?>/g)) {
    const rid = (m[0].match(/r:id="([^"]*)"/) || [])[1];
    const rel = rid ? presRels.get(rid) : null;
    if (rel) ordered.push(rel.target);
  }
  if (!ordered.length) {
    ordered.push(
      ...Object.keys(zip.files)
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1])),
    );
  }

  const blocks = [];
  const media = [];
  const seen = new Set();

  for (let i = 0; i < ordered.length; i++) {
    const entry = zip.file(ordered[i]);
    if (!entry) continue;
    const xml = await entry.async('string');
    const shapes = shapesFromSlideXml(xml);

    const titleShape = shapes.find((s) => s.role === 'title');
    const title = titleShape ? titleShape.paragraphs.join(' ') : '';
    const titleSet = new Set(titleShape ? titleShape.paragraphs : []);
    const bodyText = shapes
      .filter((s) => s !== titleShape)
      .flatMap((s) => s.paragraphs)
      .filter((t) => !titleSet.has(t));

    const slideRels = await loadRels(zip, ordered[i]);
    let notes = '';
    for (const rel of slideRels.values()) {
      if (/notesSlide$/.test(rel.type) || /notesSlide\d+\.xml$/.test(rel.target)) {
        const nEntry = zip.file(rel.target);
        if (nEntry) notes = extractNotes(await nEntry.async('string'));
        break;
      }
    }

    const images = [];
    for (const rel of slideRels.values()) {
      if (!/\/image$/.test(rel.type) && !/^ppt\/media\//.test(rel.target)) continue;
      if (seen.has(rel.target) || media.length >= MAX_MEDIA_COUNT) continue;
      const imgEntry = zip.file(rel.target);
      if (!imgEntry) continue;
      const ext = (rel.target.split('.').pop() || '').toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) continue;
      const data = await imgEntry.async('uint8array');
      if (data.length < 3 * 1024 || data.length > MAX_MEDIA_BYTES) continue;
      seen.add(rel.target);
      const blob = new Blob([data], { type: mime });
      const url = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      });
      const fileName = `${i + 1}-${rel.target.split('/').pop()}`;
      images.push({ url, fileName, mime });
      media.push({ url, fileName, mime });
    }

    const textParts = [];
    if (title) textParts.push(`【标题】${title}`);
    if (bodyText.length) textParts.push(`【正文】\n${bodyText.map((t) => '· ' + t).join('\n')}`);
    if (notes) textParts.push(`【演讲者备注】\n${notes}`);

    blocks.push({
      type: 'slide',
      label: `第 ${i + 1} 页幻灯片`,
      index: i + 1,
      title: title || `第 ${i + 1} 页`,
      bullets: bodyText,
      notes,
      images: images.map((im) => ({ url: im.url, fileName: im.fileName, mime: im.mime })),
      text: cleanText(textParts.join('\n\n')),
    });
  }

  return {
    kind: 'pptx',
    name,
    blocks,
    media,
    meta: {
      slides: blocks.length,
      withNotes: blocks.filter((b) => b.notes).length,
      images: media.length,
      aspect,
    },
  };
}

/* ------------------------------ DOCX ------------------------------ */

async function extractDocx(buf, name) {
  const zip = await window.JSZip.loadAsync(buf);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('这个 DOCX 里找不到 word/document.xml，可能文件已损坏');
  const xml = await entry.async('string');

  const blocks = [];
  for (const p of matchAll(xml, /<w:p\b[\s\S]*?<\/w:p>/g)) {
    const chunk = p[0];
    const style = (chunk.match(/<w:pStyle\b[^>]*w:val="([^"]*)"/) || [])[1] || '';
    const text = cleanText(
      matchAll(chunk, /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)
        .map((m) => decodeEntities(m[1]))
        .join(''),
    );
    if (!text) continue;
    const h = style.match(/^Heading(\d)$/i) || style.match(/^(\d)$/);
    if (h) blocks.push({ type: 'heading', level: Number(h[1]), label: text.slice(0, 40), text });
    else if (/ListParagraph/i.test(style)) blocks.push({ type: 'bullet', label: '·', text: '· ' + text });
    else blocks.push({ type: 'paragraph', label: '段落', text });
  }

  const tables = [];
  for (const t of matchAll(xml, /<w:tbl\b[\s\S]*?<\/w:tbl>/g)) {
    const rows = matchAll(t[0], /<w:tr\b[\s\S]*?<\/w:tr>/g).map((r) =>
      matchAll(r[0], /<w:tc\b[\s\S]*?<\/w:tc>/g).map((c) =>
        cleanText(
          matchAll(c[0], /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)
            .map((m) => decodeEntities(m[1]))
            .join(''),
        ),
      ),
    );
    const body = rows.filter((r) => r.some(Boolean));
    if (body.length) {
      tables.push({
        type: 'table',
        label: `表格 ${tables.length + 1}`,
        text: body.map((r) => r.join(' | ')).join('\n'),
      });
    }
  }

  return {
    kind: 'docx',
    name,
    blocks: [...blocks, ...tables],
    meta: {
      paragraphs: blocks.filter((b) => b.type === 'paragraph').length,
      headings: blocks.filter((b) => b.type === 'heading').length,
      tables: tables.length,
    },
  };
}

/* ------------------------------ 表格 ------------------------------ */

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function rowsToBlocks(rows, title) {
  const header = rows[0] || [];
  return [
    {
      type: 'table',
      label: `${title}（共 ${rows.length} 行 × ${header.length} 列）`,
      text: [header.join(' | '), header.map(() => '---').join(' | '), ...rows.slice(1).map((r) => r.join(' | '))].join('\n'),
    },
  ];
}

async function extractXlsx(buf, name) {
  const zip = await window.JSZip.loadAsync(buf);
  const shared = [];
  const ssEntry = zip.file('xl/sharedStrings.xml');
  if (ssEntry) {
    const xml = await ssEntry.async('string');
    for (const si of matchAll(xml, /<si>[\s\S]*?<\/si>/g)) {
      shared.push(matchAll(si[0], /<t\b[^>]*>([\s\S]*?)<\/t>/g).map((m) => decodeEntities(m[1])).join(''));
    }
  }
  const wbEntry = zip.file('xl/workbook.xml');
  const names = [];
  if (wbEntry) {
    for (const s of matchAll(await wbEntry.async('string'), /<sheet\b[^>]*\/?>/g)) {
      names.push((s[0].match(/name="([^"]*)"/) || [])[1] || `Sheet${names.length + 1}`);
    }
  }
  const blocks = [];
  const files = Object.keys(zip.files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  for (let i = 0; i < files.length; i++) {
    const xml = await zip.file(files[i]).async('string');
    const rows = [];
    for (const r of matchAll(xml, /<row\b[\s\S]*?<\/row>/g)) {
      const cells = [];
      for (const c of matchAll(r[0], /<c\b[^>]*>[\s\S]*?<\/c>/g)) {
        const tag = c[0];
        const type = (tag.match(/t="([^"]*)"/) || [])[1];
        let value = '';
        if (type === 'inlineStr') {
          value = matchAll(tag, /<t\b[^>]*>([\s\S]*?)<\/t>/g).map((m) => decodeEntities(m[1])).join('');
        } else {
          const v = tag.match(/<v>([\s\S]*?)<\/v>/);
          const raw = v ? decodeEntities(v[1]) : '';
          value = type === 's' ? shared[Number(raw)] ?? '' : raw;
        }
        cells.push(value.replace(/\s+/g, ' ').trim());
      }
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) blocks.push(...rowsToBlocks(rows, names[i] || `工作表 ${i + 1}`));
  }
  return { kind: 'sheet', name, blocks, meta: { sheets: files.length, format: 'xlsx' } };
}

/* ------------------------------ 入口 ------------------------------ */

export const DOC_EXTS = ['pdf', 'pptx', 'docx', 'txt', 'md', 'markdown', 'csv', 'tsv', 'xlsx', 'xlsm', 'json', 'html', 'htm'];
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
export const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm'];

export const ACCEPT_HINT = '支持 PDF、PPTX、DOCX、TXT、Markdown、CSV/TSV、XLSX、JSON、HTML，以及图片/音视频附件';

export const extOf = (name = '') => (name.split('.').pop() || '').toLowerCase();

export function classify(name) {
  const ext = extOf(name);
  if (DOC_EXTS.includes(ext)) return 'document';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return 'unknown';
}

export async function extractFile(file) {
  await ensureLibs();
  const name = file.name;
  const ext = extOf(name);
  const category = classify(name);

  if (category === 'image' || category === 'audio' || category === 'video') {
    const label = { image: '图片', audio: '音频', video: '视频' }[category];
    return {
      kind: category,
      name,
      blocks: [{ type: category, label: name, text: `（${label}附件：${name}，本平台会展示但不做文字识别/转写）` }],
      meta: { category, note: `${label}仅作展示` },
    };
  }
  if (category === 'unknown') {
    throw new Error(`不支持的文件类型：.${ext}。${ACCEPT_HINT}`);
  }

  const buf = await file.arrayBuffer();

  switch (ext) {
    case 'pdf':
      return await extractPdf(buf, name);
    case 'pptx':
      return await extractPptx(buf, name);
    case 'docx':
      return await extractDocx(buf, name);
    case 'csv':
    case 'tsv': {
      const { text, encoding } = decodeBuffer(buf);
      const delimiter = ext === 'tsv' ? '\t' : ',';
      const rows = parseDelimited(text, delimiter);
      return {
        kind: 'sheet',
        name,
        blocks: rows.length ? rowsToBlocks(rows, '数据表') : [{ type: 'table', label: '数据表', text: text.slice(0, 20000) }],
        meta: { encoding, rows: rows.length, columns: rows[0]?.length || 0, delimiter: delimiter === '\t' ? 'TSV' : 'CSV' },
      };
    }
    case 'xlsx':
    case 'xlsm':
      return await extractXlsx(buf, name);
    case 'json': {
      const raw = new TextDecoder('utf-8').decode(buf);
      let pretty = raw;
      try {
        pretty = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        /* 保持原样 */
      }
      return { kind: 'json', name, blocks: blocksFromPlainText(pretty), meta: { chars: pretty.length } };
    }
    case 'html':
    case 'htm': {
      const raw = new TextDecoder('utf-8').decode(buf);
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '\n');
      return { kind: 'html', name, blocks: blocksFromPlainText(text), meta: {} };
    }
    default: {
      const { text, encoding } = decodeBuffer(buf);
      const blocks = blocksFromPlainText(text);
      return {
        kind: 'text',
        name,
        blocks,
        meta: { encoding, chars: text.length, lines: text.split('\n').length, headings: blocks.filter((b) => b.type === 'heading').length },
      };
    }
  }
}

/** 汇总一个文件的纯文本 */
export function fileToText(file) {
  return file.blocks.map((b) => (b.label && b.label !== '段落' ? `[${b.label}] ${b.text}` : b.text)).join('\n\n');
}

/** 把多个文件拼成模型上下文（与服务器版同样的等比例截断策略） */
export function buildContext(files, maxChars = 90000) {
  const usable = files.filter((f) => classify(f.originalName) === 'document' && f.text);
  if (!usable.length) return '';
  const headerSize = usable.reduce((n, f) => n + f.originalName.length + 80, 0);
  const budget = Math.max(maxChars - headerSize, 4000);
  const totalLen = usable.reduce((n, f) => n + f.text.length, 0);

  return usable
    .map((f) => {
      let body = f.text;
      if (totalLen > budget) {
        const share = Math.max(Math.floor((f.text.length / totalLen) * budget), 1200);
        if (body.length > share) {
          const head = body.slice(0, Math.floor(share * 0.7));
          const tail = body.slice(-Math.floor(share * 0.25));
          body = `${head}\n\n……（此处省略 ${body.length - head.length - tail.length} 字，因课件较长被截断）……\n\n${tail}`;
        }
      }
      const bits = [];
      if (f.meta?.pages) bits.push(`${f.meta.pages} 页`);
      if (f.meta?.slides) bits.push(`${f.meta.slides} 页幻灯片`);
      if (f.meta?.withNotes) bits.push(`其中 ${f.meta.withNotes} 页含演讲者备注`);
      if (f.meta?.tables) bits.push(`${f.meta.tables} 个表格`);
      if (f.meta?.encoding && f.meta.encoding !== 'utf-8') bits.push(`编码 ${f.meta.encoding}`);
      return [
        '<<<文件开始>>>',
        `文件名：${f.originalName}`,
        `类型：${f.kind}${bits.length ? `（${bits.join('，')}）` : ''}`,
        '内容：',
        body,
        '<<<文件结束>>>',
      ].join('\n');
    })
    .join('\n\n');
}

export { arr, cleanText };
