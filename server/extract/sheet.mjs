/** 表格类课件抽取：CSV / TSV 原生解析，XLSX 用 jszip 直接读 XML */
import JSZip from 'jszip';
import { decodeTextBuffer } from './text.mjs';
import { decodeEntities, matchAll } from './util.mjs';

/** RFC4180 风格的定界符解析 */
export function parseDelimited(text, delimiter) {
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
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function rowsToBlocks(rows, title) {
  const header = rows[0] || [];
  const body = rows.slice(1);
  const blocks = [
    {
      type: 'table',
      label: `${title}（共 ${rows.length} 行 × ${header.length} 列）`,
      text: [
        header.join(' | '),
        header.map(() => '---').join(' | '),
        ...body.map((r) => r.join(' | ')),
      ].join('\n'),
    },
  ];
  return blocks;
}

/** 极简 XLSX 读取：sharedStrings + 各 worksheet */
async function extractXlsx(buf, name) {
  const zip = await JSZip.loadAsync(buf);
  const shared = [];
  const ssEntry = zip.file('xl/sharedStrings.xml');
  if (ssEntry) {
    const xml = await ssEntry.async('string');
    for (const si of matchAll(xml, /<si>[\s\S]*?<\/si>/g)) {
      const parts = matchAll(si[0], /<t\b[^>]*>([\s\S]*?)<\/t>/g).map((m) => decodeEntities(m[1]));
      shared.push(parts.join(''));
    }
  }

  // sheet 名称
  const wbEntry = zip.file('xl/workbook.xml');
  const names = [];
  if (wbEntry) {
    const wb = await wbEntry.async('string');
    for (const s of matchAll(wb, /<sheet\b[^>]*\/?>/g)) {
      names.push((s[0].match(/name="([^"]*)"/) || [])[1] || `Sheet${names.length + 1}`);
    }
  }

  const blocks = [];
  const sheetFiles = Object.keys(zip.files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));

  for (let i = 0; i < sheetFiles.length; i++) {
    const xml = await zip.file(sheetFiles[i]).async('string');
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
  return { blocks, sheets: sheetFiles.length };
}

export async function extractSheet(buf, { name }) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xlsm') {
    const { blocks, sheets } = await extractXlsx(buf, name);
    return { kind: 'sheet', name, blocks, meta: { sheets, format: 'xlsx' } };
  }
  const { text, encoding } = decodeTextBuffer(buf);
  const delimiter = ext === 'tsv' ? '\t' : text.split('\n')[0].split(',').length >= text.split('\n')[0].split('\t').length ? ',' : '\t';
  const rows = parseDelimited(text, delimiter);
  const blocks = rows.length
    ? rowsToBlocks(rows, '数据表')
    : [{ type: 'table', label: '数据表', text: text.slice(0, 20000) }];
  return {
    kind: 'sheet',
    name,
    blocks,
    meta: { encoding, rows: rows.length, columns: rows[0]?.length || 0, delimiter: delimiter === '\t' ? 'TSV' : 'CSV' },
  };
}
