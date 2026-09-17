/** 纯文本 / Markdown 抽取，自动识别 UTF-8 / GBK / UTF-16 编码 */
import iconv from 'iconv-lite';

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const CN_HEADING_RE = /^第\s*[一二三四五六七八九十百零\d]+\s*[章节讲部分课题]\s*[、.．:：]?\s*(.*)$/;
const LIST_RE = /^\s*([-*+•·]|\d+[.、)）])\s+/;

export function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8 (BOM)' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf, 'utf16le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf, 'utf16be'), encoding: 'utf-16be' };
  }
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad === 0 || bad / Math.max(utf8.length, 1) < 0.002) {
    return { text: utf8, encoding: 'utf-8' };
  }
  const gbk = iconv.decode(buf, 'gbk');
  const badGbk = (gbk.match(/\uFFFD/g) || []).length;
  return badGbk < bad
    ? { text: gbk, encoding: 'gbk/gb18030' }
    : { text: utf8, encoding: 'utf-8 (有乱码)' };
}

export function blocksFromPlainText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];

  const flush = () => {
    if (!para.length) return;
    const joined = para.join('\n').trim();
    para = [];
    if (!joined) return;
    // 超长段落再切分，便于模型引用
    const CHUNK = 1200;
    for (let i = 0; i < joined.length; i += CHUNK) {
      const piece = joined.slice(i, i + CHUNK);
      blocks.push({
        type: 'paragraph',
        label: i === 0 ? '段落' : '段落（续）',
        text: piece,
      });
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
      blocks.push({
        type: 'heading',
        level: md[1].length,
        label: md[2].trim().slice(0, 40),
        text: md[2].trim(),
      });
      continue;
    }
    const cn = line.trim().match(CN_HEADING_RE);
    if (cn && line.trim().length <= 40) {
      flush();
      blocks.push({ type: 'heading', level: 2, label: line.trim().slice(0, 40), text: line.trim() });
      continue;
    }
    if (LIST_RE.test(line)) {
      para.push(`· ${line.trim().replace(LIST_RE, '')}`);
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

export function extractText(buf, { name }) {
  const { text, encoding } = decodeTextBuffer(buf);
  const blocks = blocksFromPlainText(text);
  return {
    kind: 'text',
    name,
    blocks,
    meta: {
      encoding,
      chars: text.length,
      lines: text.split('\n').length,
      headings: blocks.filter((b) => b.type === 'heading').length,
    },
  };
}
