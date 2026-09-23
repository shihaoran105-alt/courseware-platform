/**
 * 项目 / 项目组的导出与导入。
 *
 * 目标：**一个文件带走全部内容** —— 上传的课件、生成好的分析、讲解稿、
 * 做题记录、Lab 进度、两处对话，连课件原件的截图源（预览 PDF）都在里面。
 * 换一台机器、换一个部署，导进去就能接着用。
 *
 * 格式是一个 JSON 文档（后缀 .cwpack，其实叫什么都能导），媒体文件用 base64 内嵌，
 * 所以确实是「单个文件」，不依赖压缩包里的目录结构。
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR } from './store.mjs';

export const BUNDLE_FORMAT = 'courseware-platform.bundle';
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXT = '.cwpack';

/** 只搬这些字段；id / owner / 时间戳在导入时重新生成，避免串到别人的会话里 */
const PROJECT_FIELDS = [
  'name',
  'files',
  'analysis',
  'analysisStale',
  'chat',
  'attempts',
  'labProgress',
  'explain',
  'dockChat',
  'pageChat',
];

function fileToB64(p) {
  try {
    return fs.readFileSync(p).toString('base64');
  } catch {
    return '';
  }
}

/** 一个项目要用到哪些媒体文件（原文件、预览 PDF、PPTX 抽出来的图） */
function mediaNamesOf(project) {
  const names = new Set();
  for (const f of project.files || []) {
    if (f.storedName) names.add(path.basename(f.storedName));
    if (f.previewPdf) names.add(path.basename(f.previewPdf));
    for (const m of f.media || []) if (m.fileName) names.add(path.basename(m.fileName));
  }
  return [...names];
}

/**
 * 把若干项目打包成一个可迁移的对象。
 * @param {Array<object>} projects
 * @param {{version?:string, groupOf?:(p:object)=>object|null}} opts
 */
export function packProjects(projects, { version = '', groupOf = () => null } = {}) {
  const groups = [];
  const groupIndex = new Map();
  const out = [];

  for (const p of projects) {
    const g = groupOf(p);
    let ref = null;
    if (g) {
      if (!groupIndex.has(g.id)) {
        groupIndex.set(g.id, `g${groups.length}`);
        groups.push({ ref: groupIndex.get(g.id), name: g.name });
      }
      ref = groupIndex.get(g.id);
    }

    const data = {};
    for (const k of PROJECT_FIELDS) if (p[k] !== undefined) data[k] = p[k];

    const media = {};
    for (const name of mediaNamesOf(p)) {
      const b64 = fileToB64(path.join(MEDIA_DIR, p.id, name));
      if (b64) media[name] = b64;
    }
    out.push({ name: p.name, groupRef: ref, data, media });
  }

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    app: '课件讲解平台',
    appVersion: version,
    exportedAt: new Date().toISOString(),
    groups,
    projects: out,
  };
}

/** 校验并解析一个导入文件 */
export function parseBundle(raw) {
  let d = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try {
      d = JSON.parse(String(raw));
    } catch {
      throw new Error('这不是本平台导出的文件（解析失败）');
    }
  }
  if (!d || typeof d !== 'object') throw new Error('文件内容为空');
  if (d.format !== BUNDLE_FORMAT) {
    throw new Error('这不是本平台导出的文件（缺少格式标识）');
  }
  if (Number(d.version) > BUNDLE_VERSION) {
    throw new Error(`这个文件来自更新的版本（v${d.version}），请先更新平台再导入`);
  }
  const projects = Array.isArray(d.projects) ? d.projects : [];
  if (!projects.length) throw new Error('文件里没有项目');
  return {
    appVersion: String(d.appVersion || ''),
    exportedAt: String(d.exportedAt || ''),
    groups: Array.isArray(d.groups) ? d.groups : [],
    projects,
  };
}

/**
 * 把一个项目条目落成真正的项目对象：换新 id、重写媒体地址。
 * @param {object} entry 打包时的一个条目
 * @param {string} newId 新的项目 id
 * @param {string} mediaBase 形如 /media/<newId>
 */
export function materializeProject(entry, newId, mediaBase) {
  const data = JSON.parse(JSON.stringify(entry.data || {}));
  const rewrite = (u) => {
    const s = String(u || '');
    if (!s.startsWith('/media/')) return s;
    return `${mediaBase}/${path.basename(s)}`;
  };
  data.files = (data.files || []).map((f) => ({
    ...f,
    previewPdf: rewrite(f.previewPdf),
    mediaUrl: rewrite(f.mediaUrl),
    media: (f.media || []).map((m) => ({ ...m, url: rewrite(m.url) })),
  }));
  return {
    id: newId,
    name: String(entry.name || data.name || '导入的项目').slice(0, 120),
    files: data.files || [],
    analysis: data.analysis ?? null,
    analysisStale: Boolean(data.analysisStale),
    chat: data.chat || [],
    attempts: data.attempts || {},
    labProgress: data.labProgress || {},
    explain: data.explain || {},
    dockChat: data.dockChat || [],
    pageChat: data.pageChat || [],
  };
}

/** 把条目里的媒体写到新项目的目录下，返回写了几个文件 */
export function writeMedia(entry, newId) {
  const dir = path.join(MEDIA_DIR, newId);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const [name, b64] of Object.entries(entry.media || {})) {
    if (!b64) continue;
    const safe = path.basename(name);
    if (!safe || safe.includes('..')) continue;
    try {
      fs.writeFileSync(path.join(dir, safe), Buffer.from(String(b64), 'base64'));
      n++;
    } catch {
      /* 单个文件写失败不影响整体导入 */
    }
  }
  return n;
}
