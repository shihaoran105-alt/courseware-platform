/** 抽取入口：按文件类型分发，并把多个文件拼成给模型的上文 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdf } from './pdf.mjs';
import { extractPptx } from './pptx.mjs';
import { extractDocx } from './docx.mjs';
import { extractText, blocksFromPlainText } from './text.mjs';
import { extractSheet } from './sheet.mjs';

export const DOC_EXTS = ['pdf', 'pptx', 'docx', 'doc', 'rtf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'xlsx', 'xlsm', 'json', 'html', 'htm'];
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
export const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm'];

export function extOf(name = '') {
  return (name.split('.').pop() || '').toLowerCase();
}

export function classify(name) {
  const ext = extOf(name);
  if (DOC_EXTS.includes(ext)) return 'document';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return 'unknown';
}

export const ACCEPT_HINT =
  '支持 PDF、PPTX、DOCX、DOC/RTF、TXT、Markdown、CSV/TSV、XLSX、JSON、HTML，以及图片/音视频附件';

/**
 * 抽取单个文件
 * @returns {{kind, name, blocks, media?, meta, text}}
 */
export async function extractFile({ buffer, originalName, storedPath, mediaBase }) {
  const name = originalName;
  const ext = extOf(name);
  const category = classify(name);

  if (category === 'image') {
    return {
      kind: 'image',
      name,
      blocks: [{ type: 'image', label: name, text: `（图片附件：${name}，本平台会在讲解界面中展示，但不对图片做文字识别）` }],
      meta: { category: 'image', note: '图片仅作展示，未做 OCR' },
    };
  }
  if (category === 'audio' || category === 'video') {
    return {
      kind: category,
      name,
      blocks: [{ type: category, label: name, text: `（${category === 'audio' ? '音频' : '视频'}附件：${name}）` }],
      meta: { category, note: '音视频未做转写' },
    };
  }
  if (category === 'unknown') {
    throw new Error(`不支持的文件类型：.${ext}。${ACCEPT_HINT}`);
  }

  switch (ext) {
    case 'pdf':
      return await extractPdf(buffer, { name });
    case 'pptx':
      return await extractPptx(buffer, { name, mediaBase });
    case 'docx':
    case 'doc':
    case 'rtf':
      return await extractDocx(buffer, { name, filePath: storedPath });
    case 'csv':
    case 'tsv':
    case 'xlsx':
    case 'xlsm':
      return await extractSheet(buffer, { name });
    case 'json': {
      const raw = buffer.toString('utf8');
      try {
        const pretty = JSON.stringify(JSON.parse(raw), null, 2);
        return withText(name, 'json', pretty, { chars: pretty.length });
      } catch {
        return withText(name, 'json', raw, { chars: raw.length });
      }
    }
    case 'html':
    case 'htm': {
      const raw = buffer.toString('utf8');
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
      return withText(name, 'html', text, {});
    }
    default:
      return extractText(buffer, { name });
  }
}

function withText(name, kind, text, meta) {
  return { kind, name, blocks: blocksFromPlainText(text), meta };
}

/** 汇总一个文件的纯文本（带行号标记，方便模型引用位置） */
export function fileToText(file) {
  return file.blocks
    .map((b) => {
      const tag = b.label && b.label !== '段落' ? `[${b.label}] ` : '';
      return `${tag}${b.text}`;
    })
    .join('\n\n');
}

/**
 * 把多个文件拼成模型上文，按预算做等比例截断
 */
export function buildContext(files, maxChars = 90000) {
  const usable = files.filter((f) => classify(f.originalName) === 'document' && f.text);
  if (!usable.length) return '';

  const headerSize = usable.reduce((n, f) => n + f.originalName.length + 80, 0);
  const budget = Math.max(maxChars - headerSize, 4000);
  const totalLen = usable.reduce((n, f) => n + f.text.length, 0);

  const parts = usable.map((f) => {
    let body = f.text;
    if (totalLen > budget) {
      const share = Math.max(Math.floor((f.text.length / totalLen) * budget), 1200);
      if (body.length > share) {
        const head = body.slice(0, Math.floor(share * 0.7));
        const tail = body.slice(-Math.floor(share * 0.25));
        body = `${head}\n\n……（此处省略 ${body.length - head.length - tail.length} 字，因课件较长被截断）……\n\n${tail}`;
      }
    }
    const metaBits = [];
    if (f.meta?.pages) metaBits.push(`${f.meta.pages} 页`);
    if (f.meta?.slides) metaBits.push(`${f.meta.slides} 页幻灯片`);
    if (f.meta?.withNotes) metaBits.push(`其中 ${f.meta.withNotes} 页含演讲者备注`);
    if (f.meta?.tables) metaBits.push(`${f.meta.tables} 个表格`);
    if (f.meta?.encoding && f.meta.encoding !== 'utf-8') metaBits.push(`编码 ${f.meta.encoding}`);
    return [
      `<<<文件开始>>>`,
      `文件名：${f.originalName}`,
      `类型：${f.kind}${metaBits.length ? `（${metaBits.join('，')}）` : ''}`,
      `内容：`,
      body,
      `<<<文件结束>>>`,
    ].join('\n');
  });

  return parts.join('\n\n');
}

export async function readUpload(storedPath) {
  return fs.readFile(storedPath);
}

export function safeJoin(dir, name) {
  const p = path.join(dir, path.basename(name));
  if (!p.startsWith(dir)) throw new Error('非法路径');
  return p;
}
