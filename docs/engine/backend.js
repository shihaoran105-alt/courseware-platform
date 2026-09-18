/* ============================================================
   静态版的「后端」：完全跑在浏览器里
   - 文件解析：extract.js（pdf.js + JSZip）
   - 数据存储：IndexedDB（store.js）
   - 模型调用：ai.js / pipeline.js（与服务端版共用同一套提示词与流水线）
   - API Key：只在浏览器 localStorage，直连服务商接口，不经过任何服务器

   对外暴露的 api() / postSSE() / upload() 与服务器版接口一一对应，
   所以 app.js / quiz-lab.js 不需要区分自己在哪种模式下运行。
   ============================================================ */

import {
  askQuestion,
  answerKeyExcerpt,
  checkLab,
  dockAsk,
  explainQuestion,
  gradeAnswer,
  rerunStage,
  runFullAnalysis,
} from './pipeline.js';
import { complete } from './ai.js';
import { toMarkdown } from './export.js';
import { PROVIDERS, DEFAULT_KEY_URL } from './providers.js';
import { ACCEPT_HINT, buildContext, classify, extractFile, fileToText } from './extract.js';
import { allProjects, currentId, delProject, getProject, putProject, setCurrentId, storageMode } from './store.js';
// 角色判定和服务器版共用同一份规则，避免两边行为不一致
import { classifyRole, isValidRole, matchSolution, projectShape, ROLE_CATALOG, roleLabel } from './roles.js';
import { recommendStages, STAGE_CATALOG, normalizeStages } from './stages.js';

const LS = { key: 'cw_api_key', base: 'cw_api_base', model: 'cw_api_model', lang: 'cw_lang' };
const lsGet = (k) => {
  try {
    return localStorage.getItem(k) || '';
  } catch {
    return '';
  }
};

/* ------------------------------ 项目组（纯静态版存本地） ------------------------------ */

const LS_GROUPS = 'cw_groups';

function readGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_GROUPS) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeGroups(list) {
  try {
    localStorage.setItem(LS_GROUPS, JSON.stringify(list));
  } catch {
    /* 隐私模式忽略 */
  }
}

