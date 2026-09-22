/** 课件讲解平台 — HTTP 服务 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';

import {
  DATA_DIR,
  NeedKeyError,
  CACHE_DIR,
  PUBLIC_DIR,
  UPLOAD_DIR,
  isPublicMode,
  loadServerConfig,
  publicConfig,
  resolveRequestConfig,
  saveConfig,
  serverKey,
} from './config.mjs';
import { VERSION_FILE, readVersion } from './version.mjs';
import { isSafeUrl, remoteStatus, setUpdateCheckUrl, updateCheckUrl } from './update-check.mjs';
import { launchUpdateHelper, prepareUpdate } from './self-update.mjs';
import { normalizeStages } from './stages.mjs';
import { chromeState, rasterizePdf, pageStats, selectPages } from './render-pages.mjs';
import { readModeOf, READ_MODE_LABEL } from './page-select.mjs';
import { isScannedDoc, isBlankPageText, ocrPages, applyOcrToBlocks } from './ocr.mjs';
import {
  MEDIA_DIR,
  canAccess,
  cleanupExpiredProjects,
  contextFor,
  countOwnedProjects,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  newId,
  persist,
  slimProject,
} from './store.mjs';
import { QUOTAS, addBytes, checkRate, overStorage, sessionMiddleware, sweepSessions } from './session.mjs';
import {
  canEditGroup,
  createGroup,
  deleteGroup,
  getGroup,
  groupExists,
  listGroups,
  renameGroup,
} from './groups.mjs';
import { ACCEPT_HINT, classify, extractFile, fileToText } from './extract/index.mjs';
import {
  runFullAnalysis,
  rerunStage,
  askQuestion,
  dockAsk,
  gradeAnswer,
  checkLab,
  explainQuestion,
  answerKeyExcerpt,
  alignTranscript,
  translateSegments,
  fillMissingScripts,
} from './ai/pipeline.mjs';
import { extractAudio, ffmpegState } from './media-tools.mjs';
import { sttProvider, sttState, transcribe } from './stt.mjs';
import { rendererState } from './config.mjs';
import { complete, MAX_IMAGES_PER_REQUEST } from './ai/client.mjs';
import { toMarkdown } from './export.mjs';
import { buildPreviewPdf, canRender, mediaName } from './render.mjs';
import { classifyRole, isDocKind, isValidRole, matchSolution, ROLE_CATALOG, roleLabel } from './roles.mjs';

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use(express.json({ limit: '2mb' }));

// 基础安全响应头
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// 匿名会话（数据隔离的基石）
app.use(sessionMiddleware);

/* ------------------------------- 上传配置 ------------------------------- */

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(fixName(file.originalname)).slice(0, 12);
    cb(null, `${newId('f')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 120 * 1024 * 1024, files: 30 },
  fileFilter: (_req, file, cb) => {
    const kind = classify(fixName(file.originalname));
    if (kind === 'unknown') {
      const ext = path.extname(fixName(file.originalname)) || '(无扩展名)';
      cb(new Error(`不支持的文件类型 ${ext}。${ACCEPT_HINT}`));
      return;
    }
    cb(null, true);
  },
});

/** 浏览器上传的中文文件名常被当作 latin1 处理，这里还原成 UTF-8 */
function fixName(name = '') {
  if (!name) return name;
  if (/[^\u0000-\u00ff]/.test(name)) return name; // 已经是正确解码的
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? name : utf8;
}

/* --------------------------------- 工具 --------------------------------- */

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* 忽略 */
    }
  }, 15000);
  return {
    send(obj) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    close() {
      clearInterval(ping);
      res.end();
    },
  };
}

/** 只读项目（自己的 + 共享演示） */
function readableProjectOr404(req, res) {
  const project = getProject(req.params.id);
  if (!project || !canAccess(project, req.sid)) {
    res.status(404).json({ error: '项目不存在或已被删除' });
    return null;
  }
  return project;
}

/** 可写项目（仅自己的；共享演示对他人只读） */
function editableProjectOr404(req, res) {
  const project = getProject(req.params.id);
  if (!project || !canAccess(project, req.sid)) {
    res.status(404).json({ error: '项目不存在或已被删除' });
    return null;
  }
  if (!project.shared && project.owner && project.owner !== req.sid) {
    res.status(404).json({ error: '项目不存在或已被删除' });
    return null;
  }
  if (project.shared && project.owner !== req.sid) {
    res.status(403).json({ error: '这是公开的演示项目，只能查看不能修改。请点左侧「＋ 新建」建立自己的项目。' });
    return null;
  }
  return project;
}

const slim = (req, project) => slimProject(project, req.sid);

/** 需要 API Key 时统一返回 401，让前端弹出填写引导 */
function respondNeedKey(res, err) {
  res.status(401).json({ error: err.message, needsKey: true });
}

/** 解析本次请求的 AI 配置，失败时已经写过响应，返回 null */
function aiConfigOr401(req, res) {
  try {
    return resolveRequestConfig(req);
  } catch (err) {
    if (err instanceof NeedKeyError || err.code === 'NEED_KEY') {
      respondNeedKey(res, err);
      return null;
    }
    throw err;
  }
}

/** 限流，超了写 429 并返回 false */
function rateLimitOr429(req, res, action) {
  const r = checkRate(req.sid, action);
  if (r.ok) return true;
  res.status(429).json({
    error: `操作太频繁了，请等 ${Math.ceil(r.retryAfterSec / 60)} 分钟后再试。`,
    retryAfterSec: r.retryAfterSec,
  });
  return false;
}

/* -------------------------------- 配置 API ------------------------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true, service: '课件讲解平台', publicMode: isPublicMode() }));

app.get('/api/config', (req, res) => {
  const hasDemo = listProjects(req.sid).some((p) => p.shared);
  res.json({
    ...publicConfig(),
    hasDemo,
    // 类别清单由服务端下发，前端「改类别」面板和静态版共用同一份定义
    roles: ROLE_CATALOG,
    stt: sttState(),
    ffmpeg: ffmpegState(),
    renderer: rendererState(),
  });
});

/** 本机模式下允许在页面里保存 Key；公开模式禁止（避免把部署者的 Key 写进去） */
app.post('/api/config', (req, res) => {
  if (isPublicMode() && req.body?.apiKey) {
    res.status(403).json({ error: '本站为公开部署，请使用你自己的 API Key（只需填在浏览器里，不会上传服务器）。' });
    return;
  }
  saveConfig({ apiKey: req.body?.apiKey, model: req.body?.model, baseUrl: req.body?.baseUrl });
  res.json(publicConfig());
});

/**
 * 测试 API Key 是否可用。
 * 用访客自己带上来（或本机模式下服务端）的配置发一次极小的请求，只回成功/失败。
 */
app.post('/api/verify-key', async (req, res) => {
  const cfg = aiConfigOr401(req, res);
  if (!cfg) return;
  if (!rateLimitOr429(req, res, 'grade')) return;
  const started = Date.now();
  try {
    const { content } = await complete(cfg, {
      user: '请只回复两个字：可用',
      maxTokens: 24,
      temperature: 0,
    });
    res.json({ ok: true, model: cfg.model, ms: Date.now() - started, sample: String(content || '').trim().slice(0, 24) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* -------------------------------- 项目 API ------------------------------- */

app.get('/api/projects', (req, res) => res.json({ projects: listProjects(req.sid) }));

app.post('/api/projects', (req, res) => {
  if (countOwnedProjects(req.sid) >= QUOTAS.maxProjects) {
    res.status(429).json({ error: `最多只能建 ${QUOTAS.maxProjects} 个项目，请先删掉一些。` });
    return;
  }
  const groupId = String(req.body?.groupId || '');
  if (!groupExists(groupId, req.sid)) {
    res.status(404).json({ error: '这个项目组不存在' });
    return;
  }
  const project = createProject((req.body?.name || '未命名课件').slice(0, 120), req.sid, { groupId });
  res.json(slim(req, project));
});

/* ------------------------------ 项目组 ------------------------------ */

/** 一次拿全：所有组 + 所有项目（带 groupId），侧边栏一次渲染完 */
app.get('/api/groups', (req, res) => {
  res.json({ groups: listGroups(req.sid), projects: listProjects(req.sid) });
});

app.post('/api/groups', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: '请填写项目组名称，例如 EIE3333' });
    return;
  }
  res.json({ group: createGroup(name, req.sid) });
});

app.patch('/api/groups/:id', (req, res) => {
  const g = getGroup(req.params.id);
  if (!g || !canEditGroup(g, req.sid)) {
    res.status(404).json({ error: '项目组不存在' });
    return;
  }
  res.json({ group: renameGroup(req.params.id, req.body?.name, req.sid) });
});

/** 删组不删项目：组里的项目退回「未分组」，分析结果都还在 */
app.delete('/api/groups/:id', async (req, res) => {
  const g = getGroup(req.params.id);
  if (!g || !canEditGroup(g, req.sid)) {
    res.status(404).json({ error: '项目组不存在' });
    return;
  }
  deleteGroup(req.params.id, req.sid);
  // 组里的项目退回「未分组」；分析结果一个都不动
  const { forEachProject } = await import('./store.mjs');
  forEachProject((p) => {
    if ((p.owner || '') === (req.sid || '') && p.groupId === req.params.id) {
      p.groupId = '';
      persist(p);
    }
  });
  res.json({ ok: true, groups: listGroups(req.sid), projects: listProjects(req.sid) });
});

app.get('/api/projects/:id', (req, res) => {
  const project = readableProjectOr404(req, res);
  if (!project) return;
  res.json(slim(req, project));
});

/**
 * 「这份材料有多少页、自动模式大概会读几页」。
 *
 * 生成弹窗里给用户做选择用：页数多的时候要让人知道三种读法差多少钱。
 * 只算统计不渲染，算过的结果会缓存在页面缓存目录里，第二次就是读文件。
 */
app.get('/api/projects/:id/page-stats', async (req, res) => {
  const project = readableProjectOr404(req, res);
  if (!project) return;
  if (!chromeState().available) {
    res.json({ ok: true, available: false, total: 0, auto: 0, all: 0, files: [], note: '没找到 Chrome，无法分析页面' });
    return;
  }
  const docs = (project.files || []).filter((f) => f.previewPdf && f.role !== 'video');
  let total = 0;
  let auto = 0;
  const files = [];
  // 扫描件（没有文字层）会先被批量识别成文字，这一步只做一次并缓存 ——
  // 弹窗里要如实告诉用户，别让他以为只是「读几页图」
  const scanned = (project.files || [])
    .filter((f) => isScannedDoc(f))
    .map((f) => ({
      id: f.id,
      name: f.originalName,
      pages: Number(f.meta?.pages) || 0,
      ocrDone: Number(f.meta?.ocrPages) > 0,
    }));
  for (const f of docs) {
    const disk = path.join(MEDIA_DIR, project.id, path.basename(f.previewPdf));
    if (!fs.existsSync(disk)) continue;
    try {
      const stats = await pageStats({ pdfPath: disk, cacheKey: f.storedName || f.id });
      const n = stats.length;
      const a = selectPages(stats, 'auto').length;
      total += n;
      auto += a;
      files.push({ file: f.originalName, name: f.originalName, pages: n, auto: a });
    } catch {
      /* 单份文件分析失败不影响其他文件 */
    }
  }
  res.json({
    ok: true,
    available: true,
    total,
    auto,
    all: total,
    maxImages: MAX_IMAGES_PER_REQUEST,
    scanned,
    files,
  });
});

/** 改项目名 / 把项目移到另一个组（groupId 传空字符串 = 移出分组） */
app.patch('/api/projects/:id', (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    project.name = req.body.name.trim().slice(0, 120);
  }
  if (typeof req.body?.groupId === 'string') {
    if (!groupExists(req.body.groupId, req.sid)) {
      res.status(404).json({ error: '这个项目组不存在' });
      return;
    }
    project.groupId = req.body.groupId;
  }
  persist(project);
  res.json(slim(req, project));
});

app.delete('/api/projects/:id', (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  deleteProject(req.params.id);
  res.json({ ok: true });
});

/* -------------------------------- 上传 -------------------------------- */

app.post('/api/projects/:id/upload', (req, res, next) => {
  upload.array('files', 30)(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err.message || '上传失败' });
      return;
    }
    next();
  });
}, async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  if (!rateLimitOr429(req, res, 'uploads')) return;

  const incoming = req.files || [];
  if (!incoming.length) {
    res.status(400).json({ error: '没有收到文件' });
    return;
  }
  if (overStorage(req.sid)) {
    res.status(413).json({ error: `本会话上传总量已超过 ${QUOTAS.maxStorageMb}MB，请删掉一些文件再传。` });
    return;
  }

  const added = [];
  const failed = [];
  let bytes = 0;

  for (const f of incoming) {
    const originalName = fixName(f.originalname);
    const fileId = newId('file');
    try {
      const buffer = await fs.promises.readFile(f.path);
      const mediaBase = `/media/${project.id}`;
      const result = await extractFile({ buffer, originalName, storedPath: f.path, mediaBase });
      const ext = (originalName.split('.').pop() || '').toLowerCase();
      const role = classifyRole(originalName, result.kind);

      const dir = path.join(MEDIA_DIR, project.id);
      await fs.promises.mkdir(dir, { recursive: true });

      // 1) PPTX 里抽出来的图片落盘
      const media = [];
      if (result.media?.length) {
        for (const m of result.media) {
          const target = path.join(dir, path.basename(m.fileName));
          await fs.promises.writeFile(target, m.buffer);
          media.push({ url: m.url, fileName: m.fileName, mime: m.mime });
        }
      }

      // 2) 生成预览 PDF —— 「课件原文」区域要放的是原文件的截图，靠这个 PDF 在浏览器里逐页画出来
      let previewPdf = '';
      let previewNote = '';
      if (isDocKind(result.kind)) {
        if (canRender(ext)) {
          const pdfName = `${fileId}.pdf`;
          const r = await buildPreviewPdf({ srcPath: f.path, ext, outPath: path.join(dir, pdfName) });
          if (r.ok) previewPdf = `${mediaBase}/${pdfName}`;
          else previewNote = r.reason || '生成截图失败';
        } else {
          previewNote = `.${ext} 暂不支持生成截图，本页只能显示提取出的文字`;
        }
      }

      // 3) 音视频：复制到媒体目录，页面上可以直接播放
      let mediaUrl = '';
      if (role === 'video') {
        const vName = mediaName('av', ext || 'bin');
        await fs.promises.copyFile(f.path, path.join(dir, vName));
        mediaUrl = `${mediaBase}/${vName}`;
      }

      const text = fileToText(result);
      const record = {
        id: fileId,
        originalName,
        storedName: path.basename(f.path),
        kind: result.kind,
        role,
        roleLabel: roleLabel(role),
        // auto = 由文件名自动判断；manual = 用户自己点选过，启动时不许覆盖
        roleSource: 'auto',
        size: f.size,
        chars: text.length,
        meta: result.meta || {},
        blocks: result.blocks || [],
        media,
        previewPdf,
        previewNote,
        mediaUrl,
        text,
        preview: text.slice(0, 600),
        addedAt: new Date().toISOString(),
      };
      project.files.push(record);
      bytes += Number(f.size) || 0;
      added.push({
        id: record.id,
        originalName,
        kind: record.kind,
        role: record.role,
        roleLabel: record.roleLabel,
        chars: record.chars,
        hasPreview: Boolean(record.previewPdf),
        previewNote: record.previewNote,
        meta: record.meta,
      });
    } catch (err) {
      failed.push({ originalName, error: err.message });
      await fs.promises.unlink(f.path).catch(() => {});
    }
  }

  addBytes(req.sid, bytes);
  // 新文件加入后，旧的分析结果不再对应当前内容
  if (added.length && project.analysis) project.analysisStale = true;
  persist(project);
  res.json({ added, failed, project: slim(req, project) });
});

app.delete('/api/projects/:id/files/:fileId', async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  const idx = project.files.findIndex((f) => f.id === req.params.fileId);
  if (idx < 0) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  const [removed] = project.files.splice(idx, 1);
  await fs.promises.unlink(path.join(UPLOAD_DIR, removed.storedName)).catch(() => {});
  project.analysisStale = true;
  persist(project);
  res.json({ ok: true, project: slim(req, project) });
});

/** 查看某个文件抽取到的文字（透明化，便于老师核对） */
/**
 * 改一份材料的类别（课件 / 实验指导 / 习题 / 标准答案 / 上课录像 / 其他）。
 *
 * role 传 'auto' 表示「改回按文件名自动识别」。
 * 改完把整个项目返回，前端直接拿新的 shape 重画 —— 模式排列会跟着变。
 */
app.patch('/api/projects/:id/files/:fileId', (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  const file = (project.files || []).find((f) => f.id === req.params.fileId);
  if (!file) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  const want = String(req.body?.role || '').trim();
  if (!isValidRole(want)) {
    res.status(400).json({ error: `不认识的类别：${want}` });
    return;
  }
  if (want === 'auto') {
    file.role = classifyRole(file.originalName, file.kind);
    file.roleSource = 'auto';
  } else {
    file.role = want;
    file.roleSource = 'manual';
  }
  file.roleLabel = roleLabel(file.role);
  // 类别变了，之前的分析结果就不再对应，提示前端可以重跑
  if (project.analysis) project.analysisStale = true;
  persist(project);
  res.json({ ok: true, project: slim(req, project) });
});

app.get('/api/projects/:id/files/:fileId/text', (req, res) => {
  const project = readableProjectOr404(req, res);
  if (!project) return;
  const file = project.files.find((f) => f.id === req.params.fileId);
  if (!file) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  res.json({ originalName: file.originalName, kind: file.kind, meta: file.meta, blocks: file.blocks });
});

/* -------------------------------- 分析 -------------------------------- */

/** 取这个项目的页面截图；渲染失败就返回空数组（退回纯文字，不阻断功能） */
const pageCachePerRequest = new Map();
async function pagesForProject(project, mode = 'auto') {
  // 不同模式挑出来的页不一样，缓存要按模式分开存
  const key = `${project.id}#${mode}`;
  if (pageCachePerRequest.has(key)) return pageCachePerRequest.get(key);
  let out = [];
  try {
    if (chromeState().available) out = (await collectPageImages({ project, mode })).images;
  } catch {
    /* 忽略，退回纯文字 */
  }
  pageCachePerRequest.set(key, out);
  // 只在这个请求内复用，避免项目更新后拿到旧图
  setTimeout(() => pageCachePerRequest.delete(key), 60000).unref?.();
  return out;
}

