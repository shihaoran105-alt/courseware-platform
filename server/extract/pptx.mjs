/** PPTX 抽取：按真实放映顺序还原每一页的标题/正文/备注/配图 */
import JSZip from 'jszip';
import { cleanText, decodeEntities, matchAll, resolveZipPath } from './util.mjs';

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  emf: 'image/emf',
  wmf: 'image/wmf',
};

async function loadRels(zip, partFile) {
  const dir = partFile.split('/').slice(0, -1).join('/');
  const base = partFile.split('/').pop();
  const relsPath = `${dir}/_rels/${base}.rels`;
  const entry = zip.file(relsPath);
  const map = new Map();
  if (!entry) return map;
  const xml = await entry.async('string');
  for (const m of matchAll(xml, /<Relationship\b[^>]*\/?>/g)) {
    const tag = m[0];
    const id = (tag.match(/Id="([^"]*)"/) || [])[1];
    const target = (tag.match(/Target="([^"]*)"/) || [])[1];
    const type = (tag.match(/Type="([^"]*)"/) || [])[1] || '';
    if (id && target && !/^https?:/i.test(target) && !target.startsWith('/')) {
      // 关键：.rels 里的 Target 相对于「部件所在目录」，不是 _rels 目录
      map.set(id, { target: resolveZipPath(partFile, target), type, raw: target });
    }
  }
  return map;
}

/** 从一个 <p:sp> / <p:graphicFrame> 片段里抽取段落文本 */
function shapesFromSlideXml(xml) {
  const shapes = [];
  const shapeRe = /<p:(sp|graphicFrame)\b[\s\S]*?<\/p:\1>/g;
  for (const m of matchAll(xml, shapeRe)) {
    const chunk = m[0];
    const phType = (chunk.match(/<p:ph\b[^>]*\btype="([^"]*)"/) || [])[1] || '';
    const isTitle = /title|ctrTitle/i.test(phType) || /<p:ph\b[^>]*\btype="(title|ctrTitle)"/i.test(chunk);
    const paragraphs = [];
    for (const p of matchAll(chunk, /<a:p>[\s\S]*?<\/a:p>/g)) {
      const runs = matchAll(p[0], /<a:t>([\s\S]*?)<\/a:t>/g).map((r) => decodeEntities(r[1]));
      const text = runs.join('').replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push(text);
    }
    if (paragraphs.length) {
      shapes.push({ role: isTitle ? 'title' : 'body', paragraphs });
    }
  }
  return shapes;
}

function extractNotes(xml) {
  const paragraphs = [];
  for (const p of matchAll(xml, /<a:p>[\s\S]*?<\/a:p>/g)) {
    const runs = matchAll(p[0], /<a:t>([\s\S]*?)<\/a:t>/g).map((r) => decodeEntities(r[1]));
    const text = runs.join('').replace(/\s+/g, ' ').trim();
    if (text) paragraphs.push(text);
  }
  // 备注页最后常常是页码占位，去掉纯数字行
  return cleanText(paragraphs.filter((t) => !/^\d{1,3}$/.test(t)).join('\n'));
}

export async function extractPptx(buf, { name, mediaBase }) {
  const zip = await JSZip.loadAsync(buf);

  // 1. 放映顺序
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
  // 兜底：没有 sldIdLst 就按文件名排序
  if (!ordered.length) {
    ordered.push(
      ...Object.keys(zip.files)
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1])),
    );
  }

  const blocks = [];
  const media = [];
  const seenMedia = new Set();

  for (let i = 0; i < ordered.length; i++) {
    const slidePath = ordered[i];
    const entry = zip.file(slidePath);
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

    // 备注
    const slideRels = await loadRels(zip, slidePath);
    let notes = '';
    for (const rel of slideRels.values()) {
      if (/notesSlide$/.test(rel.type) || /notesSlide\d+\.xml$/.test(rel.target)) {
        const nEntry = zip.file(rel.target);
        if (nEntry) notes = extractNotes(await nEntry.async('string'));
        break;
      }
    }

    // 配图
    const images = [];
    for (const rel of slideRels.values()) {
      if (!/\/image$/.test(rel.type) && !/^ppt\/media\//.test(rel.target)) continue;
      const imgEntry = zip.file(rel.target);
      if (!imgEntry || seenMedia.has(rel.target)) continue;
      const ext = (rel.target.split('.').pop() || '').toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) continue;
      const data = await imgEntry.async('nodebuffer');
      if (data.length < 3 * 1024) continue; // 跳过小图标/项目符号图片
      seenMedia.add(rel.target);
      const fileName = `${i + 1}-${rel.target.split('/').pop()}`;
      images.push({ url: `${mediaBase}/${fileName}`, fileName, mime, buffer: data });
    }

    const textParts = [];
    if (title) textParts.push(`【标题】${title}`);
    if (bodyText.length) textParts.push(`【正文】\n${bodyText.map((t) => `· ${t}`).join('\n')}`);
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
    media.push(...images);
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