const newGroupId = () => `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

const newId = (p = 'p') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

class NeedKeyError extends Error {
  constructor(message = '需要提供 API Key') {
    super(message);
    this.code = 'NEED_KEY';
  }
}

/* ------------------------------ AI 配置 ------------------------------ */

function aiConfig() {
  const key = lsGet(LS.key);
  if (!key) throw new NeedKeyError('本站是纯静态页面，需要你自己的 API Key。请点右上角「设置」填入。');
  return {
    apiKey: key,
    baseUrl: (lsGet(LS.base) || DEFAULT_BASE).replace(/\/+$/, ''),
    model: lsGet(LS.model) || DEFAULT_MODEL,
    maxInputChars: 90000,
    keySource: 'browser',
    // 静态版没有服务端，直接从 localStorage 读界面语言
    lang: lsGet(LS.lang) === 'en' ? 'en' : 'zh',
  };
}

/* ------------------------------ 项目读写 ------------------------------ */

/** 这道题属于哪份作业/实验，它对应的标准答案是哪一份 */
function solutionForQuestion(project, question) {
  const all = project.files || [];
  const roleOf = (f) => f.role || classifyRole(f.originalName, f.kind);
  const solutions = all.filter((f) => roleOf(f) === 'solution');
  if (!solutions.length) return null;

  const loc = String(question?.location || '');
  const bar = loc.indexOf('｜');
  const docName = bar >= 0 ? loc.slice(bar + 1).trim() : '';
  const owner = docName ? all.find((f) => f.originalName === docName) : null;
  const candidates = all.filter((f) => ['exercise', 'lab'].includes(roleOf(f)));
  const fallback = candidates.length === 1 ? candidates[0] : null;

  return matchSolution(owner || fallback, solutions);
}

export function contextFor(project) {
  const list = (project.files || []).map((f) => ({ ...f, text: f.text || '' }));
  return { list, context: buildContext(list, 90000) };
}

function slim(project) {
  return {
    id: project.id,
    name: project.name,
    groupId: project.groupId || '',
    shared: false,
    isMine: true,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    analysis: project.analysis || null,
    analysisStale: Boolean(project.analysisStale),
    chat: project.chat || [],
    attempts: project.attempts || {},
    labProgress: project.labProgress || {},
    explain: project.explain || {},
    dockChat: project.dockChat || [],
    shape: (() => {
      const sh = projectShape(project.files || []);
      sh.stages = STAGE_CATALOG;
      sh.recommended = recommendStages(project.files || []);
      return sh;
    })(),
    files: (project.files || []).map((f) => ({
      id: f.id,
      originalName: f.originalName,
      kind: f.kind,
      role: f.role || classifyRole(f.originalName, f.kind),
      roleLabel: f.roleLabel || roleLabel(f.role || classifyRole(f.originalName, f.kind)),
      roleSource: f.roleSource || 'auto',
      size: f.size,
      chars: f.chars,
      meta: f.meta,
      media: (f.media || []).map((m) => ({ url: m.url, fileName: m.fileName })),
      blockCount: f.blocks?.length || 0,
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

async function save(project) {
  project.updatedAt = new Date().toISOString();
  await putProject(project);
  return project;
}

async function newProject(name = '未命名课件', groupId = '') {
  const now = new Date().toISOString();
  const project = {
    id: newId(),
    name,
    groupId: groupId || '',
    createdAt: now,
    updatedAt: now,
    files: [],
    analysis: null,
    chat: [],
    dockChat: [],
    attempts: {},
    labProgress: {},
    explain: {},
  };
  await save(project);
  setCurrentId(project.id);
  return project;
}

/** blob URL 刷新后失效，每次载入项目时重新生成 */
function hydrate(project) {
  if (!project) return project;
  for (const f of project.files || []) {
    if (f.pdfBytes && !f.previewPdf) {
      try {
        f.previewPdf = URL.createObjectURL(new Blob([f.pdfBytes], { type: 'application/pdf' }));
      } catch {
        f.previewNote = '无法在本地渲染这个 PDF';
      }
    }
  }
  return project;
}

/** 服务端版是「每个 cookie 会话一份空间」，静态版就是「这个浏览器一份空间」 */
async function currentProject() {
  const id = currentId();
  if (id) {
    const p = hydrate(await getProject(id));
    if (p) return p;
  }
  const all = await allProjects();
  if (all.length) {
    const p = hydrate(all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0]);
    setCurrentId(p.id);
    return p;
  }
  return newProject();
}

function findQuestion(project, qid) {
  const qs = project.analysis?.quiz?.questions;
  return Array.isArray(qs) ? qs.find((q) => String(q.id) === String(qid)) || null : null;
}

function findLab(project, lid) {
  const ls = project.analysis?.lab?.labs;
  return Array.isArray(ls) ? ls.find((l) => String(l.id) === String(lid)) || null : null;
}

/* ------------------------------ 上传 ------------------------------ */

export async function upload(_projectId, files, onProgress) {
  const project = await currentProject();
  const added = [];
  const failed = [];
  const list = [...files];

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    onProgress?.((i + 0.15) / list.length);
    try {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const result = await extractFile(file);
      const text = fileToText(result);

      // 纯静态版没有 LibreOffice：PDF 直接把原始字节留在本地，用 pdf.js 现渲染成截图；
      // PPTX/DOCX 浏览器渲染不了，只能退回文字。
      let pdfBytes = null;
      let previewNote = '';
      if (result.kind === 'pdf') {
        pdfBytes = await file.arrayBuffer();
      } else if (['pptx', 'ppt', 'docx', 'doc', 'rtf'].includes(ext)) {
        previewNote = '纯静态版无法把 Office 文档渲染成截图（需要 LibreOffice），本页显示提取出的文字';
      }

      const role = classifyRole(file.name, result.kind);
      const record = {
        id: newId('file'),
        originalName: file.name,
        kind: result.kind,
        role,
        roleLabel: roleLabel(role),
        roleSource: 'auto',
        size: file.size,
        chars: text.length,
        meta: result.meta || {},
        blocks: result.blocks || [],
        media: (result.media || []).map((m) => ({ url: m.url, fileName: m.fileName, mime: m.mime })),
        pdfBytes,
        previewNote,
        text,
        preview: text.slice(0, 600),
        addedAt: new Date().toISOString(),
      };
      project.files.push(record);
      added.push({
        id: record.id,
        originalName: file.name,
        kind: record.kind,
        role,
        roleLabel: roleLabel(role),
        chars: record.chars,
        meta: record.meta,
      });
    } catch (err) {
      failed.push({ originalName: file.name, error: err.message });
    }
    onProgress?.((i + 1) / list.length);
  }

  if (added.length && project.analysis) project.analysisStale = true;
  await save(project);
  return { added, failed, project: slim(project) };
}

/* ------------------------------ JSON 接口 ------------------------------ */

export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const [p, qs] = path.split('?');
  const body = options.body ? JSON.parse(options.body) : {};
  let m;

  if (p === '/api/health') return { ok: true, service: '课件讲解平台（静态版）', static: true };

  // 版本号：静态版没有服务端，直接读同目录的 version.json。
  // 必须带 cache-bust —— GitHub Pages 会给它上缓存，否则永远发现不了新部署。
  if (p === '/api/version') {
    try {
      const res = await fetch(`./version.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const v = await res.json();
      return {
        version: String(v.version || '0.0.0'),
        releasedAt: v.releasedAt || '',
        history: Array.isArray(v.history) ? v.history : [],
        // 静态版的页面就是从 GitHub 上拿的，不存在「远端有更新」这回事
        remote: { configured: false, editable: false, version: '', error: '', checkedAt: 0, stale: false },
        static: true,
      };
    } catch {
      return {
        version: '',
        releasedAt: '',
        history: [],
        remote: { configured: false, editable: false, version: '', error: '', checkedAt: 0, stale: false },
        static: true,
      };
    }
  }

  if (p === '/api/config') {
    const all = await allProjects();
    const id = currentId();
    const cur = id ? all.find((x) => x.id === id) : all[0];
    return {
      publicMode: true,
      hasServerKey: false,
      hasDemo: false,
      static: true,
      model: lsGet(LS.model) || DEFAULT_MODEL,
      baseUrl: lsGet(LS.base) || DEFAULT_BASE,
      maxInputChars: 90000,
      providers: PROVIDERS,
      // 类别清单和服务器版共用同一份定义
      roles: ROLE_CATALOG,
      keyUrl: DEFAULT_KEY_URL,
      siteName: '课件讲解平台',
      storage: storageMode(),
      projectCount: all.length,
      currentName: cur?.name || '',
    };
  }

  if (p === '/api/verify-key') {
    const cfg = aiConfig();
    const started = Date.now();
    try {
      const { content } = await complete(cfg, { user: '请只回复两个字：可用', maxTokens: 24, temperature: 0 });
      return { ok: true, model: cfg.model, ms: Date.now() - started, sample: String(content || '').trim().slice(0, 24) };
    } catch (err) {
      const e = new Error(err.message);
      e.status = 400;
      throw e;
    }
  }

  /* ---------------------------- 项目组 ---------------------------- */

  if (p === '/api/groups' && method === 'GET') {
    const all = await allProjects();
    return {
      groups: readGroups(),
      projects: all
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .map((x) => ({
          id: x.id,
          name: x.name,
          groupId: x.groupId || '',
          shared: false,
          isMine: true,
          createdAt: x.createdAt,
          updatedAt: x.updatedAt,
          fileCount: (x.files || []).length,
          hasAnalysis: Boolean(x.analysis),
          totalChars: (x.files || []).reduce((n, f) => n + (f.chars || 0), 0),
          roleCount: (x.files || []).reduce((mp, f) => {
            const r = f.role || classifyRole(f.originalName, f.kind);
            mp[r] = (mp[r] || 0) + 1;
            return mp;
          }, {}),
        })),
    };
  }

  if (p === '/api/groups' && method === 'POST') {
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) throw Object.assign(new Error('请填写项目组名称'), { status: 400 });
    const g = { id: newGroupId(), name, createdAt: new Date().toISOString() };
    writeGroups([...readGroups(), g]);
    return { group: g };
  }

  if ((m = p.match(/^\/api\/groups\/([^/]+)$/))) {
    const list = readGroups();
    const i = list.findIndex((g) => g.id === m[1]);
    if (i < 0) throw Object.assign(new Error('项目组不存在'), { status: 404 });
    if (method === 'PATCH') {
      const name = String(body.name || '').trim().slice(0, 60);
      if (name) list[i].name = name;
      writeGroups(list);
      return { group: list[i] };
    }
    if (method === 'DELETE') {
      // 删组不删项目：组里的项目退回「未分组」
      const all = await allProjects();
      for (const x of all) {
        if (x.groupId === m[1]) {
          x.groupId = '';
          await save(x);
        }
      }
      const next = list.filter((g) => g.id !== m[1]);
      writeGroups(next);
      return { ok: true, groups: next };
    }
  }

  if (p === '/api/projects' && method === 'GET') {
    const all = await allProjects();
    return {
      projects: all
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .map((x) => ({
          id: x.id,
          name: x.name,
          groupId: x.groupId || '',
          shared: false,
          isMine: true,
          createdAt: x.createdAt,
          updatedAt: x.updatedAt,
          fileCount: (x.files || []).length,
          hasAnalysis: Boolean(x.analysis),
          totalChars: (x.files || []).reduce((n, f) => n + (f.chars || 0), 0),
          roleCount: (x.files || []).reduce((mp, f) => {
            const r = f.role || classifyRole(f.originalName, f.kind);
            mp[r] = (mp[r] || 0) + 1;
            return mp;
          }, {}),
        })),
    };
  }

  if (p === '/api/projects' && method === 'POST') {
    return slim(await newProject((body.name || '未命名课件').slice(0, 120), String(body.groupId || '')));
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)$/))) {
    const project = hydrate(await getProject(m[1]));
    if (!project) throw Object.assign(new Error('项目不存在或已被删除'), { status: 404 });
    if (method === 'PATCH') {
      if (typeof body.name === 'string' && body.name.trim()) project.name = body.name.trim().slice(0, 120);
      if (typeof body.groupId === 'string') project.groupId = body.groupId;
      await save(project);
      return slim(project);
    }
    if (method === 'DELETE') {
      await delProject(m[1]);
      if (currentId() === m[1]) setCurrentId('');
      return { ok: true };
    }
    setCurrentId(project.id);
    return slim(project);
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/ask$/)) && method === 'DELETE') {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    project.dockChat = [];
    await save(project);
    return { ok: true, dockChat: [] };
  }

  // 改一份材料的类别（和服务器版同一套规则）
  if ((m = p.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)$/)) && method === 'PATCH') {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const file = (project.files || []).find((f) => f.id === m[2]);
    if (!file) throw Object.assign(new Error('文件不存在'), { status: 404 });
    const want = String(body.role || '').trim();
    if (!isValidRole(want)) throw Object.assign(new Error(`不认识的类别：${want}`), { status: 400 });
    if (want === 'auto') {
      file.role = classifyRole(file.originalName, file.kind);
      file.roleSource = 'auto';
    } else {
      file.role = want;
      file.roleSource = 'manual';
    }
    file.roleLabel = roleLabel(file.role);
    if (project.analysis) project.analysisStale = true;
    await save(project);
    return { ok: true, project: slim(project) };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/text$/))) {
    const project = await getProject(m[1]);
    const file = (project?.files || []).find((f) => f.id === m[2]);
    if (!file) throw Object.assign(new Error('文件不存在'), { status: 404 });
    return { originalName: file.originalName, kind: file.kind, meta: file.meta, blocks: file.blocks };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)$/)) && method === 'DELETE') {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const i = project.files.findIndex((f) => f.id === m[2]);
    if (i < 0) throw Object.assign(new Error('文件不存在'), { status: 404 });
    project.files.splice(i, 1);
    project.analysisStale = true;
    await save(project);
    return { ok: true, project: slim(project) };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/rerun$/))) {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const cfg = aiConfig();
    const files = contextFor(project);
    const data = await rerunStage({ stage: String(body.stage || ''), files, cfg });
    project.analysis = project.analysis || {};
    project.analysis[body.stage] = data;
    await save(project);
    return { ok: true, stage: body.stage, data, project: slim(project) };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/grade$/))) {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const question = findQuestion(project, body.questionId);
    if (!question) throw Object.assign(new Error('找不到这道题，请先生成练习题'), { status: 404 });
    const answer = String(body.answer ?? '').trim();
    if (!answer) throw Object.assign(new Error('请先写下你的答案'), { status: 400 });
    const cfg = aiConfig();
    const { result } = await gradeAnswer({ cfg, question, studentAnswer: answer });
    project.attempts = project.attempts || {};
    project.attempts[question.id] = { answer, result, at: new Date().toISOString() };
    await save(project);
    return { ok: true, questionId: question.id, result, project: slim(project) };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/answer$/))) {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const question = findQuestion(project, body.questionId);
    if (!question) throw Object.assign(new Error('找不到这道题'), { status: 404 });
    project.attempts = project.attempts || {};
    project.attempts[question.id] = {
      ...(project.attempts[question.id] || {}),
      answer: String(body.answer ?? ''),
      savedAt: new Date().toISOString(),
    };
    await save(project);
    return { ok: true };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/attempts$/)) && method === 'DELETE') {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const only = new URLSearchParams(qs || '').get('questionId');
    if (only) delete (project.attempts || {})[String(only)];
    else project.attempts = {};
    await save(project);
    return { ok: true, attempts: project.attempts || {} };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/explain\/([^/]+)$/)) && method === 'DELETE') {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    if (project.explain) delete project.explain[m[2]];
    await save(project);
    return { ok: true, explain: project.explain || {} };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/explain$/))) {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const question = findQuestion(project, body.questionId);
    if (!question) throw Object.assign(new Error('找不到这道题'), { status: 404 });
    if (body.cached !== false && project.explain?.[question.id]?.result) {
      return { ok: true, questionId: question.id, cached: true, ...project.explain[question.id] };
    }
    const cfg = aiConfig();
    const files = contextFor(project);
    // 有答案册就按文件名把这道题和它对应的那份答案配对
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
      concepts: project.analysis?.analysis?.concepts || [],
      title: project.analysis?.analysis?.title || project.name,
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
    await save(project);
    return { ok: true, questionId: question.id, result, excerpt, answerKeyUsed: answerKeyUsed || '' };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/lab\/([^/]+)$/)) && method === 'DELETE') {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    if (project.labProgress) delete project.labProgress[m[2]];
    await save(project);
    return { ok: true, labProgress: project.labProgress || {} };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/lab$/))) {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const lab = findLab(project, body.labId);
    if (!lab) throw Object.assign(new Error('找不到这个实验，请先生成 Lab'), { status: 404 });
    const records = body.records && typeof body.records === 'object' ? body.records : {};
    const steps = Array.isArray(body.steps) ? body.steps : [];
    project.labProgress = project.labProgress || {};
    const entry = { ...(project.labProgress[lab.id] || {}), records, steps, at: new Date().toISOString() };

    if (!body.check) {
      project.labProgress[lab.id] = entry;
      await save(project);
      return { ok: true, saved: true };
    }
    if (!Object.values(records).filter((v) => String(v || '').trim()).length) {
      throw Object.assign(new Error('请至少填写一项实验记录再提交检查'), { status: 400 });
    }
    const cfg = aiConfig();
    const { result } = await checkLab({ cfg, lab, records });
    entry.result = result;
    project.labProgress[lab.id] = entry;
    await save(project);
    return { ok: true, labId: lab.id, result, project: slim(project) };
  }

  if ((m = p.match(/^\/api\/projects\/([^/]+)\/chat$/)) && method === 'DELETE') {
    const project = await getProject(m[1]);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    project.chat = [];
    await save(project);
    return { ok: true };
  }

  if (p.endsWith('/transcribe')) {
    throw Object.assign(
      new Error(
        '纯静态版不支持课堂录像转写：转写要先在服务端提取音轨、再用语音接口识别，浏览器里做不到（也会暴露你的密钥）。\n\n请在服务端版里用这个功能，或直接把录像当附件在这里播放。',
      ),
      { status: 400 },
    );
  }

  throw Object.assign(new Error(`静态版不支持这个接口：${p}`), { status: 404 });
}