/** 读图模式（readModeOf / READ_MODE_LABEL）和前端、静态版共用 page-select.mjs */

/**
 * 把项目里的文档类文件渲染成截图。
 * PDF 用文件本身；PPTX / DOCX 等用上传时生成好的预览 PDF（LibreOffice 转过的那份）。
 *
 * mode = auto 时只渲染「位图覆盖面积大」或「矢量线段多」的页面 ——
 * 纯文字页不渲染，也就不会把图片 token 花在它们身上。
 *
 * @returns {Promise<{images:Array<{label:string,page:number,dataUrl:string,file:string}>,
 *                    total:number, selected:number, mode:string}>}
 */
async function collectPageImages({ project, emit = () => {}, mode = 'auto' }) {
  const images = [];
  let total = 0;
  let selected = 0;
  const docs = (project.files || []).filter((f) => f.previewPdf && f.role !== 'video');
  const multi = docs.length > 1;

  for (const f of docs) {
    // previewPdf 是 URL（/media/<pid>/<id>.pdf），要还原成磁盘路径
    const disk = path.join(MEDIA_DIR, project.id, path.basename(f.previewPdf));
    if (!fs.existsSync(disk)) continue;
    try {
      const r = await rasterizePdf({
        pdfPath: disk,
        cacheKey: f.storedName || f.id,
        onProgress: emit,
        mode,
      });
      total += r.total;
      selected += r.selected;
      for (const p of r.pages) {
        images.push({
          fileId: f.id,
          file: f.originalName,
          page: p.page,
          // 位置标记要和 pageListFor 生成的标签一致，narration 才能按页对上
          label: multi ? `第 ${p.page} 页｜${f.originalName}` : `第 ${p.page} 页`,
          dataUrl: p.dataUrl,
        });
      }
    } catch (err) {
      emit(`「${f.originalName}」转图片失败，跳过：${err.message}`);
    }
  }
  return { images, total, selected, mode };
}

