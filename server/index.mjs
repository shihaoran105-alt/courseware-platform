/** 课件讲解平台 — HTTP 服务 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';

import {
  DATA_DIR,
  NeedKeyError,
  PUBLIC_DIR,
  UPLOAD_DIR,
  isPublicMode,
  loadServerConfig,
  publicConfig,
  resolveRequestConfig,
  saveConfig,
  serverKey,
} from './config.mjs';
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
import { ACCEPT_HINT, classify, extractFile, fileToText } from './extract/index.mjs';
import { runFullAnalysis, rerunStage, askQuestion, gradeAnswer, checkLab, explainQuestion } from './ai/pipeline.mjs';
import { complete } from './ai/client.mjs';
import { toMarkdown } from './export.mjs';

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
  res.json({ ...publicConfig(), hasDemo });
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
  const project = createProject((req.body?.name || '未命名课件').slice(0, 120), req.sid);
  res.json(slim(req, project));
});

app.get('/api/projects/:id', (req, res) => {
  const project = readableProjectOr404(req, res);
  if (!project) return;
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
    try {
      const buffer = await fs.promises.readFile(f.path);
      const mediaBase = `/media/${project.id}`;
      const result = await extractFile({ buffer, originalName, storedPath: f.path, mediaBase });

      // PPTX 里抽出来的图片落盘
      const media = [];
      if (result.media?.length) {
        const dir = path.join(MEDIA_DIR, project.id);
        await fs.promises.mkdir(dir, { recursive: true });
        for (const m of result.media) {
          const target = path.join(dir, path.basename(m.fileName));
          await fs.promises.writeFile(target, m.buffer);
          media.push({ url: m.url, fileName: m.fileName, mime: m.mime });
        }
      }

      const text = fileToText(result);
      const record = {
        id: newId('file'),
        originalName,
        storedName: path.basename(f.path),
        kind: result.kind,
        size: f.size,
        chars: text.length,
        meta: result.meta || {},
        blocks: result.blocks || [],
        media,
        text,
        preview: text.slice(0, 600),
        addedAt: new Date().toISOString(),
      };
      project.files.push(record);
      bytes += Number(f.size) || 0;
      added.push({ id: record.id, originalName, kind: record.kind, chars: record.chars, meta: record.meta });
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
    const files = contextFor(project, cfg.maxInputChars);
    const hasText = project.files.some((f) => classify(f.originalName) === 'document' && f.chars > 0);
    stream.send({
      type: 'start',
      files: project.files.length,
      contextChars: files.context.length,
      hasText,
      model: cfg.model,
      keySource: cfg.keySource,
    });

    const result = await runFullAnalysis({
      files,
      cfg,
      signal: controller.signal,
      emit: (evt) => stream.send(evt),
    });

    project.analysis = result;
    project.analysisStale = false;
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
    const data = await rerunStage({ stage, files, cfg });
    project.analysis = project.analysis || {};
    project.analysis[stage] = data;
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
    const { result } = await gradeAnswer({ cfg, question, studentAnswer: answer, signal: controller.signal });
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
    const { result, excerpt } = await explainQuestion({
      cfg,
      question,
      files,
      concepts: project.analysis?.analysis?.concepts || [],
      title: project.analysis?.analysis?.title || project.name,
      signal: controller.signal,
    });
    project.explain = project.explain || {};
    project.explain[question.id] = { result, excerpt, at: new Date().toISOString() };
    persist(project);
    res.json({ ok: true, questionId: question.id, result, excerpt });
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
    const { result } = await checkLab({ cfg, lab, records, signal: controller.signal });
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

app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

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
});

export { app, fixName };