/* ------------------------------ 流式接口 ------------------------------ */

export async function postSSE(path, body, onEvent) {
  const m =
    path.match(/^\/api\/projects\/([^/]+)\/analyze$/) ||
    path.match(/^\/api\/projects\/([^/]+)\/ask$/) ||
    path.match(/^\/api\/projects\/([^/]+)\/chat$/);
  if (!m) throw new Error(`静态版不支持这个流式接口：${path}`);
  const project = await getProject(m[1]);
  if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });

  if (/\/analyze$/.test(path)) {
    if (!project.files.length) throw Object.assign(new Error('请先上传至少一个课件文件'), { status: 400 });
    const cfg = aiConfig();
    if (body?.name) project.name = String(body.name).slice(0, 120);
    const files = contextFor(project);
    onEvent({ type: 'start', files: project.files.length, contextChars: files.context.length, model: cfg.model });

    const result = await runFullAnalysis({
      files,
      cfg,
      only: normalizeStages(body?.stages),
      emit: onEvent,
    });
    project.analysis = result;
    project.analysisStale = false;
    await save(project);
    onEvent({ type: 'saved', project: slim(project) });
    return;
  }

  // 右侧 AI 咨询：带着用户拖进来的内容块
  if (/\/ask$/.test(path)) {
    const question = String(body?.question || '').trim();
    const attachments = (Array.isArray(body?.attachments) ? body.attachments : []).slice(0, 12).map((a) => ({
      title: String(a?.title || '').slice(0, 160),
      source: String(a?.source || '').slice(0, 160),
      text: String(a?.text || '').slice(0, 6000),
    }));
    if (!question && !attachments.length) {
      throw Object.assign(new Error('请先拖入要讨论的内容，或输入一个问题'), { status: 400 });
    }
    const cfg = aiConfig();
    let answer = '';
    project.dockChat = project.dockChat || [];
    const text = await dockAsk({
      files: contextFor(project),
      cfg,
      question,
      attachments,
      history: project.dockChat.slice(-10),
      onDelta: (d) => {
        answer += d;
        onEvent({ type: 'delta', text: d });
      },
    });
    answer = text || answer;
    if (!answer) throw new Error('模型没有返回内容，请重试');
    project.dockChat.push({ role: 'user', content: question, attachments, at: new Date().toISOString() });
    project.dockChat.push({ role: 'assistant', content: answer, at: new Date().toISOString() });
    project.dockChat = project.dockChat.slice(-80);
    await save(project);
    onEvent({ type: 'done' });
    return;
  }

  // 课件问答
  const question = String(body?.question || '').trim();
  if (!question) throw Object.assign(new Error('请输入问题'), { status: 400 });
  const cfg = aiConfig();
  let answer = '';
  const text = await askQuestion({
    files: contextFor(project),
    cfg,
    question,
    history: (project.chat || []).slice(-8),
    onDelta: (d) => {
      answer += d;
      onEvent({ type: 'delta', text: d });
    },
  });
  answer = text || answer;
  if (!answer) throw new Error('模型没有返回内容，请重试');
  project.chat.push({ role: 'user', content: question, at: new Date().toISOString() });
  project.chat.push({ role: 'assistant', content: answer, at: new Date().toISOString() });
  project.chat = project.chat.slice(-60);
  await save(project);
  onEvent({ type: 'done' });
}

/* ------------------------------ 导出 ------------------------------ */

export async function downloadExport(projectId) {
  const project = await getProject(projectId);
  if (!project?.analysis) throw new Error('还没有生成分析结果');
  const md = toMarkdown(project);
  const safe = (project.analysis?.analysis?.title || project.name || '课件分析').replace(/[\\/:*?"<>|]/g, '_');
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}-讲解方案.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export { ACCEPT_HINT, classify };