/**
 * 扫描件的识字结果落盘缓存。纯逻辑在 ocr.mjs（服务端和静态版共用），
 * 这里只提供「往哪写」—— 静态版对应的是 localStorage。
 */
const OCR_CACHE_DIR = path.join(CACHE_DIR, 'ocr');
fs.mkdirSync(OCR_CACHE_DIR, { recursive: true });
function ocrCacheFor(key) {
  const file = path.join(OCR_CACHE_DIR, `${String(key || '').replace(/[^\w.-]/g, '_')}.json`);
  return {
    async read() {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        return d && typeof d.pages === 'object' ? d.pages : null;
      } catch {
        return null;
      }
    },
    async write(pages) {
      try {
        fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), pages }));
      } catch {
        /* 缓存写失败不影响这次使用 */
      }
    },
  };
}

/**
 * 扫描版 PDF：生成之前先把整份认成文字。
 *
 * 文字型 PDF 不走这里 —— 它们本来就有文字层，pdfjs 直接读，95 页实测 0.08 秒。
 * 只有抽不出文字的扫描件/拍照件才需要，而且**只做一次**、结果落盘缓存，
 * 之后所有阶段（分析/事例/规划/总结/题/Lab）都读文字，不再反复发同一批图片。
 *
 * @returns {Promise<Array<{id:string, name:string, pages:number}>>} 这次真正识别过的文件
 */
