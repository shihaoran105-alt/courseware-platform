/** 项目存储：内存缓存 + data/cache 下的 JSON 持久化 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, DATA_DIR, isPublicMode } from './config.mjs';
import { buildContext } from './extract/index.mjs';
import { classifyRole, projectShape, roleLabel } from './roles.mjs';

export const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const projects = new Map();

function cacheFile(id) {
  return path.join(CACHE_DIR, `${id}.json`);
}

export function newId(prefix = 'p') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建项目
 * @param {string} name
 * @param {string} owner 会话 id（公开模式下用于隔离）
 * @param {{shared?: boolean}} opts shared=true 表示所有人可读的演示项目
 */
export function createProject(name = '未命名课件', owner = '', opts = {}) {
  const now = new Date().toISOString();
  const project = {
    id: newId(),
    name,
    owner,
    // 属于哪个项目组（空 = 未分组）
    groupId: opts.groupId || '',
    shared: Boolean(opts.shared),
    createdAt: now,
    updatedAt: now,
    files: [],
    analysis: null,
    chat: [],
    // 做题：题目 id → { answer, result, at }
    attempts: {},
    // 做 lab：lab id → { steps, records, result, at }
    labProgress: {},
    // 结合课件讲解：题目 id → { result, excerpt, at }
    explain: {},
    // 右侧 AI 咨询的对话历史（和「课件问答」分开存）
    dockChat: [],
  };
  projects.set(project.id, project);
  persist(project);
  return project;
}

export function getProject(id) {
  if (projects.has(id)) return projects.get(id);
  const file = cacheFile(id);
  if (fs.existsSync(file)) {
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 只有长得像项目的才收，防止别处的 JSON 被当项目塞进内存
      if (!p || typeof p !== 'object' || !p.id || !Array.isArray(p.files)) return null;
      projects.set(p.id, p);
      return p;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 老项目（会话功能上线前建的）没有 owner。
 * 本机模式下继续当成本地项目放行，公开模式下则严格隔离。
 */
function isLegacyLocal(project) {
  return !project.owner && !isPublicMode();
}

/** 能不能看：自己的、公开的演示项目、或本机模式下的老项目 */
export function canAccess(project, sid) {
  if (!project) return false;
  if (project.shared) return true;
  if (isLegacyLocal(project)) return true;
  return Boolean(sid) && project.owner === sid;
}

/** 能不能改：只有自己的项目；演示项目对别人只读 */
export function canEdit(project, sid) {
  if (!project) return false;
  if (isLegacyLocal(project)) return true;
  return Boolean(sid) && project.owner === sid;
}

/** 列出该会话可见的项目（自己的 + 共享演示） */
export function listProjects(sid) {
  loadAll();
  return [...projects.values()]
    .filter((p) => canAccess(p, sid))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map((p) => ({
      id: p.id,
      name: p.name,
      // 属于哪个项目组（空 = 未分组）
      groupId: p.groupId || '',
      shared: Boolean(p.shared),
      isMine: canEdit(p, sid),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      fileCount: p.files.length,
      hasAnalysis: Boolean(p.analysis),
      totalChars: p.files.reduce((n, f) => n + (f.chars || 0), 0),
      // 侧边栏要显示每份材料齐不齐，顺手带上
      roleCount: (p.files || []).reduce((m, f) => {
        const r = f.role || classifyRole(f.originalName, f.kind);
        m[r] = (m[r] || 0) + 1;
        return m;
      }, {}),
    }));
}

/** 某会话自己的项目数（用来做配额） */
export function countOwnedProjects(sid) {
  loadAll();
  let n = 0;
  for (const p of projects.values()) if (canEdit(p, sid)) n++;
  return n;
}

/** 清掉过期项目的磁盘数据（上传文件 / 配图 / 缓存），默认 14 天 */
export function cleanupExpiredProjects(ttlDays = 14) {
  const cutoff = Date.now() - ttlDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const [id, p] of projects) {
    const ts = Date.parse(p.updatedAt || p.createdAt || 0) || 0;
    if (ts && ts < cutoff) {
      deleteProject(id);
      removed++;
    }
  }
  return removed;
}

export function persist(project) {
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(cacheFile(project.id), JSON.stringify(project), 'utf8');
  return project;
}

export function deleteProject(id) {
  projects.delete(id);
  const f = cacheFile(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  const mediaDir = path.join(MEDIA_DIR, id);
  if (fs.existsSync(mediaDir)) fs.rmSync(mediaDir, { recursive: true, force: true });
}

/** 遍历所有项目（启动补齐数据用） */
export function forEachProject(fn) {
  loadAll();
  for (const p of projects.values()) fn(p);
}

export function loadAll() {
  if (!fs.existsSync(CACHE_DIR)) return;
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!name.endsWith('.json')) continue;
    // 下划线开头的是元数据文件（如分组表），不是项目，不能当项目加载
    if (name.startsWith('_')) continue;
    const id = name.replace(/\.json$/, '');
    if (projects.has(id)) continue;
    getProject(id);
  }
}

/** 组装给模型用的 { list, context } */
export function contextFor(project, maxChars) {
  const list = project.files.map((f) => ({
    ...f,
    text: f.text || '',
  }));
  return { list, context: buildContext(list, maxChars) };
}

/** 去掉体积大又不需要回传前端的内容 */
export function slimProject(project, sid = '') {
  return {
    id: project.id,
    name: project.name,
    groupId: project.groupId || '',
    shared: Boolean(project.shared),
    isMine: canEdit(project, sid),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    analysis: project.analysis,
    analysisStale: Boolean(project.analysisStale),
    chat: project.chat,
    attempts: project.attempts || {},
    labProgress: project.labProgress || {},
    explain: project.explain || {},
    dockChat: project.dockChat || [],
    aiChat: project.chat || [],
    shape: projectShape(project.files || []),
    files: project.files.map((f) => ({
      id: f.id,
      originalName: f.originalName,
      kind: f.kind,
      role: f.role || classifyRole(f.originalName, f.kind),
      roleLabel: f.roleLabel || roleLabel(f.role || classifyRole(f.originalName, f.kind)),
      size: f.size,
      chars: f.chars,
      meta: f.meta,
      // 「课件原文」区域靠这个 PDF 在浏览器里逐页渲染成截图
      previewPdf: f.previewPdf || '',
      previewNote: f.previewNote || '',
      // 上课录像的播放地址
      mediaUrl: f.mediaUrl || '',
      media: (f.media || []).map((m) => ({ url: m.url, fileName: m.fileName })),
      blockCount: f.blocks?.length || 0,
      // 讲解模式需要原文对照，这里带上每个块（单块文字截断，避免响应过大）
      blocks: (f.blocks || []).map((b) => ({
        label: b.label,
        type: b.type,
        index: b.index,
        page: b.page,
        title: b.title,
        images: b.images || [],
        text: String(b.text || '').slice(0, 2500),
      })),
      preview: (f.preview || '').slice(0, 600),
    })),
  };
}
