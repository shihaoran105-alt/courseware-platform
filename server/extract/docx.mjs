/** DOCX / DOC / RTF 抽取 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import { cleanText, matchAll, stripTags } from './util.mjs';

const execFileAsync = promisify(execFile);

/** 把 mammoth 输出的 HTML 拆成结构化 block */
function htmlToBlocks(html) {
  const blocks = [];
  const re = /<(h[1-6]|p|li|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const text = cleanText(stripTags(m[2]));
    if (!text) continue;
    if (tag.startsWith('h')) {
      blocks.push({ type: 'heading', level: Number(tag[1]), label: text.slice(0, 40), text });
    } else if (tag === 'li') {
      blocks.push({ type: 'bullet', label: '·', text: `· ${text}` });
    } else {
      blocks.push({ type: 'paragraph', label: '段落', text });
    }
  }
  // 表格聚合成一个 block
  const tables = [];
  for (const t of matchAll(html, /<table\b[\s\S]*?<\/table>/gi)) {
    const rows = matchAll(t[0], /<tr\b[\s\S]*?<\/tr>/gi).map((r) =>
      matchAll(r[0], /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi).map((c) => cleanText(stripTags(c[1]))),
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
  return { blocks, tables };
}

/** 老式 .doc / .rtf 用 macOS textutil 兜底 */
async function textutilConvert(filePath, to = 'txt') {
  const { stdout } = await execFileAsync('/usr/bin/textutil', ['-convert', to, '-stdout', filePath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function extractDocx(buf, { name, filePath }) {
  const ext = (name.split('.').pop() || '').toLowerCase();

  if (ext === 'doc' || ext === 'rtf') {
    try {
      const text = cleanText(await textutilConvert(filePath));
      return {
        kind: 'doc',
        name,
        blocks: text.split(/\n{2,}/).map((p) => ({
          type: /^[一二三四五六七八九十\d]+[、.．]/.test(p) ? 'heading' : 'paragraph',
          label: p.slice(0, 40),
          text: p.trim(),
        })),
        meta: { converter: 'textutil', chars: text.length },
      };
    } catch (err) {
      throw new Error(`无法解析 ${ext.toUpperCase()} 文件（textutil 转换失败：${err.message}）。建议另存为 .docx 后重试。`);
    }
  }

  const { value: html, messages } = await mammoth.convertToHtml(
    { buffer: buf },
    { styleMap: ['p[style-name="标题 1"] => h1:fresh', 'p[style-name="标题 2"] => h2:fresh'] },
  );
  const { blocks: rawBlocks, tables } = htmlToBlocks(html);
  const blocks = [...rawBlocks, ...tables];

  return {
    kind: 'docx',
    name,
    blocks,
    meta: {
      paragraphs: rawBlocks.filter((b) => b.type === 'paragraph').length,
      headings: rawBlocks.filter((b) => b.type === 'heading').length,
      tables: tables.length,
      warnings: (messages || []).filter((x) => x.type === 'warning').length,
    },
  };
}