async function ocrScannedFiles({ project, cfg, stream, signal }) {
  const done = [];
  for (const f of project.files || []) {
    if (f.kind !== 'pdf' || !f.previewPdf || !isScannedDoc(f)) continue;
    // 已经是文字了（识别过、或本来部分页有文字层）就不重复做
    const blank = (f.blocks || []).filter((b) => isBlankPageText(b.text));
    if (!blank.length) continue;

    const disk = path.join(MEDIA_DIR, project.id, path.basename(f.previewPdf));
    if (!fs.existsSync(disk)) continue;
    const say = (message) => stream.send({ type: 'stage-detail', stage: 'analysis', message });

    try {
      // 要认整份，所以这里是 all 而不是 auto —— auto 会按「图片多不多」挑页，
      // 而扫描件每页都是图，挑出来也是全部
      const r = await rasterizePdf({
        pdfPath: disk,
        cacheKey: f.storedName || f.id,
        mode: 'all',
        onProgress: say,
        signal,
      });
      const ocr = await ocrPages({
        pages: r.pages.map((p) => ({ page: p.page, dataUrl: p.dataUrl })),
        cfg,
        emit: say,
        signal,
        cache: ocrCacheFor(f.storedName || f.id),
      });
      const { blocks, hit } = applyOcrToBlocks(f.blocks, ocr.pages);
      f.blocks = blocks;
      // 关键：contextFor / buildContext 读的是存在文件上的 text，
      // 只改 blocks 的话识别结果永远送不到模型那儿
      f.text = fileToText({ ...f, blocks });
      f.chars = f.text.length;
      f.meta = {
        ...(f.meta || {}),
        scanned: true,
        ocrPages: hit,
        ocrAt: new Date().toISOString(),
      };
      if (hit) {
        say(`「${f.originalName}」识别完成：${hit} 页文字已并入原文，之后各模式都读文字即可`);
        done.push({ id: f.id, name: f.originalName, pages: hit });
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      say(`「${f.originalName}」文字识别失败，这份仍按图片读：${err.message}`);
    }
  }
  return done;
}

app.post('/api/projects/:id/analyze', async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  if (!project.files.length) {
    res.status(400).json({ error: '请先上传至少一个课件文件' });
    return;
  }
  if (!rateLimitOr429(req, res, 'analyze')) return;
  // 先把 Key 解析掉，失败就直接 401（此时还没开 SSE，前端能正常读到 JSON 错误）
  const cfg = aiConfigOr401(req, res);
  if (!cfg) return;

  if (req.body?.name) project.name = String(req.body.name).slice(0, 120);

  const stream = sse(res);
  // 注意：不能用 req 的 close（Node 在请求体读完时就会触发），要用 res 的 close
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    // 扫描件先认字（只做一次，缓存）—— 必须在 contextFor 之前，
    // 否则这次生成拿到的还是空文字
    const ocrDone = req.body?.ocrScanned === false
      ? []
      : await ocrScannedFiles({ project, cfg, stream, signal: controller.signal });
    if (ocrDone.length) persist(project);
    // 注意要按「这份文件已经有识别出来的文字」来判断，不能只看这次有没有跑 OCR ——
    // 第二次生成时 OCR 命中的是缓存，ocrDone 是空的，但图同样不该再发一遍。
    const ocrIds = new Set(
      (project.files || []).filter((f) => Number(f.meta?.ocrPages) > 0).map((f) => f.id),
    );

    const files = contextFor(project, cfg.maxInputChars);
    const hasVideo = project.files.some((f) => f.role === 'video');
    const hasText = project.files.some((f) => classify(f.originalName) === 'document' && f.chars > 0);
    stream.send({
      type: 'start',
      files: project.files.length,
      contextChars: files.context.length,
      hasText,
      model: cfg.model,
      keySource: cfg.keySource,
    });

    // 前端弹窗里勾了哪些模式就只跑哪些；没传（老客户端）= 全跑
    const only = normalizeStages(req.body?.stages);

    /**
     * 把课件页面渲染成截图，一起发给模型。
     *
     * 文字层读不出来的东西 —— 电路图、框图、照片，以及被挤成一坨的表格 ——
     * 只能靠截图。渲染失败不影响流程，退化成原来的纯文本模式。
     *
     * 默认 auto：先看每页的位图覆盖面积和矢量绘制量，只把「图表页」发给视觉模型。
     * 纯文字页只送文字，省掉那部分图片 token。
     */
    let pageImages = [];
    const readMode = readModeOf(req.body);
    if (readMode !== 'text' && chromeState().available) {
      try {
        const r = await collectPageImages({
          project,
          mode: readMode,
          emit: (message) => stream.send({ type: 'stage-detail', stage: 'analysis', message }),
        });
        // 刚识别过文字的扫描件不再发图 —— 内容已经在文字里了。
        // 这正是「批量 OCR 而不是逐页截图」省下来的大头：原来 6 个阶段各发一遍图片。
        pageImages = ocrIds.size ? r.images.filter((p) => !ocrIds.has(p.fileId)) : r.images;
        if (r.total) {
          const skipped = r.images.length - pageImages.length;
          stream.send({
            type: 'stage-detail',
            stage: 'analysis',
            message:
              `共 ${r.total} 页，按「${READ_MODE_LABEL[readMode]}」挑了 ${r.selected} 页读图` +
              (skipped ? `，其中 ${skipped} 页已识别成文字、不再重复发图` : '') +
              '，其余按文字读',
          });
        }
      } catch (err) {
        stream.send({
          type: 'stage-detail',
          stage: 'analysis',
          level: 'warn',
          message: `页面截图没生成出来，这次按纯文字读：${err.message}`,
        });
      }
    } else if (readMode === 'text') {
      stream.send({ type: 'stage-detail', stage: 'analysis', message: '按你的选择：这次只用文字，不读页面截图' });
    }

    // 生成语言：zh / en / bilingual（中英对照）
    // 对照模式要跑两遍 —— 一遍中文一遍英文，分别存下来，前端上下叠着显示。
    // 之所以跑两遍而不是让模型一次输出两种语言：所有阶段的 JSON 体积都会翻倍，
    // 8000 token 的输出上限撑不住，尤其是逐页讲解稿这种本来就长的。
    const langMode = ['zh', 'en', 'bilingual'].includes(req.body?.langMode) ? req.body.langMode : 'zh';
    const passes = langMode === 'bilingual' ? ['zh', 'en'] : [langMode === 'en' ? 'en' : 'zh'];

    const runPass = (lang, passLabel) =>
      runFullAnalysis({
        files,
        cfg: { ...cfg, lang },
        signal: controller.signal,
        // 上传了上课录像 → 讲解稿以录像为准，这一轮不生成 narration
        skipNarration: hasVideo,
        only,
        pageImages,
        emit: (evt) => stream.send({ ...evt, lang, passLabel }),
      });

    let result = null;
    let altEn = null;
    for (let i = 0; i < passes.length; i++) {
      const lang = passes[i];
      if (passes.length > 1) {
        stream.send({
          type: 'pass',
          lang,
          index: i + 1,
          total: passes.length,
          passLabel: lang === 'zh' ? '中文' : 'English',
        });
      }
      const out = await runPass(lang, lang === 'zh' ? '中文' : 'English');
      if (i === 0) result = out;
      else altEn = out;
    }

    project.analysis = result;
    project.analysisStale = false;
    // 对照模式：把英文那一遍的结果按阶段存起来，前端直接叠在中文下面
    if (altEn) {
      project.analysis.analysisEn = {
        analysis: altEn.analysis,
        examples: altEn.examples,
        guide: altEn.guide,
        narration: altEn.narration,
        summary: altEn.summary,
        quiz: altEn.quiz,
        lab: altEn.lab,
        generatedAt: altEn.generatedAt,
      };
    } else {
      delete project.analysis.analysisEn;
    }
    persist(project);
    stream.send({ type: 'saved', project: slim(req, project) });
  } catch (err) {
    if (err.name === 'AbortError') stream.send({ type: 'aborted' });
    else stream.send({ type: 'fatal', message: err.message, needsKey: err.code === 'NEED_KEY' });
  } finally {
    stream.close();
  }
});

