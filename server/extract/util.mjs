/** 通用小工具：XML 实体解码、路径规范化、文本清理 */

export function decodeEntities(s = '') {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? m;
  });
}

/** 把 ../ 之类的相对路径解析成 zip 内的绝对路径 */
export function resolveZipPath(baseFile, target) {
  const baseParts = baseFile.split('/').slice(0, -1);
  const parts = target.split('/');
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') baseParts.pop();
    else baseParts.push(p);
  }
  return baseParts.join('/');
}

export function cleanText(s = '') {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 XML 中抽取所有匹配片段 */
export function matchAll(xml, re) {
  const out = [];
  let m;
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = rx.exec(xml)) !== null) {
    out.push(m);
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return out;
}

export function stripTags(html = '') {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}