/** 只重跑某一个阶段 */
app.post('/api/projects/:id/rerun', async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  if (!rateLimitOr429(req, res, 'analyze')) return;
  const cfg = aiConfigOr401(req, res);
  if (!cfg) return;
  const stage = String(req.body?.stage || '');
  try {
    const files = contextFor(project, cfg.maxInputChars);
    project.analysis = project.analysis || {};
    // 单节重跑也要带页面截图 —— 用户点「重新生成本节」时最期待的就是图表能被读到
    // 读图模式沿用这次请求的选择，默认还是 auto（只读图表页）
    let pageImages = [];
    const rerunReadMode = readModeOf(req.body);
    if (rerunReadMode !== 'text' && chromeState().available) {
      try {
        pageImages = (await collectPageImages({ project, mode: rerunReadMode })).images;
      } catch {
        /* 渲染失败就退回纯文字，不阻断重跑 */
      }
    }
    // 这个项目是「中英对照」生成的 → 重跑一节也要两种语言都补上，
    // 否则重新生成的那一节会突然只剩中文，对照就断了
    const bilingual = Boolean(project.analysis.analysisEn);
    const data = await rerunStage({ stage, files, cfg: { ...cfg, lang: 'zh' }, pageImages });
    project.analysis[stage] = data;
    // 记下这一节是不是用读图生成的，否则页面上的标记会一直停留在旧状态
    if (pageImages.length) {
      project.analysis.pagesRead = pageImages.length;
      project.analysis.visionModel = cfg.visionModel || 'deepseek-flash';
    }
    if (bilingual) {
      const en = await rerunStage({ stage, files, cfg: { ...cfg, lang: 'en' }, pageImages });
      project.analysis.analysisEn = project.analysis.analysisEn || {};
      project.analysis.analysisEn[stage] = en;
    }
    persist(project);
    res.json({ ok: true, stage, data, project: slim(req, project) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------ 做题：批改 ------------------------------ */

/** 找到题目对象 */
function findQuestion(project, questionId) {
  const questions = project.analysis?.quiz?.questions;
  if (!Array.isArray(questions)) return null;
  return questions.find((q) => String(q.id) === String(questionId)) || null;
}

app.post('/api/projects/:id/grade', async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  const question = findQuestion(project, req.body?.questionId);
  if (!question) {
    res.status(404).json({ error: '找不到这道题，请先生成练习题' });
    return;
  }
  const answer = String(req.body?.answer ?? '').trim();
  if (!answer) {
    res.status(400).json({ error: '请先写下你的答案' });
    return;
  }
  if (!rateLimitOr429(req, res, 'grade')) return;
  const cfg = aiConfigOr401(req, res);
  if (!cfg) return;

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const { result } = await gradeAnswer({
      cfg,
      question,
      studentAnswer: answer,
      signal: controller.signal,
      pageImages: await pagesForProject(project),
    });
    project.attempts = project.attempts || {};
    project.attempts[question.id] = { answer, result, at: new Date().toISOString() };
    persist(project);
    res.json({ ok: true, questionId: question.id, result, project: slim(req, project) });
  } catch (err) {
    if (err.name === 'AbortError') return;
    res.status(500).json({ error: err.message });
  }
});

/**
 * 找出「这道题属于哪份作业/实验，它对应的标准答案是哪一份」。
 *
 * 题干里的 location 通常形如「第 3 页｜EIE3311 Tut 01.pdf」，
 * 把文件名抠出来就能和答案册按文件名配对；抠不出来就退化成只有一份答案时直接用。
 */
function solutionForQuestion(project, question) {
  const all = project.files || [];
  const roleOf = (f) => f.role || classifyRole(f.originalName, f.kind);
  const solutions = all.filter((f) => roleOf(f) === 'solution');
  if (!solutions.length) return null;

  const loc = String(question?.location || '');
  const bar = loc.indexOf('｜');
  const docName = bar >= 0 ? loc.slice(bar + 1).trim() : '';
  const owner = docName ? all.find((f) => f.originalName === docName) : null;
  // 找不到出题的那份文件时，看项目里唯一的那份习题/实验
  const fallback =
    all.filter((f) => ['exercise', 'lab'].includes(roleOf(f))).length === 1
      ? all.find((f) => ['exercise', 'lab'].includes(roleOf(f)))
      : null;

  return matchSolution(owner || fallback, solutions);
}

/**
 * 结合课件讲解题目：产出「知识点 → 课件原文 → 怎么用到本题 → 分步讲解 → 易错点 → 变式题」。
 * 同时把用到的课件原文一起返回，前端可以左右对照。
 */
app.post('/api/projects/:id/explain', async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  const question = findQuestion(project, req.body?.questionId);
  if (!question) {
    res.status(404).json({ error: '找不到这道题，请先生成练习题' });
    return;
  }
  // 已经讲过的直接返回，避免重复花钱
  if (req.body?.cached !== false && project.explain?.[question.id]?.result) {
    res.json({ ok: true, questionId: question.id, cached: true, ...project.explain[question.id] });
    return;
  }
  if (!rateLimitOr429(req, res, 'grade')) return;
  const cfg = aiConfigOr401(req, res);
  if (!cfg) return;

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const files = contextFor(project, cfg.maxInputChars);
    // 有答案册的话，先按文件名把这道题所属的那份作业/实验和答案配对，
    // 命中后只喂那一份答案，避免多个 Tut 的答案互相串。
    const solution = solutionForQuestion(project, question);
    const key = answerKeyExcerpt(files, {
      location: question.location,
      stem: question.stem,
      solutionName: solution?.originalName || '',
    });
    const { result, excerpt, answerKeyUsed } = await explainQuestion({
      cfg,
      question,
      files,
      pageImages: await pagesForProject(project),
      concepts: project.analysis?.analysis?.concepts || [],
      title: project.analysis?.analysis?.title || project.name,
      signal: controller.signal,
      answerKey: key.text,
      answerKeyFrom: key.from,
    });
    project.explain = project.explain || {};
    project.explain[question.id] = {
      result,
      excerpt,
      answerKeyUsed: answerKeyUsed || '',
      at: new Date().toISOString(),
    };
    persist(project);
    res.json({ ok: true, questionId: question.id, result, excerpt, answerKeyUsed: answerKeyUsed || '' });
  } catch (err) {
    if (err.name === 'AbortError') return;
    res.status(500).json({ error: err.message });
  }
});

/** 清除某题的课件精讲缓存 */
app.delete('/api/projects/:id/explain/:questionId', (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  if (project.explain) delete project.explain[req.params.questionId];
  persist(project);
  res.json({ ok: true, explain: project.explain || {} });
});

/**
 * 上课录像 → 逐页讲解稿
 * 提取音轨 → 语音转写 → 按课件页对齐 →（英文则翻中文）→ 补写录像没讲到的页
 */
app.post('/api/projects/:id/transcribe', async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;

  const files = project.files || [];
  const video = files.find((f) => f.id === req.body?.fileId) || files.find((f) => f.role === 'video');
  if (!video) {
    res.status(404).json({ error: '项目里没有上课录像' });
    return;
  }
  if (!video.mediaUrl) {
    res.status(400).json({ error: '这段录像没有可读取的媒体地址，请重新上传' });
    return;
  }
  if (!rateLimitOr429(req, res, 'analyze')) return;
  const cfg = aiConfigOr401(req, res);
  if (!cfg) return;
  if (sttProvider() === 'none') {
    res.status(400).json({ error: '没有配置语音转写服务。请配置讯飞凭据，或设置 OPENAI_API_KEY。' });
    return;
  }
  if (!ffmpegState().available) {
    res.status(400).json({ error: '未安装 ffmpeg，无法从录像里提取音频。请先 brew install ffmpeg。' });
    return;
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const stream = sse(res);
  try {
    const srcPath = path.join(UPLOAD_DIR, video.storedName);
    const workDir = path.join(MEDIA_DIR, project.id, 'av');
    await fs.promises.mkdir(workDir, { recursive: true });
    const audioPath = path.join(workDir, `${video.id}.wav`);

    stream.send({ type: 'stage-detail', stage: 'transcribe', message: '正在提取音轨…' });
    const audio = await extractAudio(srcPath, audioPath);
    if (!audio.ok) throw new Error(audio.reason);
    stream.send({
      type: 'stage-detail',
      stage: 'transcribe',
      message: `音轨已提取，时长约 ${Math.round(audio.duration / 60)} 分钟，开始转写…`,
    });

    const asr = await transcribe(audioPath, {
      durationMs: Math.round((audio.duration || 0) * 1000),
      onProgress: (m) => stream.send({ type: 'stage-detail', stage: 'transcribe', message: m }),
    });
    stream.send({
      type: 'stage-detail',
      stage: 'transcribe',
      message: `转写完成：${asr.segments.length} 句（${asr.provider}），正在按课件页对齐…`,
    });

    const fileSet = { list: files.map((x) => ({ ...x, text: x.text || '' })) };
    const { segments, lang } = await alignTranscript({
      cfg,
      files: fileSet,
      transcript: asr.segments,
      signal: controller.signal,
    });

    let out = segments;
    if (lang === 'en') {
      stream.send({ type: 'stage-detail', stage: 'transcribe', message: '检测到英文授课，正在翻译成中文…' });
      out = await translateSegments({ cfg, segments: out, signal: controller.signal });
    }
    stream.send({ type: 'stage-detail', stage: 'transcribe', message: '正在为录像没讲到的页面补写讲解稿…' });
    out = await fillMissingScripts({
      cfg,
      files: fileSet,
      segments: out,
      signal: controller.signal,
      emit: (e) => stream.send(e),
    });

    const finalSegments = out.map((s) => {
      const fromVideo = Boolean(s.transcript);
      // 录像讲到这一页 → 用老师原话；英文课再附一份中文翻译（英文原文放 scriptEn）
      // 录像没讲到 → 用 AI 补写的稿子（在 s.script 里），不能丢
      const script = fromVideo ? (lang === 'en' ? s.zh || s.transcript : s.transcript) : s.script || '';
      return {
        location: s.location,
        title: s.title || '',
        script,
        scriptEn: fromVideo && lang === 'en' ? s.transcript : '',
        fromVideo,
        aiFilled: !fromVideo,
        start: s.start || 0,
        end: s.end || 0,
        keyPoints: s.keyPoints || [],
        askClass: s.askClass || '',
        board: '',
        transition: s.transition || '',
      };
    });

    project.analysis = project.analysis || {};
    project.analysis.narration = {
      ...(project.analysis.narration || {}),
      segments: finalSegments,
      source: 'video',
      lang,
      provider: asr.provider,
      generatedAt: new Date().toISOString(),
    };
    project.narrationFromVideo = true;
    persist(project);

    stream.send({
      type: 'done',
      segments: finalSegments.length,
      aligned: finalSegments.filter((s) => s.fromVideo).length,
      lang,
      provider: asr.provider,
      project: slim(req, project),
    });
  } catch (err) {
    if (err.name === 'AbortError') stream.send({ type: 'aborted' });
    else stream.send({ type: 'fatal', message: err.message });
  } finally {
    stream.close();
  }
});

/** 只保存作答、不批改（防止手滑丢答案；不调用模型，所以不需要 Key） */
app.post('/api/projects/:id/answer', (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  const question = findQuestion(project, req.body?.questionId);
  if (!question) {
    res.status(404).json({ error: '找不到这道题' });
    return;
  }
  project.attempts = project.attempts || {};
  const prev = project.attempts[question.id] || {};
  project.attempts[question.id] = { ...prev, answer: String(req.body?.answer ?? ''), savedAt: new Date().toISOString() };
  persist(project);
  res.json({ ok: true });
});

/** 清空做题记录（重做） */
app.delete('/api/projects/:id/attempts', (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  const only = req.query.questionId;
  if (only) delete (project.attempts || {})[String(only)];
  else project.attempts = {};
  persist(project);
  res.json({ ok: true, attempts: project.attempts || {} });
});

/* ------------------------------ 做 lab：检查 ------------------------------ */

function findLab(project, labId) {
  const labs = project.analysis?.lab?.labs;
  if (!Array.isArray(labs)) return null;
  return labs.find((l) => String(l.id) === String(labId)) || null;
}

/** 保存实验进度；check=true 时同时请模型检查 */
app.post('/api/projects/:id/lab', async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  const lab = findLab(project, req.body?.labId);
  if (!lab) {
    res.status(404).json({ error: '找不到这个实验，请先生成 Lab' });
    return;
  }
  const records = req.body?.records && typeof req.body.records === 'object' ? req.body.records : {};
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  project.labProgress = project.labProgress || {};
  const prev = project.labProgress[lab.id] || {};
  const entry = { ...prev, records, steps, at: new Date().toISOString() };

  if (!req.body?.check) {
    project.labProgress[lab.id] = entry;
    persist(project);
    res.json({ ok: true, saved: true });
    return;
  }

  const filled = Object.values(records).filter((v) => String(v || '').trim());
  if (!filled.length) {
    res.status(400).json({ error: '请至少填写一项实验记录再提交检查' });
    return;
  }
  if (!rateLimitOr429(req, res, 'grade')) return;
  const cfg = aiConfigOr401(req, res);
  if (!cfg) return;

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const { result } = await checkLab({ cfg, lab, records, signal: controller.signal , pageImages: await pagesForProject(project) });
    entry.result = result;
    project.labProgress[lab.id] = entry;
    persist(project);
    res.json({ ok: true, labId: lab.id, result, project: slim(req, project) });
  } catch (err) {
    if (err.name === 'AbortError') return;
    res.status(500).json({ error: err.message });
  }
});

/** 清空某个 lab 的记录 */
app.delete('/api/projects/:id/lab/:labId', (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  if (project.labProgress) delete project.labProgress[req.params.labId];
  persist(project);
  res.json({ ok: true, labProgress: project.labProgress || {} });
});

/* -------------------------------- 课件问答 ------------------------------- */

app.post('/api/projects/:id/chat', async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  const question = String(req.body?.question || '').trim();
  if (!question) {
    res.status(400).json({ error: '请输入问题' });
    return;
  }
  if (!rateLimitOr429(req, res, 'grade')) return;
  const cfg = aiConfigOr401(req, res);
  if (!cfg) return;

  const stream = sse(res);
  // 注意：不能用 req 的 close（Node 在请求体读完时就会触发），要用 res 的 close
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const history = project.chat.slice(-8);
  let answer = '';
  try {
    const text = await askQuestion({
      files: contextFor(project, cfg.maxInputChars),
      cfg,
      question,
      history,
      signal: controller.signal,
      onDelta: (d) => {
        answer += d;
        stream.send({ type: 'delta', text: d });
      },
    });
    // 以返回值兜底，避免回调漏接导致回答为空
    answer = text || answer;
    if (!answer) throw new Error('模型没有返回内容，请重试');
    project.chat.push({ role: 'user', content: question, at: new Date().toISOString() });
    project.chat.push({ role: 'assistant', content: answer, at: new Date().toISOString() });
    project.chat = project.chat.slice(-60);
    persist(project);
    stream.send({ type: 'done' });
  } catch (err) {
    if (err.name === 'AbortError') stream.send({ type: 'aborted' });
    else stream.send({ type: 'fatal', message: err.message, needsKey: err.code === 'NEED_KEY' });
  } finally {
    stream.close();
  }
});

app.delete('/api/projects/:id/chat', (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  project.chat = [];
  persist(project);
  res.json({ ok: true });
});

/* ---------------------- 右侧 AI 咨询（带拖入的上下文） ---------------------- */

/**
 * 和「课件问答」的区别：这里会把用户从界面上拖进来的内容块作为焦点，
 * 对话历史单独存在 project.dockChat，两边互不干扰。
 *
 * 拖进来的块可能很多很大（整页讲解稿），所以对文本做总量与单项双重截断。
 */
const DOCK_MAX_ITEMS = 12;
const DOCK_MAX_CHARS = 24000;

function normalizeAttachments(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, DOCK_MAX_ITEMS) : [];
  let budget = DOCK_MAX_CHARS;
  const out = [];
  for (const a of list) {
    if (!a) continue;
    const text = String(a.text || '').slice(0, 6000);
    if (budget <= 0) break;
    const clipped = text.slice(0, budget);
    budget -= clipped.length;
    out.push({
      title: String(a.title || '').slice(0, 160),
      source: String(a.source || '').slice(0, 160),
      text: clipped,
    });
  }
  return out;
}

app.post('/api/projects/:id/ask', async (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;

  const question = String(req.body?.question || '').trim().slice(0, 4000);
  const attachments = normalizeAttachments(req.body?.attachments);
  // 没内容也没问题就没得聊；只拖了内容不提问是允许的（AI 会主动讲解）
  if (!question && !attachments.length) {
    res.status(400).json({ error: '请先拖入要讨论的内容，或输入一个问题' });
    return;
  }
  if (!rateLimitOr429(req, res, 'grade')) return;
  const cfg = aiConfigOr401(req, res);
  if (!cfg) return;

  const stream = sse(res);
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  project.dockChat = project.dockChat || [];
  const history = project.dockChat.slice(-10);
  let answer = '';
  try {
    const text = await dockAsk({
      files: contextFor(project, cfg.maxInputChars),
      cfg,
      question,
      attachments,
      history,
      signal: controller.signal,
      onDelta: (d) => {
        answer += d;
        stream.send({ type: 'delta', text: d });
      },
    });
    // 以返回值兜底，避免回调漏接导致回答为空
    answer = text || answer;
    if (!answer) throw new Error('模型没有返回内容，请重试');

    project.dockChat.push({
      role: 'user',
      content: question,
      attachments,
      at: new Date().toISOString(),
    });
    project.dockChat.push({ role: 'assistant', content: answer, at: new Date().toISOString() });
    project.dockChat = project.dockChat.slice(-80);
    persist(project);
    stream.send({ type: 'done' });
  } catch (err) {
    if (err.name === 'AbortError') stream.send({ type: 'aborted' });
    else stream.send({ type: 'fatal', message: err.message, needsKey: err.code === 'NEED_KEY' });
  } finally {
    stream.close();
  }
});

app.delete('/api/projects/:id/ask', (req, res) => {
  const project = editableProjectOr404(req, res);
  if (!project) return;
  project.dockChat = [];
  persist(project);
  res.json({ ok: true, dockChat: [] });
});

/* -------------------------------- 导出 -------------------------------- */

app.get('/api/projects/:id/export.md', (req, res) => {
  const project = readableProjectOr404(req, res);
  if (!project) return;
  if (!project.analysis) {
    res.status(400).send('还没有生成分析结果');
    return;
  }
  const md = toMarkdown(project);
  const safeName = (project.analysis?.analysis?.title || project.name || '课件分析').replace(/[\\/:*?"<>|]/g, '_');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}-讲解方案.md`)}`);
  res.send(md);
});

app.get('/api/projects/:id/export.json', (req, res) => {
  const project = readableProjectOr404(req, res);
  if (!project) return;
  res.setHeader('Content-Disposition', `attachment; filename="analysis.json"`);
  res.json(project.analysis || {});
});

/* -------------------------------- 静态资源 ------------------------------- */

// 配图也按会话隔离，防止拿到别人的 projectId 就能看图
app.use(
  '/media',
  (req, res, next) => {
    const pid = req.path.split('/').filter(Boolean)[0] || '';
    const project = getProject(pid);
    if (!project || !canAccess(project, req.sid)) {
      res.status(403).end();
      return;
    }
    next();
  },
  express.static(MEDIA_DIR, { maxAge: '1h' }),
);

// 前端资源一律协商缓存：这个项目是边改边用的，强缓存会让「点更新」也拿不到新文件
const noStore = (res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
};
app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (/.(html|js|mjs|css|json)$/i.test(filePath)) noStore(res);
    },
  }),
);
app.get('/', (_req, res) => {
  noStore(res);
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* -------------------------------- 版本号 -------------------------------- */

/**
 * 前端靠这个判断「服务器上的代码是不是比我手上这页新」。
 * 必须每次读盘、且禁止缓存，否则改了版本号页面也发现不了。
 */
app.get('/api/version', async (_req, res) => {
  noStore(res);
  // 远端检查是「后台刷新 + 立刻返回旧值」，所以这里加上它也不会拖慢页面
  res.json({ ...readVersion(), remote: await remoteStatus() });
});

/** 强制检查一次远端（「检查更新」按钮用），这次会等网络 */
app.post('/api/version/check', async (req, res) => {
  noStore(res);
  if (isPublicMode() && !req.sid) {
    res.status(403).json({ error: '公开模式下不允许改服务器配置' });
    return;
  }
  try {
    res.json({ ...readVersion(), remote: await remoteStatus({ force: true }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 本机部署一键更新：下载并校验新包，随后由独立进程清理旧程序、安装并重启。 */
app.post('/api/version/update', async (_req, res) => {
  noStore(res);
  if (isPublicMode()) {
    res.status(403).json({ error: '公开服务不允许访客更新服务器程序' });
    return;
  }
  try {
    const update = await prepareUpdate();
    if (!update.updated) {
      res.json(update);
      return;
    }
    launchUpdateHelper(update.stageRoot, update.version);
    res.json({
      updated: true,
      repair: update.repair,
      from: update.from,
      version: update.version,
      buildId: update.buildId,
      restarting: true,
    });
    setTimeout(() => process.exit(0), 700).unref();
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/** 更新检查地址：只有本机模式能改（这是服务器级配置，不该由访客决定） */
app.get('/api/settings/update-check', (_req, res) => {
  noStore(res);
  res.json({ url: updateCheckUrl(), editable: !isPublicMode() });
});

app.patch('/api/settings/update-check', (req, res) => {
  noStore(res);
  if (isPublicMode()) {
    res.status(403).json({ error: '公开模式下不允许改服务器配置，请改服务器上的 .env 或 data/config.json' });
    return;
  }
  const url = String(req.body?.url || '').trim();
  if (url && !isSafeUrl(url)) {
    res.status(400).json({ error: '地址要以 http:// 或 https:// 开头' });
    return;
  }
  res.json({ ok: true, url: setUpdateCheckUrl(url) });
});

// 静态版和外部工具也能直接取到这份清单
app.get('/version.json', (_req, res) => {
  noStore(res);
  res.type('application/json').sendFile(VERSION_FILE);
});

/* -------------------------------- 错误处理 ------------------------------- */

app.use((err, _req, res, _next) => {
  if (err instanceof NeedKeyError || err.code === 'NEED_KEY') {
    respondNeedKey(res, err);
    return;
  }
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

/* -------------------------------- 启动 -------------------------------- */

const serverCfg = loadServerConfig();
const PORT = serverCfg.port;
const HOST = serverCfg.host;
const PUBLIC_MODE = isPublicMode();

// 定期清理：内存会话计数 + 过期项目磁盘数据
setInterval(() => sweepSessions(), 6 * 3600 * 1000).unref?.();

const ttlDays = process.env.AUTO_CLEANUP === '0' ? 0 : Number(process.env.CLEANUP_TTL_DAYS) || 14;

/**
 * 老项目是在「文件角色」和「页面截图」这两个功能之前建的，
 * 启动时补一次：识别角色 + 生成缺失的预览 PDF。不阻塞服务启动。
 */
async function backfillProjects() {
  let touched = 0;
  const { forEachProject } = await import('./store.mjs');
  const jobs = [];
  forEachProject((project) => jobs.push(project));
  for (const project of jobs) {
    let changed = false;
    for (const file of project.files || []) {
      // 没被用户手动改过的，每次启动按文件名重算一遍 ——
      // 这样新加的规则（比如「带 solution 字样 = 标准答案」）能作用到老项目上。
      // 用户点选过的（roleSource === 'manual'）绝对不覆盖。
      if (file.roleSource === 'manual') {
        if (!file.roleLabel) {
          file.roleLabel = roleLabel(file.role);
          changed = true;
        }
      } else {
        const role = classifyRole(file.originalName, file.kind);
        if (file.role !== role || file.roleSource !== 'auto') {
          file.role = role;
          file.roleLabel = roleLabel(role);
          file.roleSource = 'auto';
          changed = true;
        } else if (!file.roleLabel) {
          file.roleLabel = roleLabel(role);
          changed = true;
        }
      }
      const ext = (file.originalName.split('.').pop() || '').toLowerCase();
      if (isDocKind(file.kind) && !file.previewPdf && canRender(ext)) {
        try {
          const outPath = path.join(MEDIA_DIR, project.id, `${file.id}.pdf`);
          const r = await buildPreviewPdf({ srcPath: path.join(UPLOAD_DIR, file.storedName), ext, outPath });
          if (r.ok) {
            file.previewPdf = `/media/${project.id}/${file.id}.pdf`;
            file.previewNote = '';
            changed = true;
          } else {
            file.previewNote = r.reason || '生成截图失败';
            changed = true;
          }
        } catch {
          /* 单个文件失败不影响其他 */
        }
      }
    }
    if (changed) {
      persist(project);
      touched++;
    }
  }
  return touched;
}

app.listen(PORT, HOST, () => {
  const { apiKey, source } = serverKey();
  const lines = [
    '',
    '  ┌────────────────────────────────────────────────┐',
    `  │   课件讲解平台 已启动  ${PUBLIC_MODE ? '（公开模式）' : '（本机模式）'}`.padEnd(51) + '│',
    '  └────────────────────────────────────────────────┘',
    '',
    `  访问地址:   http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
    `  数据目录:   ${DATA_DIR}`,
    `  模型:       ${serverCfg.model}`,
  ];

  if (PUBLIC_MODE) {
    lines.push(
      '  API Key:    由每位访客自己填写（服务器不保存、不使用自己的 Key）',
      '',
      '  提示：已在公开模式下运行。访客需自备 API Key，数据按浏览器会话相互隔离。',
    );
  } else {
    lines.push(
      `  API Key:    ${apiKey ? `服务端已配置（来源：${source}），访客无需填写` : '未配置 —— 请在页面右上角「设置」中填写'}`,
      '',
      '  提示：想分享给别人用，请用  npm run start:public   启动（访客自带 Key）。',
    );
  }

  if (ttlDays > 0) lines.push(`  自动清理:   超过 ${ttlDays} 天未使用的项目会被删除（AUTO_CLEANUP=0 可关闭）`);
  lines.push('');
  console.log(lines.join('\n'));

  if (ttlDays > 0) {
    const removed = cleanupExpiredProjects(ttlDays);
    if (removed) console.log(`  已清理 ${removed} 个过期项目\n`);
  }

  // 后台补齐老项目（不阻塞启动）
  backfillProjects()
    .then((n) => {
      if (n) console.log(`  已为 ${n} 个老项目补齐文件角色与页面截图\n`);
    })
    .catch((err) => console.warn('  补齐老项目时出错：' + err.message));

  // 回收站里超过 30 天的条目清掉（删除项目是软删除，先放 data/trash/）
  import('./store.mjs')
    .then(({ sweepTrash }) => {
      const n = sweepTrash();
      if (n) console.log(`  回收站清理：删除 ${n} 个超过 30 天的旧条目\n`);
    })
    .catch((err) => console.warn('  回收站清理出错：' + err.message));
});

export { app, fixName };
