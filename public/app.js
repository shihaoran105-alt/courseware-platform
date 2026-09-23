/* ============================================================
   课件讲解平台 — 前端逻辑
   ============================================================ */

/** 加载中的转圈占位 */
const SPIN_SVG = '<span class="spin"></span>';

/** 静态构建（GitHub Pages）时为 true，后端调用交给 window.CWBackend */
const IS_STATIC = typeof window !== 'undefined' && window.CW_STATIC === true;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* 访客自己的 API 配置只存在浏览器 localStorage，随请求发给服务器用完即弃 */
const LS = {
  key: 'cw_api_key',
  base: 'cw_api_base',
  model: 'cw_api_model',
  provider: 'cw_api_provider',
  lastProject: 'cw_last_project',
};
const lsGet = (k) => {
  try {
    return localStorage.getItem(k) || '';
  } catch {
    return '';
  }
};
const lsSet = (k, v) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* 隐私模式下可能不可用，忽略 */
  }
};

const state = {
  config: null,
  project: null,
  tab: 'overview',
  view: 'empty', // empty | ready | analyzing | done
  stages: [],
  progress: 0,
  presenter: { index: 0, slideOffset: 0, timer: null, seconds: 0 },
  chatStreaming: false,
  apiKey: lsGet(LS.key),
  apiBase: lsGet(LS.base),
  apiModel: lsGet(LS.model),
  providerId: lsGet(LS.provider) || 'deepseek',
  gateOpen: false,
  // 项目组
  groups: [],
  projects: [],
  collapsedGroups: new Set(),
  // 右侧 AI 咨询
  dock: { open: true, attachments: [], sending: false },
  // 全屏讲解里的「就这一页提问」：它自己那条对话（开合状态）
  pageChat: { open: true, sending: false },
  // 中英对照的显示方式：both（上下对照）| zh（只看中文）| en（只看英文）
  biView: 'both',
  passLabel: '',
  // 版本号：current = 服务器上的版本，loaded = 我这一页的版本，
  // remote = GitHub 上的版本（由服务端后台去拉）
  version: null,
  versionNotice: '',
};

/** 服务器是否必须让访客自带 Key */
function keyRequired() {
  const c = state.config;
  if (!c) return false;
  return Boolean(c.publicMode) || !c.hasServerKey;
}
/** 当前是否有可用的 Key（自己的，或本机模式下服务端的） */
function hasUsableKey() {
  return Boolean(state.apiKey) || !keyRequired();
}

/* ------------------------------- 工具 ------------------------------- */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, kind === 'err' ? 6500 : 3600);
}

/**
 * 去掉 AI 回答里的加粗标记。** 对用户没有任何作用，留着就是字面量的星号。
 */
function stripBold(s) {
  return String(s ?? '').replace(/\*\*/g, '');
}

/**
 * AI 问答专用：把 ** 和 $ 全部去掉。
 *
 * 问答区不渲染数学公式，模型却习惯用 $…$ / $$…$$ 写 LaTeX，用户看到的就是一串
 * 光秃秃的美元符号。** 同理 —— 虽然 mdToHtml 能把它渲染成加粗，但需求是「一个
 * 标记都不留」，所以这里直接抹掉。
 *
 * 只用在问答（课件问答 / 右侧 AI 咨询）。课件分析那些面板里的 $0000、$FF 是
 * AVR / 8086 的十六进制写法，有实际含义，不能一起抹掉。
 */
function stripAiMarks(s) {
  return stripBold(s).replace(/\$/g, '');
}

/** 极简 Markdown → HTML（先转义，保证安全） */
function mdToHtml(src) {
  const codeBlocks = [];
  let s = String(src ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code.replace(/\n$/, ''));
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });

  const inline = (t) =>
    t
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\u0000CB(\d+)\u0000/g, (_m, i) => `<pre><code>${esc(codeBlocks[+i])}</code></pre>`);

  s = esc(s);
  const lines = s.split('\n');
  const out = [];
  let list = null;
  let para = [];
  let table = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map((r) => r.split('|').slice(1, -1).map((c) => c.trim()));
    const isSep = (r) => r.every((c) => /^:?-{2,}:?$/.test(c));
    let head = '';
    let bodyRows = rows;
    if (rows.length > 1 && isSep(rows[1])) {
      head = `<thead><tr>${rows[0].map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`;
      bodyRows = rows.slice(2);
    }
    const body = bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
    out.push(`<table>${head}<tbody>${body}</tbody></table>`);
    table = [];
  };

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      flushPara();
      closeList();
      flushTable();
      continue;
    }
    if (/^\u0000CB\d+\u0000$/.test(t)) {
      flushPara();
      closeList();
      flushTable();
      out.push(inline(t));
      continue;
    }
    if (/^\|.*\|$/.test(t)) {
      flushPara();
      closeList();
      table.push(t);
      continue;
    }
    flushTable();

    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      const lv = Math.min(h[1].length + 2, 6);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }
    const ul = t.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = t.match(/^\d+[.)、]\s*(.*)$/);
    if (ol) {
      flushPara();
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    para.push(inline(t));
  }
  flushPara();
  closeList();
  flushTable();
  return out.join('');
}

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && String(x).trim() !== '') : []);
const listHtml = (v, fallback = '_课件未提供_') => {
  const items = arr(v);
  return items.length ? `<ul class="clean">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p style="color:var(--text-3)">${fallback}</p>`;
};

/* ------------------------------- API ------------------------------- */

/** 带上访客自己的 API 配置（服务器只用一次，不保存） */
/** 当前界面语言；模型生成的内容要跟着它走 */
function currentLang() {
  return window.CWI18n?.lang || 'zh';
}

function apiHeaders() {
  const h = { 'Content-Type': 'application/json', 'X-Lang': currentLang() };
  if (state.apiKey) h['X-API-Key'] = state.apiKey;
  if (state.apiBase) h['X-API-Base'] = state.apiBase;
  if (state.apiModel) h['X-API-Model'] = state.apiModel;
  return h;
}

/** 统一的错误对象，needsKey 时前端要弹出填 Key 的引导 */
function apiError(message, status, data = {}) {
  const err = new Error(message || `请求失败（${status}）`);
  err.status = status;
  err.needsKey = Boolean(data.needsKey);
  return err;
}

async function api(path, options = {}) {
  if (IS_STATIC) return window.CWBackend.api(path, options);
  const res = await fetch(path, { headers: apiHeaders(), ...options });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = apiError(data.error, res.status, data);
    if (err.needsKey) openGate('需要 API Key 才能使用这个功能');
    throw err;
  }
  return data;
}

/** 读取 SSE 流（POST 请求，所以不能用 EventSource） */
async function postSSE(path, body, onEvent) {
  if (IS_STATIC) return window.CWBackend.postSSE(path, body, onEvent);
  const res = await fetch(path, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* 忽略 */
    }
    const err = apiError(data.error, res.status, data);
    if (err.needsKey) openGate('需要 API Key 才能开始分析');
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch {
        /* 忽略心跳 */
      }
    }
  }
}

function uploadWithProgress(projectId, files, onProgress) {
  if (IS_STATIC) return window.CWBackend.upload(projectId, files, onProgress);
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/${projectId}/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 300) reject(new Error(data.error || `上传失败（${xhr.status}）`));
        else resolve(data);
      } catch {
        reject(new Error('服务器返回了无法解析的内容'));
      }
    };
    xhr.onerror = () => reject(new Error('上传时网络中断'));
    xhr.send(fd);
  });
}

/* ------------------------------- 启动 ------------------------------- */

async function init() {
  fillStaticIcons();
  wireStaticEvents();
  try {
    state.config = await api('/api/config');
    document.title = state.config.siteName || '课件讲解平台';
    renderConfigChips();
  } catch {
    /* 忽略 */
  }
  // 记一下上次打开的项目，刷新后还回到那里
  await loadWorkspace();
  const lastId = lsGet(LS.lastProject);
  const pick = state.projects.find((p) => p.id === lastId) || state.projects.find((p) => p.isMine) || state.projects[0];
  try {
    if (pick) state.project = await api(`/api/projects/${pick.id}`);
  } catch {
    /* 忽略 */
  }
  if (!state.project) {
    state.project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: '未命名课件' }) });
    await loadWorkspace();
  }
  syncView();
  render();
  applyHash();
  wireVersion();
  maybeShowGate();
}

/** 首次进入：公开部署且没填过 Key 时，弹出引导页 */
function maybeShowGate() {
  if (state.gateOpen) return;
  if (state.apiKey || !keyRequired()) return;
  openGate();
}

/** 从演示项目回到访客自己的项目空间（优先复用已有项目，避免堆一堆空项目） */
async function switchToOwnProject() {
  try {
    const { projects } = await api('/api/projects');
    const mine = projects.filter((p) => p.isMine);
    const target = mine.find((p) => p.fileCount === 0) || mine[0];
    if (target) {
      state.project = await api(`/api/projects/${target.id}`);
      toast('已回到你的项目空间');
    } else {
      state.project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: '未命名课件' }) });
      toast('已新建项目');
    }
    state.tab = 'overview';
    syncView();
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** 支持 #examples / #guide / #narration / #chat / #present / #settings 直达 */
function applyHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return;
  if (h === 'present') {
    if (state.view === 'done') openPresenter(0);
    return;
  }
  if (h === 'settings') {
    openSettings();
    return;
  }
  if (TABS.some((t) => t.id === h) && state.view === 'done') {
    state.tab = h;
    render();
  }
}

/** 把 HTML 里预留的图标位填上（避免在 HTML 里内联 SVG） */
function fillStaticIcons() {
  const logo = $('#brandLogo');
  if (logo) logo.innerHTML = icon('cap', 17);
  const dz = $('#dzIcon');
  if (dz) dz.innerHTML = icon('upload', 22);
  const sb = $('#settingsBtn');
  if (sb) sb.innerHTML = icon('settings', 14) + '设置';
}

function renderConfigChips() {
  const cfg = state.config || {};
  const model = state.apiModel || cfg.model || '—';
  $('#modelChip').textContent = IS_STATIC && cfg.storage ? `模型：${model} · 存储：${cfg.storage === 'indexeddb' ? 'IndexedDB' : '本地缓存'}` : `模型：${model}`;
  const chip = $('#keyChip');
  const keyUrl = cfg.keyUrl || 'https://platform.deepseek.com/api_keys';
  if (state.apiKey) {
    chip.className = 'chip ok';
    chip.innerHTML = `<span class="dot"></span>我的 API Key 已配置`;
    chip.title = '点击可修改';
  } else if (cfg.hasServerKey) {
    chip.className = 'chip ok';
    chip.innerHTML = `<span class="dot"></span>使用本站 API Key`;
    chip.title = '本站已提供 Key，你也可以换成自己的';
  } else {
    chip.className = 'chip warn';
    chip.innerHTML = `<span class="dot"></span>未配置 API Key · 点此填写`;
    chip.title = `到 ${keyUrl} 申请`;
  }
  chip.style.cursor = 'pointer';
  chip.onclick = () => openSettings();
}

/* ==================== 版本号 & 更新提示 ==================== */

/**
 * 版本检测的思路：
 *   页面加载时记下「我这一页是什么版本」（state.version.loaded），
 *   之后定时问一次服务器现在是什么版本。两者不一致 = 服务器上的代码比我手上这页新，
 *   右上角版本号变红，点开就能看更新内容并一键更新。
 *
 * 这正好覆盖「代码改了、服务重启了，但你页面还开着」的场景 —— 不用再手动 Cmd+Shift+R。
 */
const VERSION_POLL_MS = 45000;

async function loadVersion({ initial = false } = {}) {
  try {
    const v = await api('/api/version', { cache: 'no-store' });
    if (!v?.version) return;
    const prev = state.version;
    state.version = {
      current: v.version,
      buildId: v.buildId || '',
      releasedAt: v.releasedAt || '',
      history: arr(v.history),
      // 页面刚加载时，当前版本就是「我这一页的版本」
      loaded: initial || !prev ? v.version : prev.loaded,
      loadedBuildId: initial || !prev ? (v.buildId || '') : prev.loadedBuildId,
      // 远端（GitHub）上的版本，由服务端后台去拉，拉不到就是空的
      remote: v.remote || null,
    };
    renderVersionChip();
    if (!initial && prev && prev.current !== v.version) {
      toast(`平台已更新到 ${v.version}，点右上角版本号查看更新内容`, 'ok');
    }
    // 远端出现比本地更新的版本时提示一次（同一条只提示一次，别每 45 秒烦人）
    const remote = state.version.remote || {};
    const remoteNeedsRepair = remoteUpdateAvailable(state.version, remote);
    const remoteNotice = `${remote.version || ''}:${remote.buildId || ''}`;
    if (!initial && remoteNeedsRepair && state.versionNotice !== remoteNotice) {
      state.versionNotice = remoteNotice;
      const sameVersion = remote.version === v.version;
      toast(sameVersion ? '发现同版本代码包不一致，点右上角进行修复' : `GitHub 上已有新版本 v${remote.version}，点右上角版本号看更新内容`, 'ok');
    }
  } catch {
    /* 拿不到就当作没有版本信息，不打扰用户 */
  }
}

/** 右上角该显示什么状态：page = 我这一页旧了；remote = GitHub 上有新版；ok */
function versionChipState() {
  const v = state.version;
  if (!v?.current) return { kind: 'none' };
  const pageStale = Boolean(v.loaded) && (v.loaded !== v.current || v.loadedBuildId !== v.buildId);
  const rv = v.remote?.version || '';
  const remoteNewer = remoteUpdateAvailable(v, v.remote || {});
  // 页面旧了就先解决页面（点一下就能好）；否则看远端有没有新版
  if (pageStale) return { kind: 'page', from: v.loaded, to: v.current };
  if (remoteNewer) return { kind: 'remote', from: v.current, to: rv, repair: rv === v.current };
  return { kind: 'ok' };
}

function renderVersionChip() {
  const el = $('#versionChip');
  if (!el) return;
  const v = state.version;
  if (!v?.current) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const s = versionChipState();
  el.className = 'chip version-chip' + (s.kind === 'page' || s.kind === 'remote' ? ' stale' : '');
  if (s.kind === 'page') {
    el.textContent = `v${s.from} → v${s.to}`;
    el.title = `服务器上已经是 v${s.to}，点一下更新到这一版`;
  } else if (s.kind === 'remote') {
    el.textContent = s.repair ? `v${s.from} · 需修复` : `v${s.from} → v${s.to}`;
    el.title = s.repair ? '版本号相同，但本机代码包与 GitHub 不一致，点一下修复' : `GitHub 上已发布 v${s.to}，点一下看更新内容`;
  } else {
    el.textContent = `v${v.current}`;
    el.title = `当前版本 v${v.current}，点击查看版本历史与更新检查`;
  }
}

/** 列出「比我现在这一页新」的那些版本 */
function pendingChanges() {
  const v = state.version;
  if (!v) return [];
  const list = arr(v.history);
  const cut = list.findIndex((h) => h.version === v.loaded);
  if (cut === 0) return [];
  if (cut > 0) return list.slice(0, cut);
  // loaded 不在历史里（例如从更早的版本升上来），就把比它新的都列出来
  return list.filter((h) => compareVersion(h.version, v.loaded) > 0);
}

function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function remoteUpdateAvailable(local = {}, remote = {}) {
  if (!remote.version || !local.current) return false;
  const order = compareVersion(remote.version, local.current);
  if (order > 0) return true;
  if (order < 0) return false;
  return Boolean(remote.buildId) && remote.buildId !== (local.buildId || '');
}

/** 从 raw 地址反推出仓库主页，好给用户一个「去仓库看看」的链接 */
function repoUrlFrom(rawUrl = '') {
  const m = String(rawUrl).match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//);
  if (m) return `https://github.com/${m[1]}/${m[2]}`;
  const c = String(rawUrl).match(/^https?:\/\/([^/]+)\.github\.io\/([^/]+)\//);
  if (c) return `https://github.com/${c[1]}/${c[2]}`;
  return '';
}

/** 远端比本地新的那些版本（远端清单里排在前面的就是更新的） */
function remotePendingChanges() {
  const v = state.version;
  const rv = v?.remote?.version || '';
  if (!rv || !remoteUpdateAvailable(v, v.remote || {})) return [];
  if (rv === v.current) return [];
  const list = arr(v.remote.history);
  const cut = list.findIndex((h) => h.version === v.current);
  if (cut === 0) return [];
  if (cut > 0) return list.slice(0, cut);
  return list.filter((h) => compareVersion(h.version, v.current) > 0);
}

function openVersionModal() {
  const v = state.version || {};
  const s = versionChipState();
  const pending = pendingChanges();
  const remotePending = remotePendingChanges();
  const remote = v.remote || {};
  const repo = repoUrlFrom(remote.url);

  const block = (h) => `<h4>
      <span class="ver-tag">v${esc(h.version)}</span>
      ${esc(h.title || '')}
      <span class="ver-date">${esc(h.date || '')}</span>
    </h4>
    ${arr(h.changes).length ? `<ul>${h.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}`;

  const parts = [];

  // 一、页面比服务器旧 —— 点一下就解决
  if (s.kind === 'page') {
    parts.push(`<p style="color:var(--ink-2);font-size:13.5px;margin:0 0 4px">
        你这一页还是 <b>v${esc(v.loaded)}</b>，服务器上已经是 <b>v${esc(v.current)}</b>。
      </p>
      <div class="changelog">${pending.map(block).join('') || '<p style="color:var(--ink-4)">（这次更新没有写说明）</p>'}</div>`);
  }

  // 二、GitHub 上有更新的版本 —— 本机部署可直接下载、替换并重启
  if (s.kind === 'remote' || remotePending.length) {
    parts.push(`<div class="update-remote">
      <p style="color:var(--ink-2);font-size:13.5px;margin:0 0 4px">
        ${s.repair ? `GitHub 上的 v${esc(remote.version)} 构建与你本机不一致。` : `GitHub 上已发布 <b>v${esc(remote.version)}</b>，你这边是 <b>v${esc(v.current)}</b>。`}
        ${remote.editable === false ? '请联系服务器管理员更新。' : '可以直接下载新版本并替换旧程序；项目数据和本机配置会保留。'}
      </p>
      <div class="changelog">${remotePending.map(block).join('') || `<p style="color:var(--ink-4)">（远端没有给出更新说明）</p>`}</div>
      ${remote.editable === false ? '' : `<p style="margin:10px 0 0;font-size:12.5px;color:var(--ink-3)">更新时会删除旧程序文件，保留 data、.env 和 Git 仓库信息。</p>`}
      ${repo ? `<p style="margin:10px 0 0;font-size:12.5px"><a href="${esc(repo)}" target="_blank" rel="noopener">去 GitHub 仓库看看 ↗</a></p>` : ''}
    </div>`);
  }

  // 三、更新检查的配置（本机模式才能改）
  parts.push(updateCheckBox(remote));

  // 四、都没有 → 版本历史
  if (s.kind === 'ok' && !remotePending.length) {
    parts.push(`<p style="color:var(--ink-2);font-size:13.5px;margin:0 0 4px">
        当前已是最新版本 <b>v${esc(v.current)}</b>${v.releasedAt ? `（${esc(String(v.releasedAt).slice(0, 10))}）` : ''}。
      </p>
      <div class="changelog">${arr(v.history).slice(0, 6).map(block).join('')}</div>`);
  }

  const title =
    s.kind === 'page' ? '发现新版本' : s.kind === 'remote' || remotePending.length ? 'GitHub 上有新版本' : '版本历史';

  openModal(
    `<h3>${title}</h3>
     ${parts.join('')}
     <div class="modal-actions">
       <button class="btn" data-close>关闭</button>
       ${s.kind === 'page' || (s.kind === 'remote' && remote.editable !== false) ? `<button class="btn primary" id="doUpdate">${icon('download', 13)}${s.kind === 'remote' ? (s.repair ? '下载完整包并修复' : '下载并安装更新') : '刷新到新版本'}</button>` : ''}
     </div>`,
  );
  $('#doUpdate')?.addEventListener('click', doUpdate);
  wireUpdateCheckBox();
}

/** 弹窗底部的「更新检查」配置块 */
function updateCheckBox(remote) {
  if (remote.configured) {
    const when = remote.checkedAt ? new Date(remote.checkedAt).toLocaleString('zh-CN') : '还没成功查过';
    const state = remote.error
      ? `<span style="color:var(--warn)">上次检查失败：${esc(remote.error)}</span>`
      : remote.version
        ? `远端最新：<b>v${esc(remote.version)}</b>`
        : '等待第一次检查…';
    return `<div class="upd-check">
      <div class="upd-row">
        <span class="upd-lbl">更新检查</span>
        <code class="upd-url" title="${esc(remote.url)}">${esc(remote.url)}</code>
      </div>
      <div class="upd-row upd-meta">${state}　·　上次检查：${esc(when)}</div>
      <div class="upd-row" style="margin-top:8px">
        <button class="btn sm" id="updNow">${icon('refresh', 12)}立即检查</button>
        ${remote.editable === false ? '' : `<button class="btn sm ghost" id="updEdit">修改地址</button>`}
      </div>
    </div>`;
  }
  if (remote.editable === false) {
    return `<div class="upd-check"><div class="upd-row upd-meta">本站没有配置更新检查地址。</div></div>`;
  }
  return `<div class="upd-check">
    <div class="upd-row"><span class="upd-lbl">更新检查</span>
      <span class="upd-meta">填上你 GitHub 仓库里 version.json 的地址，之后就能自动发现新版本</span>
    </div>
    <div class="upd-row" style="margin-top:8px">
      <input type="text" id="updUrl" class="text-input" style="font-size:12.5px"
        placeholder="https://raw.githubusercontent.com/用户名/仓库/main/version.json">
      <button class="btn sm primary" id="updSave">保存</button>
    </div>
  </div>`;
}

function wireUpdateCheckBox() {
  $('#updSave')?.addEventListener('click', async () => {
    const url = ($('#updUrl')?.value || '').trim();
    try {
      await api('/api/settings/update-check', { method: 'PATCH', body: JSON.stringify({ url }) });
      toast(url ? '已保存，正在检查…' : '已关闭更新检查');
      await loadVersion();
      openVersionModal();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  $('#updNow')?.addEventListener('click', async () => {
    const btn = $('#updNow');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = SPIN_SVG + '检查中…';
    }
    try {
      const r = await api('/api/version/check', { method: 'POST' });
      if (r.remote) state.version.remote = r.remote;
      renderVersionChip();
      openVersionModal();
      toast(r.remote?.version ? `远端最新 v${r.remote.version}` : '远端没有返回版本号', r.remote?.error ? 'err' : 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  $('#updEdit')?.addEventListener('click', async () => {
    const cur = state.version?.remote?.url || '';
    const url = await promptText({
      title: '更新检查地址',
      label: 'version.json 的地址',
      value: cur,
      placeholder: 'https://raw.githubusercontent.com/用户名/仓库/main/version.json',
      hint: '留空 = 关闭更新检查。填 GitHub 仓库里的 version.json 的 raw 地址。',
    });
    if (url === null) return;
    try {
      await api('/api/settings/update-check', { method: 'PATCH', body: JSON.stringify({ url: url.trim() }) });
      toast(url.trim() ? '已更新地址，正在检查…' : '已关闭更新检查');
      await loadVersion();
      openVersionModal();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/**
 * 「更新」= 带版本号重新加载。
 *
 * 前端资源已经是 no-cache，直接重载就能拿到新文件；
 * 仍然带上 ?v= 参数，让中间任何一层代理缓存也一并失效。
 */
async function doUpdate() {
  const s = versionChipState();
  if (s.kind !== 'remote') {
    const v = state.version?.current || Date.now();
    const { pathname, hash } = window.location;
    window.location.replace(`${pathname}?v=${encodeURIComponent(v)}${hash}`);
    return;
  }

  const btn = $('#doUpdate');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = SPIN_SVG + '　正在下载并替换旧版本…';
  }
  try {
    const result = await api('/api/version/update', { method: 'POST' });
    if (!result.updated) {
      toast(result.message || '当前已经是最新版', 'ok');
      closeModal();
      return;
    }
    if (btn) btn.innerHTML = SPIN_SVG + '　正在重启平台…';
    const target = result.version;
    const targetBuildId = result.buildId || '';
    const started = Date.now();
    const waitForRestart = async () => {
      try {
        const v = await api(`/api/version?t=${Date.now()}`, { cache: 'no-store' });
        if (v?.version === target && (!targetBuildId || v?.buildId === targetBuildId)) {
          const { pathname, hash } = window.location;
          window.location.replace(`${pathname}?v=${encodeURIComponent(target)}${hash}`);
          return;
        }
      } catch {
        // 重启期间连接失败是预期行为。
      }
      if (Date.now() - started > 300000) {
        toast('更新文件已写入，但自动重启超时。请双击桌面启动器。', 'err');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '重新检查';
        }
        return;
      }
      setTimeout(waitForRestart, 1500);
    };
    setTimeout(waitForRestart, 1200);
  } catch (err) {
    toast(err.message || '更新失败', 'err');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重试更新';
    }
  }
}

/** 语言切换后的提示：生成好的内容是存下来的数据，不会自动翻译 */
document.addEventListener('cw:lang', (e) => {
  const en = e.detail?.lang === 'en';
  if (state.project?.analysis) {
    toast(en ? 'Interface switched to English. Generated content keeps its original language — regenerate to get an English version.' : '界面已切回中文。已生成的内容不会自动翻译，重新生成即可得到中文版。', 'ok');
  } else {
    toast(en ? 'Interface switched to English' : '界面已切回中文', 'ok');
  }
});

function wireVersion() {
  const el = $('#versionChip');
  if (!el) return;
  el.addEventListener('click', openVersionModal);
  loadVersion({ initial: true });
  // 定时问一次；切回这个标签页 / 窗口重新获得焦点时也立刻问一次
  setInterval(() => loadVersion(), VERSION_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadVersion();
  });
  window.addEventListener('focus', () => loadVersion());
}

function syncView() {
  const p = state.project;
  if (!p) {
    state.view = 'empty';
    return;
  }
  if (state.view === 'analyzing') return;
  if (!p.files?.length) state.view = 'empty';
  else if (!p.analysis) state.view = 'ready';
  else state.view = 'done';
}

/* ------------------------------- 渲染 ------------------------------- */

const TABS = [
  { id: 'overview', label: '课件分析', icon: 'chart' },
  { id: 'combine', label: '结合课件讲解', icon: 'wand' },
  { id: 'examples', label: '事例讲解', icon: 'bulb' },
  { id: 'guide', label: '学习规划', icon: 'compass' },
  { id: 'narration', label: '逐页讲解', icon: 'mic' },
  { id: 'summary', label: '总结分析', icon: 'layers' },
  { id: 'mindmap', label: '思维导图', icon: 'mindmap' },
  { id: 'quiz', label: '做题', icon: 'pen' },
  { id: 'lab', label: '做 Lab', icon: 'flask' },
  { id: 'chat', label: '课件问答', icon: 'chat' },
];

/* ==================== 可拖拽内容块 + 右侧 AI 咨询 ==================== */

/**
 * 拖拽登记表。
 * 不把正文写进 DOM 属性（太长、还有转义问题），只发一个短 key，
 * 真正的内容存在这里，拖放时按 key 取。
 */
const dndStore = new Map();
let dndSeq = 0;

/**
 * 把一个内容块登记成可拖拽 + 可点击加入的。
 *
 *   const d = dnd({ title:'第 3 步', source:'Lab 4', text: s.action });
 *   `<div ${d.attrs}>…${d.btn}</div>`
 *
 * 用法必须成对：attrs 给容器，btn 给那个 ⊕ 按钮。
 */
function dnd(payload) {
  // 元素被替换后旧 key 就没用了，留一个上限兜底，避免长时间不刷新时无限增长
  if (dndStore.size > 2000) dndStore.clear();
  const key = 'd' + ++dndSeq;
  dndStore.set(key, {
    title: String(payload.title || '未命名内容').slice(0, 200),
    source: String(payload.source || '').slice(0, 200),
    text: String(payload.text || '').slice(0, 8000),
  });
  return {
    key,
    attrs: `draggable="true" data-drag="${key}"`,
    btn: `<button class="dnd-add" data-dragadd="${key}" title="加入右侧 AI 咨询">${icon('plus', 12)}</button>`,
  };
}

/** 拖拽时给个统一的「内容块」外观 */
function wireDndRoot(root) {
  if (!root) return;
  root.addEventListener('dragstart', (e) => {
    const el = e.target.closest?.('[data-drag]');
    if (!el) return;
    const key = el.dataset.drag;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/x-cw-block', key);
    e.dataTransfer.setData('text/plain', dndStore.get(key)?.title || '');
    el.classList.add('dragging');
    dockHighlight(true);
  });
  root.addEventListener('dragend', (e) => {
    e.target.closest?.('[data-drag]')?.classList.remove('dragging');
    dockHighlight(false);
  });
  // 点 ⊕ 也能加入，比拖拽更好发现（触屏和触控板用户友好）
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dragadd]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    addAttachment(b.dataset.dragadd);
  });
}

/** 把某个 key 对应的内容块加进待提问列表 */
function addAttachment(key) {
  const item = dndStore.get(key);
  if (!item) return;
  const dup = state.dock.attachments.find((a) => a.key === key);
  if (dup) {
    toast('这块内容已经在对话里了');
    return;
  }
  state.dock.attachments.push({ ...item, key });
  state.dock.open = true;
  renderDock();
  $('#dockInput')?.focus();
  toast(`已加入「${item.title}」`);
}

function removeAttachment(key) {
  state.dock.attachments = state.dock.attachments.filter((a) => a.key !== key);
  renderDock();
}

function dockHighlight(on) {
  $('#aiDock')?.classList.toggle('drop-target', Boolean(on));
}

function renderDock() {
  const dock = $('#aiDock');
  if (!dock) return;
  dock.classList.toggle('collapsed', !state.dock.open);

  const ctx = $('#dockCtx');
  if (ctx) {
    const list = state.dock.attachments;
    ctx.innerHTML = list.length
      ? list
          .map(
            (a) => `<span class="ctx-chip" title="${esc(a.source ? a.source + ' · ' : '')}${esc(a.text.slice(0, 300))}">
              <b>${esc(a.title)}</b>
              <button class="ctx-x" data-ctxdel="${esc(a.key)}" title="移出">${icon('x', 11)}</button>
            </span>`,
          )
          .join('') + `<button class="ctx-clear" id="ctxClear">全部移出</button>`
      : '<span class="ctx-empty">把左边任意内容拖进来（或点它旁边的 ＋）</span>';
  }

  const msgs = $('#dockMsgs');
  if (msgs) {
    const list = arr(state.project?.dockChat);
    msgs.innerHTML = list.length
      ? list.map(dockMsgHtml).join('')
      : `<div class="dock-welcome">
          <p><b>这里可以就任何一块内容追问。</b></p>
          <ul>
            <li>把<b>实验步骤</b>拖进来 → 问「这一步为什么这么做」</li>
            <li>把<b>某道题</b>拖进来 → 问「换个条件还成立吗」</li>
            <li>把<b>一页讲解稿</b>拖进来 → 问「这段怎么讲更清楚」</li>
          </ul>
          <p class="dock-welcome-tip">只把内容拖进来、不提问也行，AI 会主动讲解这一块。</p>
        </div>`;
  }

  const send = $('#dockSend');
  if (send) {
    send.disabled = state.dock.sending || (!state.dock.attachments.length && !$('#dockInput')?.value.trim());
    send.innerHTML = state.dock.sending ? SPIN_SVG + '思考中' : icon('send', 13) + '发送';
  }
  scrollDock();
}

function dockMsgHtml(m) {
  const isUser = m.role === 'user';
  const atts = arr(m.attachments);
  return `<div class="dock-msg ${isUser ? 'user' : 'ai'}">
    ${atts.length ? `<div class="dock-msg-atts">${atts.map((a) => `<span class="att-tag">${icon('quote', 10)}${esc(a.title)}</span>`).join('')}</div>` : ''}
    ${m.content ? `<div class="dock-bubble">${isUser ? esc(m.content) : mdToHtml(stripAiMarks(m.content))}</div>` : ''}
  </div>`;
}

function scrollDock() {
  const el = $('#dockMsgs');
  if (el) el.scrollTop = el.scrollHeight;
}

function dockReset() {
  state.dock.attachments = [];
  state.dock.sending = false;
  dndStore.clear();
  renderDock();
}

async function dockSend() {
  if (state.dock.sending) return;
  const input = $('#dockInput');
  const question = (input?.value || '').trim();
  const attachments = state.dock.attachments.map((a) => ({ title: a.title, source: a.source, text: a.text }));
  if (!question && !attachments.length) {
    toast('先拖入内容或输入问题', 'err');
    return;
  }
  if (!state.project?.id) return;
  if (keyRequired() && !state.apiKey) {
    openGate('需要 API Key 才能提问');
    return;
  }

  state.dock.sending = true;
  // 先把用户这条和一条空的 AI 气泡放进本地列表，做出「立刻有反应」的效果
  const local = arr(state.project.dockChat);
  local.push({ role: 'user', content: question, attachments, at: new Date().toISOString() });
  local.push({ role: 'assistant', content: '', streaming: true, at: new Date().toISOString() });
  state.project.dockChat = local;
  state.dock.attachments = [];
  if (input) input.value = '';
  renderDock();

  const bump = () => {
    const box = $('#dockMsgs .dock-msg:last-child .dock-bubble');
    if (box) {
      box.innerHTML = mdToHtml(stripAiMarks(local[local.length - 1].content));
      scrollDock();
    }
  };

  try {
    let acc = '';
    await postSSE(`/api/projects/${state.project.id}/ask`, { question, attachments }, (e) => {
      if (e.type === 'delta') {
        acc += e.text || '';
        local[local.length - 1].content = acc;
        bump();
      } else if (e.type === 'fatal') {
        if (e.needsKey) openGate(e.message);
        throw new Error(e.message || '回答失败');
      }
    });
    if (!local[local.length - 1].content) throw new Error('模型没有返回内容，请重试');
    delete local[local.length - 1].streaming;
    state.dock.sending = false;
    renderDock();
  } catch (err) {
    state.dock.sending = false;
    local.pop(); // 去掉那条空的 AI 气泡
    local.pop(); // 用户那条也退回输入框，避免内容丢了
    if (input) input.value = question;
    state.dock.attachments = attachments.map((a, i) => ({ ...a, key: 'retry' + i }));
    renderDock();
    toast(err.message, 'err');
  }
}

function wireDock() {
  const dock = $('#aiDock');
  if (!dock) return;
  fillDockIcons();

  $('#dockToggle')?.addEventListener('click', () => {
    state.dock.open = !state.dock.open;
    renderDock();
  });
  $('#dockClear')?.addEventListener('click', async () => {
    if (!arr(state.project?.dockChat).length) return;
    const ok = await confirmBox({ title: '清空 AI 咨询的对话？', body: '不影响「课件问答」里的记录，也不会动生成好的讲解内容。', okText: '清空' });
    if (!ok) return;
    try {
      await api(`/api/projects/${state.project.id}/ask`, { method: 'DELETE' });
      state.project.dockChat = [];
      renderDock();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  $('#dockSend')?.addEventListener('click', dockSend);

  const input = $('#dockInput');
  input?.addEventListener('input', () => {
    const s = $('#dockSend');
    if (s) s.disabled = state.dock.sending || (!state.dock.attachments.length && !input.value.trim());
  });
  input?.addEventListener('keydown', (e) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      dockSend();
    }
  });

  $('#dockCtx')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-ctxdel]');
    if (del) {
      removeAttachment(del.dataset.ctxdel);
      return;
    }
    if (e.target.closest('#ctxClear')) {
      state.dock.attachments = [];
      renderDock();
    }
  });

  // 投放：整个 dock 都是放置区，拖进来就加入
  const over = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dockHighlight(true);
  };
  ['dragenter', 'dragover'].forEach((t) => dock.addEventListener(t, over));
  dock.addEventListener('dragleave', (e) => {
    if (!dock.contains(e.relatedTarget)) dockHighlight(false);
  });
  dock.addEventListener('drop', (e) => {
    e.preventDefault();
    dockHighlight(false);
    const key = e.dataTransfer.getData('application/x-cw-block');
    if (key) {
      addAttachment(key);
      return;
    }
    // 从桌面直接拖文件进 dock 也支持
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  });
}

function fillDockIcons() {
  const t = $('#dockToggle');
  if (t) t.innerHTML = icon(state.dock.open ? 'right' : 'left', 13);
  const c = $('#dockClear');
  if (c) c.innerHTML = icon('trash', 13);
}

/** 拖拽监听只挂一次（挂在持久容器上，内部 innerHTML 被替换也不影响） */
function ensureDndWiring() {
  const body = $('#tabBody');
  if (body && !body.dataset.dndWired) {
    body.dataset.dndWired = '1';
    wireDndRoot(body);
  }
}

/** 能改的文件类别（服务端通过 /api/config 下发，静态版从共享的 roles.js 拿） */
function roleCatalog() {
  const fromCfg = arr(state.config?.roles);
  if (fromCfg.length) return fromCfg;
  // 兜底：拿不到就用内置的一份，保证面板永远能打开
  return [
    { role: 'courseware', label: '课件', desc: '讲义、PPT、教材章节。', feeds: '课件分析 · 事例讲解 · 学习规划 · 逐页讲解' },
    { role: 'lab', label: '实验指导', desc: '实验手册、Lab sheet。', feeds: '做 Lab · 结合课件讲解' },
    { role: 'exercise', label: '习题 / 作业', desc: 'Tutorial、Assignment、Past paper。', feeds: '做题 · 结合课件讲解' },
    { role: 'solution', label: '标准答案', desc: '老师发的答案册 / 题解。', feeds: '结合课件讲解（权威依据）' },
    { role: 'video', label: '上课录像', desc: '课堂录屏 / 录音。', feeds: '逐页讲解' },
    { role: 'other', label: '其他', desc: '参考资料、数据表、附件。', feeds: '课件分析时的背景材料' },
  ];
}

/**
 * 「这份材料算什么」的选择面板。
 *
 * 自动识别的结果不一定对（比如 `Week 3 Lab.pdf` 其实是课件），
 * 所以每个类别都写清楚它会喂给哪些模式，让用户能自己纠正。
 */
function openRolePicker(fileId) {
  const file = arr(state.project?.files).find((f) => f.id === fileId);
  if (!file) return;
  const cur = file.role || 'other';
  const manual = file.roleSource === 'manual';
  const auto = classifyHint(file.originalName, file.kind);

  const rows = roleCatalog()
    .map(
      (r) => `<button class="role-opt ${r.role === cur ? 'current' : ''}" data-pick="${esc(r.role)}">
        <span class="role-tag ${esc(r.role)}">${esc(r.label)}</span>
        <span class="role-opt-text">
          <b>${esc(r.desc)}</b>
          <i>会喂给：${esc(r.feeds || '—')}</i>
        </span>
        ${r.role === cur ? `<span class="role-opt-check">${icon('check', 13)}</span>` : ''}
      </button>`,
    )
    .join('');

  openModal(
    `<h3>这份材料算什么？</h3>
     <p class="role-file">${esc(file.originalName)}</p>
     <p style="color:var(--ink-2);font-size:13px;margin:0 0 14px">
       当前：<b>${esc(file.roleLabel || '其他')}</b>${manual ? '（你手动指定）' : `（按文件名自动判断${auto ? `，规则目测会给出「${esc(auto)}」` : ''}）`}。
       改完分类后，左边的模式排列会跟着变。
     </p>
     <div class="role-opts">${rows}</div>
     <div class="modal-actions">
       <button class="btn" data-close>取消</button>
       ${manual ? `<button class="btn" id="roleAuto">${icon('refresh', 13)}改回自动识别</button>` : ''}
     </div>`,
  );

  $$('#modalRoot [data-pick]').forEach((b) =>
    b.addEventListener('click', () => applyRole(file.id, b.dataset.pick)),
  );
  $('#roleAuto')?.addEventListener('click', () => applyRole(file.id, 'auto'));
}

/** 前端也按同样的规则猜一下，只用于面板里的说明文字（真正的判定在服务端） */
function classifyHint(name = '', kind = '') {
  const n = String(name).toLowerCase();
  if (kind === 'video' || kind === 'audio') return '上课录像';
  if (/(^|[^a-z])(solutions?|soln|answers?|ans|marking\s*scheme|rubric)([^a-z]|$)|答案|参考答案|解答/.test(n)) return '标准答案';
  if (/(^|[^a-z])(lab|labs|laboratory|practical|experiment)([^a-z]|$)|实验|上机/.test(n)) return '实验指导';
  if (/(^|[^a-z])(tut|tutorial|assignment|homework|hw|exercise|coursework|pset|quiz)([^a-z]|$)|习题|作业|练习/.test(n)) return '习题 / 作业';
  return '课件';
}

async function applyRole(fileId, role) {
  try {
    const r = await api(`/api/projects/${state.project.id}/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    if (r.project) state.project = r.project;
    closeModal();
    syncView();
    render();
    const label = role === 'auto' ? '按文件名自动识别' : roleCatalog().find((x) => x.role === role)?.label || role;
    toast(`已改成「${label}」`);
    // 分类变了，之前的分析结果就不再对应，提醒一下
    if (state.project?.analysisStale && state.project?.analysis) {
      toast('分类变了，建议重新生成一次讲解', 'warn');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

function render() {
  renderGroups();
  renderSidebar();
  renderTabs();
  renderBody();
  renderDock();
  ensureDndWiring();
}

/* ==================== 项目组：EIE3333 → Lecture 1 / Tut 1 / Lab 1 ==================== */

/** 拉一次「所有组 + 所有项目」，侧边栏一次渲染完 */
async function loadWorkspace() {
  try {
    const r = await api('/api/groups');
    state.groups = arr(r.groups);
    state.projects = arr(r.projects);
  } catch {
    // 静态版或接口不可用时退化成只有项目列表
    try {
      const { projects } = await api('/api/projects');
      state.groups = [];
      state.projects = arr(projects);
    } catch {
      state.groups = [];
      state.projects = [];
    }
  }
}

/** 现在这个项目属于哪个组 */
function currentGroupId() {
  return state.project?.groupId || '';
}

function renderGroups() {
  const el = $('#groupList');
  if (!el) return;
  const projects = state.projects;
  const byGroup = new Map();
  for (const p of projects) {
    const k = p.groupId || '';
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(p);
  }

  const projRow = (p) => {
    const active = p.id === state.project?.id;
    const marks = [];
    if (p.hasAnalysis) marks.push('<span class="pm ok" title="已生成讲解">已生成</span>');
    else if (p.fileCount) marks.push('<span class="pm">待分析</span>');
    if (p.roleCount?.lab) marks.push('<span class="pm lab" title="含实验指导">Lab</span>');
    if (p.roleCount?.solution) marks.push('<span class="pm sol" title="含标准答案">答案</span>');
    return `<div class="proj ${active ? 'active' : ''}" data-proj="${esc(p.id)}" title="${esc(p.name)}">
      <span class="proj-name">${esc(p.name)}</span>
      <span class="proj-marks">${marks.join('')}</span>
    </div>`;
  };

  const groupBlock = (g) => {
    const list = byGroup.get(g.id) || [];
    const open = !state.collapsedGroups.has(g.id);
    return `<div class="group" data-group="${esc(g.id)}">
      <div class="group-head ${open ? 'open' : ''}">
        <button class="group-toggle ${open ? 'open' : ''}" data-gact="toggle" data-id="${esc(g.id)}" title="${open ? '收起' : '展开'}">${icon('right', 12)}</button>
        <span class="group-name" data-gact="rename" data-id="${esc(g.id)}" title="点两下改名">${esc(g.name)}</span>
        <span class="group-count">${list.length}</span>
        <span class="spacer"></span>
        <button class="icon-btn" data-gact="export" data-id="${esc(g.id)}" title="把整个项目组导出成一个文件">${icon('package', 13)}</button>
        <button class="icon-btn" data-gact="add" data-id="${esc(g.id)}" title="在这个组里新建项目">${icon('plus', 13)}</button>
        <button class="icon-btn danger" data-gact="del" data-id="${esc(g.id)}" title="删除分组（里面的项目会退回未分组，不会被删）">${icon('x', 13)}</button>
      </div>
      ${open ? `<div class="group-projects">${list.length ? list.map(projRow).join('') : '<div class="proj-empty">这个组还没有项目</div>'}</div>` : ''}
    </div>`;
  };

  const ungrouped = byGroup.get('') || [];
  el.innerHTML =
    state.groups.map(groupBlock).join('') +
    (ungrouped.length || !state.groups.length
      ? `<div class="group" data-group="">
          <div class="group-head open">
            <span class="group-toggle" style="visibility:hidden"></span>
            <span class="group-name" style="cursor:default">未分组</span>
            <span class="group-count">${ungrouped.length}</span>
          </div>
          <div class="group-projects">${ungrouped.length ? ungrouped.map(projRow).join('') : '<div class="proj-empty">还没有项目</div>'}</div>
        </div>`
      : '');
}

/** 切到另一个项目：它自己保存的文件 / 分析 / 做题记录 / Lab 进度 / 对话都会一起回来 */
async function switchProject(id) {
  if (!id || id === state.project?.id) return;
  try {
    state.project = await api(`/api/projects/${id}`);
    lsSet(LS.lastProject, id);
    state.tab = 'overview';
    state.presenter.index = 0;
    dockReset();
    syncView();
    render();
    const p = state.projects.find((x) => x.id === id);
    toast(`已切到「${p?.name || '项目'}」`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** 「新建」按钮：有分组时问一下建到哪个组 */
async function newProjectUI(forceGroupId) {
  let groupId = forceGroupId;
  if (groupId === undefined) {
    // 当前项目在某个组里 → 默认建到同一个组，符合「在这个组里继续加 lecture/tut/lab」的习惯
    groupId = currentGroupId();
  }
  try {
    const name = await promptText({
      title: '新建项目',
      label: '项目名称',
      placeholder: '例如 Lecture 1 / Tut 1 / Lab 1',
      value: '',
      hint: groupId ? `会放进「${groupName(groupId)}」` : '会放在「未分组」里',
    });
    if (name === null) return null;
    const p = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() || '未命名课件', groupId }),
    });
    await loadWorkspace();
    state.project = p;
    state.tab = 'overview';
    dockReset();
    syncView();
    render();
    toast(`已新建「${p.name}」`);
    return p;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

function groupName(id) {
  return state.groups.find((g) => g.id === id)?.name || '未分组';
}

async function newGroupUI() {
  try {
    const name = await promptText({
      title: '新建项目组',
      label: '组名',
      placeholder: '例如 EIE3333',
      hint: '一个组里可以放 Lecture 1 / Tut 1 / Lab 1 等多个项目',
    });
    if (name === null || !name.trim()) return;
    const { group } = await api('/api/groups', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    state.collapsedGroups.delete(group.id);
    await loadWorkspace();
    renderGroups();
    toast(`已新建项目组「${group.name}」，点组右边的 ＋ 往里面加项目`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function renameGroupUI(id) {
  const cur = groupName(id);
  const name = await promptText({ title: '重命名项目组', label: '组名', value: cur });
  if (name === null || !name.trim() || name.trim() === cur) return;
  try {
    await api(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
    await loadWorkspace();
    renderGroups();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteGroupUI(id) {
  const n = state.projects.filter((p) => p.groupId === id).length;
  const ok = await confirmBox({
    title: `删除项目组「${groupName(id)}」？`,
    body: n
      ? `组里的 <b>${n} 个项目不会被删除</b>，只会退回「未分组」，生成好的内容都还在。`
      : '这个组里还没有项目。',
    okText: '删除分组',
  });
  if (!ok) return;
  try {
    await api(`/api/groups/${id}`, { method: 'DELETE' });
    await loadWorkspace();
    renderGroups();
    toast('分组已删除，项目都还在');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function wireGroups() {
  const el = $('#groupList');
  if (!el) return;
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-gact]');
    if (act) {
      const id = act.dataset.id;
      if (act.dataset.gact === 'toggle') {
        state.collapsedGroups.has(id) ? state.collapsedGroups.delete(id) : state.collapsedGroups.add(id);
        renderGroups();
      } else if (act.dataset.gact === 'export') exportGroup(id);
      else if (act.dataset.gact === 'add') newProjectUI(id);
      else if (act.dataset.gact === 'rename') renameGroupUI(id);
      else if (act.dataset.gact === 'del') deleteGroupUI(id);
      return;
    }
    const proj = e.target.closest('[data-proj]');
    if (proj) switchProject(proj.dataset.proj);
  });
  // 双击组名改名
  el.addEventListener('dblclick', (e) => {
    const name = e.target.closest('.group-name[data-gact]');
    if (name) renameGroupUI(name.dataset.id);
  });
}

function renderSidebar() {
  const files = state.project?.files || [];
  const mine = state.project?.isMine !== false;
  $('#analyzeBtn').disabled = !files.length || state.view === 'analyzing' || !mine;
  $('#analyzeBtn').innerHTML = !mine
    ? icon('lock', 14) + '演示项目只读'
    : state.view === 'analyzing'
      ? SPIN_SVG + '正在分析…'
      : state.view === 'done'
        ? icon('refresh', 14) + '重新生成讲解'
        : icon('play', 14) + '开始讲解分析';
  $('#exportBtn').innerHTML = icon('download', 14) + '导出讲解方案 (.md)';
  $('#exportBtn').disabled = !state.project?.analysis;
  const packBtn = $('#packBtn');
  if (packBtn) {
    packBtn.innerHTML = icon('package', 13) + '导出项目';
    packBtn.disabled = !state.project?.id;
  }
  const unpackBtn = $('#unpackBtn');
  if (unpackBtn) unpackBtn.innerHTML = icon('upload', 13) + '导入';
  const installBtn = $('#installBtn');
  if (installBtn && !installBtn.innerHTML) installBtn.innerHTML = icon('download', 15);
  $('#dropzone').style.display = mine ? '' : 'none';
  $('#newProjectBtn').title = mine ? '新建一个课件项目' : '回到自己的项目空间';

  $('#fileList').innerHTML = files.length
    ? files
        .map((f) => {
          const ext = (f.originalName.split('.').pop() || '?').toLowerCase();
          const bits = [f.kind];
          if (f.meta?.pages) bits.push(`${f.meta.pages} 页`);
          if (f.meta?.slides) bits.push(`${f.meta.slides} 页幻灯片`);
          if (f.meta?.withNotes) bits.push(`${f.meta.withNotes} 页备注`);
          if (f.chars) bits.push(`${f.chars.toLocaleString()} 字`);
          const role = f.role || 'other';
          const manual = f.roleSource === 'manual';
          return `
        <div class="file-card" data-id="${f.id}">
          <span class="ext ${esc(ext)}">${esc(ext.slice(0, 4).toUpperCase())}</span>
          <div>
            <div class="fname">${esc(f.originalName)}</div>
            <div class="fmeta"><button class="role-tag ${esc(role)} ${mine ? 'pickable' : ''}" data-role="${esc(f.id)}"
              title="${mine ? '点一下自己改类别' : ''}">${esc(f.roleLabel || '其他')}${mine ? icon('down', 9) : ''}</button>${manual ? `<span class="manual-dot" title="你手动指定过，不会跟着文件名变">手动</span>` : ''} ${esc(bits.join(' · '))}</div>
            ${f.previewNote ? `<div class="fmeta" style="color:var(--warn)">${esc(f.previewNote)}</div>` : ''}
          </div>
          <div class="ftools">
            <button class="icon-btn" data-act="view" data-id="${f.id}" title="查看提取到的文字">${icon('eye', 14)}</button>
            <button class="icon-btn danger" data-act="del" data-id="${f.id}" title="移除">${icon('x', 14)}</button>
          </div>
        </div>`;
        })
        .join('')
    : `<p style="font-size:12.5px;color:var(--text-3);text-align:center;margin:18px 0 0">还没有文件</p>`;
}

/**
 * 这个模式现在有没有内容。
 * 用它来把模式条分成两拨：已经生成好的排左边、颜色深；还没生成的排右边、颜色浅。
 * 「课件问答」随时能用，算有内容；「结合课件讲解」要看有没有讲过题。
 */
function tabHasContent(id) {
  if (id === 'chat') return true;
  if (id === 'combine') return Object.keys(state.project?.explain || {}).length > 0;
  const key = id === 'overview' ? 'analysis' : id;
  const v = state.project?.analysis?.[key];
  return Boolean(v && !v.skipped);
}

function renderTabs() {
  const enabled = state.view === 'done';
  // 稳定排序：有内容的在前，同组内保持 TABS 原本的顺序
  const ordered = TABS.map((t, i) => ({ t, i, ready: tabHasContent(t.id) })).sort(
    (a, b) => Number(b.ready) - Number(a.ready) || a.i - b.i,
  );
  $('#tabs').innerHTML = ordered
    .map(
      ({ t, ready }) =>
        `<button class="tab ${state.tab === t.id ? 'active' : ''} ${ready ? 'ready' : 'blank'}" data-tab="${t.id}" ${
          enabled ? '' : 'disabled'
        }>${t.label}</button>`,
    )
    .join('');
  const stale = state.project?.analysisStale && state.project?.analysis;
  $('#tabs').insertAdjacentHTML(
    'beforeend',
    `<div class="spacer"></div>${stale ? `<span class="chip warn">${icon(alert, 12)}文件已变动，建议重新生成</span>` : ''}`,
  );
}

/**
 * 渲染当前标签页。
 *
 * 中英对照模式下，同一个渲染函数用两份数据各跑一次：先中文，分隔线，再英文。
 * 复用同一套渲染器，所以对照版的结构、截图、样式跟单语版完全一致，
 * 不会出现「中文版是新的、英文版是旧的」这种两套代码各自漂移的问题。
 */
function renderStageWithAlt(a) {
  const alt = a.analysisEn || null;
  const both = Boolean(alt) && state.biView !== 'zh' && state.biView !== 'en';

  // 只想看单一语言时，直接按对应那份数据渲染
  if (alt && state.biView === 'en') return renderStageOne(alt);
  const zh = renderStageOne(a);
  if (!both) return zh;

  const en = renderStageOne(alt);
  // 英文那半边如果没有内容（这一阶段没勾选），就不要画一条空分隔线
  if (!en.trim()) return zh;
  return `${zh}
    <div class="bi-split"><span>English</span></div>
    <div class="bi-alt">${en}</div>`;
}

/**
 * 用给定的一份数据渲染当前标签页。
 *
 * 这里临时把 state.project.analysis 换成要渲染的那一份 —— 因为 quizInner / labInner /
 * renderCombine 这些内部函数是直接读全局 state 的，与其把数据参数一路穿进六个渲染器和
 * 它们的子函数（改动面大、以后容易漏），不如在这儿换一次、渲染完换回来。
 * 只在一帧内同步发生，不会漏给别的代码看到。
 */
function renderStageOne(data) {
  const saved = state.project?.analysis;
  if (!state.project || !data || data === saved) return renderStageCurrent();
  state.project.analysis = { ...saved, ...data };
  try {
    return renderStageCurrent();
  } finally {
    state.project.analysis = saved;
  }
}

function renderStageCurrent() {
  if (state.tab === 'overview') return renderOverview(state.project.analysis?.analysis);
  if (state.tab === 'examples') return renderExamples(state.project.analysis?.examples);
  if (state.tab === 'guide') return renderGuide(state.project.analysis?.guide, state.project.analysis?.analysis);
  if (state.tab === 'combine') return renderCombine();
  if (state.tab === 'narration') return renderNarration(state.project.analysis?.narration);
  if (state.tab === 'summary') return renderSummary(state.project.analysis?.summary);
  if (state.tab === 'mindmap') return renderMindmap(state.project.analysis?.mindmap);
  if (state.tab === 'quiz') return renderQuiz(state.project.analysis?.quiz);
  if (state.tab === 'lab') return renderLab(state.project.analysis?.lab);
  return '';
}

/**
 * 英文那一半是「拿来对照着看的」，不该再有一套能操作的控件 ——
 * 去掉 id 避免和中文那半撞车，控件全部禁用，按钮直接藏掉。
 */
function wireAltBlock() {
  const alt = $('#tabBody .bi-alt');
  if (!alt) return;
  alt.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  alt.querySelectorAll('input, textarea, select').forEach((el) => {
    el.disabled = true;
  });
  alt.querySelectorAll('button').forEach((el) => {
    el.style.display = 'none';
  });
}

function renderBody() {
  // 正文要被整体替换，上一轮登记的拖拽 key 全部作废
  dndStore.clear();
  const body = $('#tabBody');
  if (state.view === 'empty') {
    body.innerHTML = `
      <div class="empty">
        <div class="big">${icon('book', 46)}</div>
        <h2>把课件交给我，我陪你把这门课学会</h2>
        <p>支持 PDF、PPTX、DOCX、TXT、Markdown、CSV、XLSX 等格式，可一次上传多个文件。</p>
        <ol>
          <li>把课件文件拖进左侧上传区</li>
          <li>点击「开始讲解分析」</li>
          <li>得到 <b>课件分析</b>、<b>事例讲解</b>、<b>学习规划</b>、<b>逐页讲解</b>、<b>总结分析</b>、<b>练习题</b>、<b>实验（Lab）</b></li>
          <li>用「全屏讲解模式」边看页面边听讲解；可以在「做题」「做 lab」里直接作答并得到批改</li>
          <li>导出 Markdown 存成自己的笔记</li>
        </ol>
      </div>`;
    return;
  }
  if (state.view === 'ready') {
    body.innerHTML = `
      <div class="empty">
        <div class="big">${icon('checkCircle', 46)}</div>
        <h2>已就绪：${state.project.files.length} 个文件</h2>
        <p>共提取到 ${state.project.files.reduce((n, f) => n + (f.chars || 0), 0).toLocaleString()} 字内容。</p>
        <p>点击左下角 <b>「开始讲解分析」</b>，我会读完整份课件，产出内容分析、事例讲解、学习规划和逐页讲解稿。</p>
      </div>`;
    return;
  }
  if (state.view === 'analyzing') {
    renderProgress();
    return;
  }
  const a = state.project.analysis || {};
  const errs = arr(a.errors);
  const banner = errs.length
    ? `<div class="note-box" style="margin-bottom:16px"><b>${icon('alert', 12)}有 ${errs.length} 个环节没成功</b><br>${errs
        .map((e) => `${esc(e.label)}：${esc(e.message)}`)
        .join('<br>')}</div>`
    : '';
  let inner = '';
  // 课件问答自己往 #tabBody 里写，必须在这里就返回，否则会被下面的 panel 覆盖掉
  if (state.tab === 'chat') {
    renderChat();
    return;
  }
  // 中英对照：中文段落渲染完，中间加一条分隔，再把英文那一遍原样渲染一次
  inner = renderStageWithAlt(a);
  const stageMap = {
    overview: 'analysis',
    examples: 'examples',
    guide: 'guide',
    narration: 'narration',
    summary: 'summary',
    combine: 'quiz',
    quiz: 'quiz',
    lab: 'lab',
  };
  const mine = state.project.isMine !== false;
  const stage = stageMap[state.tab];

  // 这一节这次没勾选 → 说清楚，并给一个「只生成这一节」的按钮，
  // 而不是把 { skipped:true } 丢给下面的渲染函数画出个空壳
  const skippedStage = stage && a[stage]?.skipped ? a[stage] : null;
  if (skippedStage) {
    inner = `<div class="card skipped-card">
      <div class="skipped-icon">${icon('layers', 28)}</div>
      <h3>这一节这次没有生成</h3>
      <p>上一步生成时你没有勾选「<b>${esc(stageLabelOf(stage))}</b>」。</p>
      ${skippedStage.reason ? `<p class="skipped-note">${esc(skippedStage.reason)}</p>` : ''}
      ${
        mine
          ? `<button class="btn primary" id="genThisStage" data-stage="${esc(stage)}">${icon('play', 13)}只生成这一节</button>`
          : ''
      }
    </div>`;
  }

  const rerunBar =
    stage && mine && !skippedStage
      ? `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
         <button class="btn sm" id="rerunBtn" data-stage="${stage}">${icon('refresh', 14)}重新生成本节</button>
       </div>`
      : '';
  const staleBar = state.project.analysisStale
    ? `<div class="note-box" style="margin-bottom:12px">${icon('alert', 12)}课件文件在上次分析后有过变动，建议重新生成。</div>`
    : '';

  // 中英对照生成的项目：给一个切换「对照 / 只看中文 / 只看英文」的小条，
  // 不然每一页都被拉成两倍长，想专注看一种语言时很难受
  const biBar = a.analysisEn
    ? `<div class="bi-bar">
        <span class="bi-bar-lbl">${icon('layers', 12)}中英对照</span>
        ${[
          ['both', '上下对照'],
          ['zh', '只看中文'],
          ['en', '只看 English'],
        ]
          .map(
            ([k, label]) =>
              `<button class="btn sm ${(state.biView || 'both') === k ? 'primary' : 'ghost'}" data-biview="${k}">${label}</button>`,
          )
          .join('')}
      </div>`
    : '';
  const demoBar = mine
    ? ''
    : `<div class="demo-bar">
         <span>${icon('users', 14)} 你正在浏览<b>公开演示项目</b>（只读）。里面的内容是用别人的课件生成的，可以直接体验讲解模式、做题和做 Lab。</span>
         <button class="btn sm primary" id="demoOwn">建立我自己的项目 →</button>
       </div>`;
  body.innerHTML = `<div class="panel">${demoBar}${banner}${staleBar}${rerunBar}${biBar}${inner}</div>`;
  wireAltBlock();

  // 被跳过的节只挂一个「只生成这一节」按钮，别的交互都没东西可挂
  const genBtn = $('#genThisStage');
  if (genBtn) {
    genBtn.addEventListener('click', () => rerunStageUI(genBtn.dataset.stage, genBtn));
    $('#demoOwn')?.addEventListener('click', () => switchToOwnProject(true));
    return;
  }

  if (state.tab === 'narration') wireNarration();
  else if (state.tab === 'mindmap') wireMindmapTools();
  else if (state.tab === 'combine') wireCombine();
  else if (state.tab === 'quiz') wireQuiz();
  else if (state.tab === 'lab') wireLab();
  const rb = $('#rerunBtn');
  if (rb) rb.addEventListener('click', () => rerunStageUI(rb.dataset.stage, rb));
  $$('[data-biview]').forEach((b) =>
    b.addEventListener('click', () => {
      state.biView = b.dataset.biview;
      render();
    }),
  );
  $('#demoOwn')?.addEventListener('click', () => switchToOwnProject(true));
}

/** 只重跑当前这一节 */
async function rerunStageUI(stage, btn) {
  if (stage === 'lab' && !state.project?.shape?.hasLab) {
    const ok = confirm(
      '注意：这个项目里没有检测到实验指导文件（文件名通常含 lab）。\n\n' +
        '接下来生成的 Lab 会是基于课件内容「补充设计」的，可能和你的实际实验器材、步骤不适配。\n\n' +
        '要继续吗？',
    );
    if (!ok) return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = SPIN_SVG + '重新生成中…';
  try {
    const res = await api(`/api/projects/${state.project.id}/rerun`, {
      method: 'POST',
      body: JSON.stringify({ stage, readPagesMode: readModeOfClient() }),
    });
    state.project.analysis = state.project.analysis || {};
    state.project.analysis[stage] = res.data;
    toast('已重新生成', 'ok');
    render();
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* --------------------------- 进度视图 --------------------------- */

function renderProgress() {
  const pct = Math.round((state.progress || 0) * 100);
  $('#tabBody').innerHTML = `
    <div class="progress-wrap">
      <h2 style="margin:0 0 6px;font-size:19px">正在读你的课件…${state.passLabel ? `<span class="pass-tag">${esc(state.passLabel)}</span>` : ''}</h2>
      <p style="color:var(--text-2);margin:0 0 4px">模型正在逐段分析内容、挑出事例、设计教学用法并撰写讲解稿，通常需要 1–3 分钟。</p>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div style="text-align:right;font-size:12px;color:var(--text-3);margin-top:6px">${pct}%</div>
      <div class="stage-list">
        ${state.stages
          .map((s) => {
            const cls =
              s.status === 'start'
                ? 'active'
                : s.status === 'done'
                  ? 'done'
                  : s.status === 'error'
                    ? 'error'
                    : s.status === 'skipped'
                      ? 'skipped'
                      : '';
            const mark =
              s.status === 'start'
                ? '<span class="spin"></span>'
                : s.status === 'done'
                  ? icon('check', 13)
                  : s.status === 'error'
                    ? '!'
                    : s.status === 'skipped'
                      ? '—'
                      : '·';
            const sub = s.detail || (s.status === 'error' || s.status === 'skipped' ? s.message : '');
            return `<div class="stage-row ${cls}">
              <span class="mark">${mark}</span>
              <div><div class="lbl">${esc(s.label)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
              <span class="time">${s.ms ? `${(s.ms / 1000).toFixed(1)}s` : ''}</span>
            </div>`;
          })
          .join('')}
      </div>
    </div>`;
}

/* ---------------------- 分析前先问清楚要生成什么 ---------------------- */

/** 可选的模式清单（服务端通过 shape.stages 下发，拿不到就用内置兜底） */
function stageCatalog() {
  const fromShape = arr(state.project?.shape?.stages);
  if (fromShape.length) return fromShape;
  return [
    { key: 'analysis', label: '课件分析', desc: '通读材料，讲清结构、重点难点，列出核心概念。' },
    { key: 'examples', label: '事例讲解', desc: '把例题、案例拆成题目 → 分步 → 通用方法 → 易错点。' },
    { key: 'guide', label: '学习规划', desc: '给学习者一份学习规划：先学什么、每部分花多久、怎么自测。' },
    { key: 'narration', label: '逐页讲解稿', desc: '每一页写一段可以照着念的讲稿。' },
    { key: 'summary', label: '总结分析', desc: '抛开课件结构，把知识点重新梳理一遍。' },
    { key: 'mindmap', label: '思维导图', desc: '画成一张思维导图：节点短、靠连线表达逻辑关系。' },
    { key: 'quiz', label: '练习题', desc: '整理出可以做的题，附答案与解析。' },
    { key: 'lab', label: '做 Lab', desc: '把实验整理成可以照着做的分步实验。' },
  ];
}

function stageLabelOf(key) {
  return stageCatalog().find((s) => s.key === key)?.label || key;
}

/** 读图模式的显示名（口径和后端 page-select.mjs 的 READ_MODE_LABEL 一致） */
function readModeLabelOf(key) {
  return { auto: '自动', all: '全部读图', text: '纯文字' }[key] || key;
}

/** 用户选的读图模式；没选过就是 auto（只读图表页） */
function readModeOfClient() {
  return ['auto', 'all', 'text'].includes(state.readPagesMode) ? state.readPagesMode : 'auto';
}

/** 当前项目是用什么语言生成的：zh / en / bilingual */
function langModeOf() {
  const a = state.project?.analysis;
  if (!a) return currentLang() === 'en' ? 'en' : 'zh';
  if (a.analysisEn) return 'bilingual';
  return a.lang === 'en' ? 'en' : 'zh';
}

/** 这次该默认勾哪些：第一次跑用推荐，重跑用上次实际生成成功的 */
function defaultStageSelection() {
  const an = state.project?.analysis;
  if (an) {
    const done = stageCatalog()
      .map((s) => s.key)
      .filter((k) => {
        const v = an[k];
        // 上次就是跳过的，这次不默认勾上
        return v && !v.skipped;
      });
    if (done.length) return done;
  }
  const rec = arr(state.project?.shape?.recommended?.picked);
  return rec.length ? rec : stageCatalog().map((s) => s.key);
}

/**
 * 「生成讲解内容」弹窗。
 * 上面是「为您推荐」（按项目里有哪些类别的材料推出来），下面是让用户自己勾。
 */
function openAnalyzeModal() {
  if (!state.project?.files?.length) return;
  if (!state.project.isMine) {
    toast('这是公开的演示项目，只能查看。请点左侧「新建」建立自己的项目。', 'err');
    return;
  }
  if (!hasUsableKey()) {
    openGate('分析课件需要 API Key');
    return;
  }

  const rec = state.project?.shape?.recommended || {};
  const picked = new Set(defaultStageSelection());
  const hasVideo = arr(state.project?.shape?.video).length > 0;
  const reRun = Boolean(state.project?.analysis);

  // 生成语言：中文 / English / 中英对照
  const curLangMode = langModeOf();
  const langPicker = `<div class="pick-head"><span>用什么语言生成</span></div>
    <div class="lang-opts">
      ${[
        ['zh', '中文', '只生成中文内容'],
        ['en', 'English', 'Generate everything in English only'],
        ['bilingual', '中英对照', '生成两遍：上面中文段落，下面英文段落（耗时和额度约翻倍）'],
      ]
        .map(
          ([k, label, hint]) => `<label class="lang-opt ${k === 'bilingual' ? 'bi' : ''}">
            <input type="radio" name="genLang" value="${k}" ${k === curLangMode ? 'checked' : ''}>
            <span class="lang-opt-body"><b>${esc(label)}</b><i>${esc(hint)}</i></span>
          </label>`,
        )
        .join('')}
    </div>`;

  // 读页面截图。默认 auto：先看每页的图片覆盖面积和矢量绘制量，
  // 只把「图片 / 表格 / 框图多」的页面做成截图发给视觉模型，纯文字页只送文字。
  const readMode = readModeOfClient();
  const docPages = arr(state.project?.files).reduce((n, f) => n + (Number(f?.meta?.pages) || 0), 0);
  // 页数一多，「全部读图」的代价就很可观了，这时候才把选择摆到用户面前
  const bigDoc = docPages >= 30;
  const readModeHint = {
    auto: '只把图片、表格、框图多的页面做成截图发给视觉模型；纯文字页只读文字。页数多的时候这是最划算的。',
    all: '每一页都渲染成截图发给视觉模型，图表和排版一定读得到，但页数多时 token 明显更贵。',
    text: '一页都不读图，只把提取出来的文字发给模型，最省；代价是图表、框图，以及被挤成一团的表格会读不到。',
  };
  const pagesPicker = `<div class="pick-head">
      <span>怎么读这份课件</span>
      ${bigDoc ? `<span class="pick-badge">${docPages} 页，建议用自动</span>` : ''}
    </div>
    <div id="readCostNote" class="read-cost"></div>
    <div class="read-modes">
      ${['auto', 'all', 'text']
        .map(
          (k) => `<label class="read-opt ${k === readMode ? 'on' : ''} ${k === 'auto' ? 'recommended' : ''}">
        <input type="radio" name="readMode" value="${k}" ${k === readMode ? 'checked' : ''}>
        <span class="read-opt-body">
          <b>${esc(readModeLabelOf(k))}${k === 'auto' ? '<span class="pick-tag">推荐</span>' : ''}</b>
          <i>${esc(readModeHint[k])}</i>
        </span>
      </label>`,
        )
        .join('')}
    </div>`;

  const rows = stageCatalog()
    .map((s) => {
      // 有上课录像时，逐页讲解稿是转写出来的，不在这里生成
      const blocked = s.key === 'narration' && hasVideo;
      const on = picked.has(s.key) && !blocked;
      return `<label class="stage-opt ${blocked ? 'blocked' : ''}">
        <input type="checkbox" data-stage="${esc(s.key)}" ${on ? 'checked' : ''} ${blocked ? 'disabled' : ''}>
        <span class="stage-opt-body">
          <b>${esc(s.label)}</b>
          <i>${esc(s.desc)}</i>
          ${blocked ? '<i class="stage-note">已上传上课录像，这一项会用录像转写生成，不用在这里勾</i>' : ''}
        </span>
      </label>`;
    })
    .join('');

  openModal(
    `<h3>${reRun ? '重新生成讲解' : '生成讲解内容'}</h3>

     ${
       arr(rec.why).length
         ? `<div class="rec-box">
              <div class="rec-head">${icon('wand', 13)}为您推荐</div>
              <ul class="rec-why">${rec.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
              <div class="rec-picked">推荐勾选：<b>${
                arr(rec.picked).map((k) => esc(stageLabelOf(k))).join(' · ') || '（无）'
              }</b></div>
            </div>`
         : ''
     }

     ${langPicker}

     ${pagesPicker}

     <div class="stage-pick-head">
       <span>自己挑要生成哪些</span>
       <span class="spacer"></span>
       <button class="btn sm ghost" id="stageRec">按推荐</button>
       <button class="btn sm ghost" id="stageAll">全选</button>
       <button class="btn sm ghost" id="stageNone">全不选</button>
     </div>
     <div class="stage-opts">${rows}</div>
     <p class="stage-hint">勾得越少越快、越省额度。这次没勾的，之后可以在对应页面点「重新生成本节」单独补。</p>

     <div class="modal-actions">
       <button class="btn" data-close>取消</button>
       <button class="btn primary" id="stageGo">开始生成</button>
     </div>`,
  );

  const selected = () =>
    $$('#modalRoot [data-stage]')
      .filter((c) => c.checked && !c.disabled)
      .map((c) => c.dataset.stage);

  const syncGo = (mode) => {
    const n = selected().length;
    const go = $('#stageGo');
    if (!go) return;
    const m = mode || $$('#modalRoot [name="genLang"]').find((x) => x.checked)?.value || 'zh';
    go.disabled = n === 0;
    if (!n) {
      go.innerHTML = '至少勾一项';
      return;
    }
    const passes = m === 'bilingual' ? ' · 中英各一遍' : '';
    go.innerHTML = `${icon('play', 13)}开始生成（${n} 项${passes}）`;
  };

  $$('#modalRoot [data-stage]').forEach((c) => c.addEventListener('change', syncGo));
  $('#stageAll')?.addEventListener('click', () => {
    $$('#modalRoot [data-stage]').forEach((c) => {
      if (!c.disabled) c.checked = true;
    });
    syncGo();
  });
  $('#stageNone')?.addEventListener('click', () => {
    $$('#modalRoot [data-stage]').forEach((c) => (c.checked = false));
    syncGo();
  });
  $('#stageRec')?.addEventListener('click', () => {
    const want = new Set(arr(rec.picked));
    $$('#modalRoot [data-stage]').forEach((c) => (c.checked = want.has(c.dataset.stage) && !c.disabled));
    syncGo();
  });
  $('#stageGo')?.addEventListener('click', () => {
    const keys = selected();
    if (!keys.length) return;
    const pick = $$('#modalRoot [name="genLang"]').find((r) => r.checked);
    const mode = pick?.value || 'zh';
    state.readPagesMode = $$('#modalRoot [name="readMode"]').find((r) => r.checked)?.value || 'auto';
    closeModal();
    runAnalysis(keys, mode);
  });
  // 选读图方式时把高亮跟着挪过去
  $$('#modalRoot [name="readMode"]').forEach((r) =>
    r.addEventListener('change', () => {
      $$('#modalRoot .read-opt').forEach((l) => l.classList.toggle('on', l.querySelector('input')?.checked));
    }),
  );

  // 页数多的时候，先把「自动模式会读几页」算出来摆给用户看，再让他决定。
  // 算不出来（没装 Chrome、静态版没这接口）就退回一句说明，不影响生成。
  (async () => {
    const plain = () =>
      `<span class="muted">共 ${docPages} 页。自动模式会先判断每一页的图片 / 表格情况，只把该读图的页发出去。</span>`;
    let box = $('#readCostNote');
    if (!box) return;
    if (!bigDoc) {
      box.innerHTML = plain();
      return;
    }
    box.innerHTML = '<span class="muted">正在统计每一页的图片 / 表格情况…</span>';
    try {
      const s = await api(`/api/projects/${state.project.id}/page-stats`);
      box = $('#readCostNote');
      if (!box) return;

      // 扫描件要单独说清楚：它走的是「先批量识字、之后都读文字」这条路，
      // 和「读几页图」完全是两回事
      const scanned = arr(s?.scanned);
      const todo = scanned.filter((x) => !x.ocrDone);
      if (todo.length) {
        const n = todo.reduce((a, x) => a + (x.pages || 0), 0);
        box.innerHTML =
          `${icon('alert', 12)} 有 <b>${todo.length}</b> 份材料是扫描件（没有文字层）：` +
          `<b>${todo.map((x) => esc(x.name)).join('、')}</b>，共约 <b>${n}</b> 页。` +
          `生成时会先用视觉模型把这些页的文字<b>批量识别</b>出来（一次跑完，只做一次并缓存），` +
          `之后分析 / 事例 / 规划 / 总结 / 题 / Lab 全部读文字，不再反复发图片。` +
          `已经识别过的扫描件会直接复用缓存，不重复花钱。`;
        return;
      }
      if (!s?.available || !s.total) {
        box.innerHTML = plain();
        return;
      }
      const rest = Math.max(0, s.total - s.auto);
      const k = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
      const cap = Number(s.maxImages) || 0;
      // 需要读图的页数超过「单次请求装得下」的量时，别再说「选全部读图就能全读到」——
      // 那是做不到的，得如实说明会自动均匀取样。
      if (cap && s.auto > cap) {
        box.innerHTML =
          `${icon('alert', 12)} 这份材料共 <b>${s.total}</b> 页，其中 <b>${s.auto}</b> 页需要读图。` +
          `一次性发给模型装不下这么多图，会自动按整份材料<b>均匀取样</b>（最多 ${cap} 页，图大的话更少），` +
          `其余页面按文字读。想让模型读到更多页，可以把这份材料拆成几份分别上传。`;
        return;
      }
      box.innerHTML =
        `${icon('alert', 12)} 这份材料共 <b>${s.total}</b> 页。自动模式预计只读 <b>${s.auto}</b> 页的图，` +
        `其余 <b>${rest}</b> 页按文字读。` +
        (rest
          ? `选「全部读图」会多读这 ${rest} 页，大约多花 ${k(rest * 400)}–${k(rest * 1300)} tokens。`
          : '这份材料几乎每页都有图或表格，三种读法差别不大。');
    } catch {
      box = $('#readCostNote');
      if (box) box.innerHTML = plain();
    }
  })();
  $$('#modalRoot [name="genLang"]').forEach((r) =>
    r.addEventListener('change', () => {
      // 对照模式会让生成时间和额度翻倍，勾选后按钮上直接说明
      const m = $$('#modalRoot [name="genLang"]').find((x) => x.checked)?.value;
      syncGo(m);
    }),
  );
  syncGo();
}

/* --------------------------- 1. 课件分析 --------------------------- */

function renderOverview(an) {
  if (!an) return `<div class="note-box">课件分析没有生成成功，可以点「重新生成讲解」再试一次。</div>`;
  const hero = `
    <div class="hero">
      <h1>${esc(an.title || state.project.name)}</h1>
      <p>${esc(an.summary || '')}</p>
      <div class="facts">
        ${an.subject ? `<span class="fact">学科：${esc(an.subject)}</span>` : ''}
        ${an.audience ? `<span class="fact">对象：${esc(an.audience)}</span>` : ''}
        ${an.difficulty ? `<span class="fact">难度：${esc(an.difficulty)}</span>` : ''}
        ${an.durationMinutes ? `<span class="fact">建议课时：${esc(an.durationMinutes)} 分钟</span>` : ''}
        <span class="fact">文件：${state.project.files.length} 个</span>
      </div>
    </div>`;

  const objectives = `
    <div class="card">
      <h3><span class="num">1</span>教学目标</h3>
      ${listHtml(an.objectives)}
    </div>`;

  const prereq = arr(an.prerequisites).length
    ? `<div class="card"><h3><span class="num">2</span>前置知识</h3>${listHtml(an.prerequisites)}</div>`
    : '';

  const structure = arr(an.structure).length
    ? `<div class="card">
        <h3><span class="num">3</span>内容结构</h3>
        <div class="tree">
          ${an.structure
            .map(
              (s) => `<div class="tree-item">
              <h4>${esc(s.section)}
                ${s.location ? `<span class="loc">${esc(s.location)}</span>` : ''}
                ${s.minutes ? `<span class="mins">约 ${esc(s.minutes)} 分钟</span>` : ''}
              </h4>
              ${arr(s.points).length ? `<ul>${arr(s.points).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
            </div>`,
            )
            .join('')}
        </div>
      </div>`
    : '';

  const concepts = arr(an.concepts).length
    ? `<div class="card">
        <h3><span class="num">4</span>核心概念</h3>
        ${an.concepts
          .map((c) => {
            // 每个概念可拖进右侧 AI 咨询追问
            const d = dnd({
              title: `概念：${String(c.term || '').slice(0, 50)}`,
              source: '课件分析 · 核心概念',
              text: `${c.term || ''}：${c.definition || ''}${c.why ? `\n难点：${c.why}` : ''}`,
            });
            return `<div class="concept" ${d.attrs}>
            <b>${esc(c.term)}</b>
            <p>${esc(c.definition)}</p>
            ${c.why ? `<div class="why">${icon('alert', 12)} ${esc(c.why)}</div>` : ''}
            ${d.btn}
          </div>`;
          })
          .join('')}
      </div>`
    : '';

  const takeaways = arr(an.keyTakeaways).length
    ? `<div class="card"><h3><span class="num">5</span>必须记住的要点</h3><div class="pill-row">${an.keyTakeaways
        .map((t) => `<span class="pill ok">${esc(t)}</span>`)
        .join('')}</div></div>`
    : '';

  const gaps = arr(an.gaps).length
    ? `<div class="card"><h3><span class="num">6</span>课件缺口与改进建议</h3>${listHtml(an.gaps)}</div>`
    : '';

  return hero + objectives + prereq + structure + concepts + takeaways + gaps;
}

/* ------------------- 1.5 结合课件讲解（顶层模式） ------------------- */

/**
 * 用「课件」里的内容，逐题讲解「习题/作业」里的题目。
 * 左边是课件对应页的截图，右边是讲解 —— 所有「课件原文」区域一律放截图，不放提取出的文字。
 */
function renderCombine() {
  const a = state.project?.analysis || {};
  const shape = state.project?.shape || {};
  const qs = arr(a.quiz?.questions);
  const cw = arr(shape.courseware)[0];
  const ex = arr(shape.exercise)[0];

  if (!qs.length) {
    return `<div class="card">
      <h3>${icon('wand', 15)}结合课件讲解</h3>
      <p style="color:var(--ink-2)">还没有题目。这个模式需要一份<b>习题/作业</b>（文件名含 tut / tutorial / assignment 等）才能工作。</p>
    </div>`;
  }

  const hero = `<div class="hero" style="background:linear-gradient(135deg,#1b2942,#2f4b7c)">
    <h1>结合课件讲解</h1>
    <p>用 ${cw ? `《${esc(cw.originalName)}》` : '课件'}里的内容，逐题讲解${ex ? `《${esc(ex.originalName)}》` : '题目'}中的问题：先点破考什么，再引课件原话，再说怎么落到这道题上。</p>
    <div class="facts">
      <span class="fact">共 ${qs.length} 道题</span>
      ${cw ? `<span class="fact">参考课件：${esc(cw.originalName)}</span>` : ''}
      ${ex ? `<span class="fact">题目来源：${esc(ex.originalName)}</span>` : ''}
      <span class="fact">课件原文以原生页面截图呈现</span>
    </div>
  </div>`;

  const cards = qs
    .map((q, i) => {
      const has = Boolean(explainOf(q.id));
      // 整道题可拖进右侧 AI 咨询
      const d = dnd({
        title: `第 ${i + 1} 题：${String(q.stem || '').slice(0, 60)}`,
        source: [q.source, q.location].filter(Boolean).join(' · ') || '练习题',
        text: [
          `题干：${q.stem || ''}`,
          arr(q.options).length ? `选项：\n${q.options.join('\n')}` : '',
          q.answer ? `参考答案：${q.answer}` : '',
          q.explanation ? `解析：${q.explanation}` : '',
          arr(q.keyPoints).length ? `评分要点：${q.keyPoints.join('；')}` : '',
          arr(q.pitfalls).length ? `易错点：${q.pitfalls.join('；')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      return `<div class="card" data-qcard="${esc(q.id)}">
        <div class="qhead" ${d.attrs}>
          <span class="qnum">第 ${i + 1} 题</span>
          ${q.type ? `<span class="tag type">${esc(q.type)}</span>` : ''}
          ${q.difficulty ? `<span class="tag">${esc(q.difficulty)}</span>` : ''}
          ${q.source ? `<span class="tag ${q.source === '课件原题' ? 'src' : ''}">${esc(q.source)}</span>` : ''}
          ${q.location ? `<span class="tag">${icon('pin', 11)}${esc(q.location)}</span>` : ''}
          ${d.btn}
        </div>
        <div class="qstem">${esc(q.stem)}</div>
        ${arr(q.options).length ? `<div class="qopts">${q.options.map((o) => `<div class="option-row" style="cursor:default"><span>${esc(o)}</span></div>`).join('')}</div>` : ''}
        <div class="qactions">
          <button class="btn accent" data-explain="${esc(q.id)}">${has ? '查看讲解' : icon('wand', 13) + '结合课件讲解这道题'}</button>
          <span class="spacer" style="flex:1"></span>
          <span class="muted" style="font-size:12px">${has ? '已生成，可展开查看' : '会引用课件原话并标注页码'}</span>
        </div>
        <div class="combine-slot" data-slot="${esc(q.id)}">${has ? explainPanel(q, explainOf(q.id)) : ''}</div>
      </div>`;
    })
    .join('');

  return hero + cards;
}

function wireCombine() {
  // 注意：$ 是 querySelector（单个元素），这里要遍历所有题目按钮，必须用 $$
  $$('[data-explain]').forEach((b) =>
    b.addEventListener('click', async () => {
      const qid = b.dataset.explain;
      const slot = document.querySelector(`[data-slot="${qid}"]`);
      if (slot && slot.innerHTML.trim()) {
        slot.innerHTML = '';
        b.innerHTML = icon('wand', 13) + '查看讲解';
        return;
      }
      const q = arr(state.project?.analysis?.quiz?.questions).find((x) => String(x.id) === String(qid));
      if (!q) return;
      b.disabled = true;
      const old = b.innerHTML;
      b.innerHTML = SPIN_SVG + '正在对照课件备课…';
      try {
        const res = await api(`/api/projects/${state.project.id}/explain`, {
          method: 'POST',
          body: JSON.stringify({ questionId: q.id }),
        });
        state.project.explain = state.project.explain || {};
        state.project.explain[q.id] = {
          result: res.result,
          excerpt: res.excerpt,
          answerKeyUsed: res.answerKeyUsed || '',
          at: new Date().toISOString(),
        };
        if (slot) slot.innerHTML = explainPanel(q, state.project.explain[q.id]);
        b.textContent = '收起讲解';
        if (typeof wireExplainSlides === 'function') wireExplainSlides(slot);
        toast(res.cached ? '已载入之前的讲解' : '讲解已生成', 'ok');
      } catch (err) {
        toast(err.message, 'err');
        b.innerHTML = old;
      } finally {
        b.disabled = false;
      }
    }),
  );
}

/* ------------------- 上课录像 → 讲解稿 ------------------- */

/** 把上课录像送去转写，并按课件页对齐成讲解稿 */
async function transcribeVideo() {
  const shape = state.project?.shape || {};
  const video = arr(shape.video)[0];
  if (!video) return toast('项目里没有上课录像', 'err');
  if (!confirm('会提取录像语音并转写，再按课件页对齐。时间取决于录像长度（可能几分钟到十几分钟），继续吗？')) return;

  const btn = $('#transcribeBtn');
  const old = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = SPIN_SVG + '正在转写…';
  }
  try {
    const res = await api(`/api/projects/${state.project.id}/transcribe`, {
      method: 'POST',
      body: JSON.stringify({ fileId: video.id }),
    });
    state.project = await api(`/api/projects/${state.project.id}`);
    toast(`转写完成：${res.segments || 0} 段语音，已对齐 ${res.aligned || 0} 页`, 'ok');
    render();
  } catch (err) {
    toast(err.message, 'err');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }
}

/* --------------------------- 2. 事例讲解 --------------------------- */

function renderExamples(ex) {
  if (!ex) return `<div class="note-box">事例讲解没有生成成功，可以重试。</div>`;
  const examples = arr(ex.examples);
  if (!examples.length) {
    return `<div class="card"><h3>事例讲解</h3><p style="color:var(--text-2)">${esc(ex.noExampleNote || '课件中未发现例题或案例。')}</p></div>`;
  }
  return (
    `<div class="card" style="margin-bottom:18px">
      <h3>共找到 ${examples.length} 个可讲的事例</h3>
      <p style="margin:0;color:var(--text-2);font-size:13.5px">每个事例都拆成了「题目 → 分步讲解 → 通用方法 → 易错点 → 回顾」，可以照着一步步学。</p>
    </div>` +
    examples
      .map((e, i) => {
        // 整个事例可拖进右侧 AI 咨询
        const d = dnd({
          title: `事例 ${e.id ?? i + 1}：${String(e.title || '').slice(0, 50)}`,
          source: ['事例讲解', e.location].filter(Boolean).join(' · '),
          text: [
            e.title ? `标题：${e.title}` : '',
            e.context ? `情境：${e.context}` : '',
            e.stem ? `题目：${e.stem}` : '',
            arr(e.steps).length ? `讲解步骤：\n${e.steps.map((s, si) => `${si + 1}. ${s.title}：${s.detail}`).join('\n')}` : '',
            e.method ? `通用方法：${e.method}` : '',
            e.answer ? `答案：${e.answer}` : '',
            arr(e.keyPoints).length ? `关键点：${e.keyPoints.join('；')}` : '',
            arr(e.pitfalls).length ? `易错点：${e.pitfalls.join('；')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        return `
    <div class="example" ${d.attrs}>
      <div class="example-head">
        <span class="idx">${esc(e.id ?? i + 1)}</span>
        <div style="flex:1">
          <h4>${esc(e.title || `事例 ${i + 1}`)}</h4>
          <div class="tags">
            ${e.type ? `<span class="tag type">${esc(e.type)}</span>` : ''}
            ${e.location ? `<span class="tag">${icon('pin', 11)}${esc(e.location)}</span>` : ''}
          </div>
        </div>
        ${d.btn}
      </div>
      <div class="example-body">
        ${e.context ? `<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">${esc(e.context)}</p>` : ''}
        ${e.stem ? `<div class="stem"><span class="lbl">题目 / 情境</span>${esc(e.stem)}</div>` : ''}
        ${
          arr(e.steps).length
            ? `<div class="steps">${e.steps
                .map(
                  (s, si) => `<div class="step">
              <span class="dot">${si + 1}</span>
              <div><h5>${esc(stripBold(s.title))}</h5><p>${esc(stripBold(s.detail))}</p></div>
            </div>`,
                )
                .join('')}</div>`
            : ''
        }
        ${e.method ? `<div class="note-box"><b>通用方法：</b>${esc(e.method)}</div>` : ''}
        ${e.answer ? `<div class="answer"><b>答案 / 结论：</b>${esc(e.answer)}</div>` : ''}
        ${arr(e.keyPoints).length ? `<div style="margin-top:14px"><b style="font-size:13px">关键点</b>${listHtml(e.keyPoints)}</div>` : ''}
        ${arr(e.pitfalls).length ? `<div class="note-box"><b>易错点</b>${listHtml(e.pitfalls, '')}</div>` : ''}
        ${e.board ? `<div class="board-box"><span class="lbl">关键式子</span>${esc(e.board)}</div>` : ''}
      </div>
    </div>`;
      })
      .join('')
  );
}

/* --------------------------- 总结分析 --------------------------- */

/** 表格行：模型可能给数组，也可能给「用 | 分隔的一整行字符串」，两种都吃 */
function summaryCells(row, n) {
  const cells = Array.isArray(row) ? row : String(row ?? '').split('|').map((c) => c.trim());
  return Array.from({ length: n }, (_, i) => cells[i] ?? '');
}

/** 一张表 */
function summaryTable(t, i) {
  const cols = arr(t?.columns);
  if (!cols.length) return '';
  const rows = arr(t?.rows);
  return `<div class="sum-table-block">
    ${t.title ? `<h5>${esc(t.title)}</h5>` : ''}
    <div class="sum-table-wrap">
      <table class="sum-table">
        <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows
          .map((r) => `<tr>${summaryCells(r, cols.length).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody>
      </table>
    </div>
    ${t.note ? `<p class="sum-table-note">${icon('bulb', 12)}${esc(t.note)}</p>` : ''}
  </div>`;
}

/** 思维导图：用 CSS 画成「主干 + 分支」的树，静态版和打印都正常 */
/**
 * 思维导图：横向树 + 曲线连线。
 *
 * 刻意把文字压到最短 —— 每个节点就是一个小圆角块里的几个字，
 * 「谁连着谁、谁包含谁」全靠连线看，而不是靠读句子。
 * 所以这里是手写布局 + SVG，不用现成的图库（那会引进一个依赖）。
 */
function mindmapLayout(root, { maxKids = 12 } = {}) {
  const nodes = [];
  const links = [];
  let row = 0;
  let maxDepth = 0;

  /** 先量一遍有多深多大，再决定间距 —— 节点多的时候要收紧，否则图会高得没法看 */
  const count = (n, d = 0) => {
    maxDepth = Math.max(maxDepth, d);
    return 1 + arr(n?.children).reduce((a, c) => a + count(c, d + 1), 0);
  };
  const total = count(root);

  // 大图收紧、小图松快
  const nodeH = total > 70 ? 24 : total > 40 ? 26 : 30;
  const gapY = total > 70 ? 7 : total > 40 ? 9 : 13;
  const colW = maxDepth >= 4 ? 174 : maxDepth === 3 ? 184 : 194;
  const pad = 20;

  const walk = (node, depth, parent) => {
    // 每层往里缩一点缩进，深层节点短一些，视觉上能看出亲疏
    const inset = depth === 0 ? 0 : 10 + depth * 4;
    const me = {
      label: String(node?.label || '').slice(0, 16),
      depth,
      x: pad + depth * colW,
      y: 0,
      w: colW - inset - 16,
      h: nodeH,
    };
    maxDepth = Math.max(maxDepth, depth);
    nodes.push(me);
    if (parent) links.push([parent, me]);

    // 注意：不要静默丢掉孩子 —— 那等于把模型拆好的结构吃掉
    const kids = arr(node?.children).filter((k) => k && k.label).slice(0, maxKids);
    if (!kids.length) {
      me.y = pad + row * (nodeH + gapY);
      row += 1;
      return me.y;
    }
    const ys = kids.map((k) => walk(k, depth + 1, me));
    me.y = (ys[0] + ys[ys.length - 1]) / 2;
    return me.y;
  };
  walk(root, 0, null);

  const width = pad * 2 + maxDepth * colW + (colW - 16);
  const height = pad * 2 + Math.max(1, row) * (nodeH + gapY) - gapY;
  return { nodes, links, width, height, total, depth: maxDepth };
}

function renderMindmap(mm) {
  const root = mm?.root;
  if (!root || !root.label) {
    return `<div class="card"><h3>${icon('mindmap', 15)}思维导图</h3>
      <p style="color:var(--ink-2)">思维导图还没有生成。点右上角 <b>「重新生成本节」</b> 试试。</p></div>`;
  }
  const { nodes, links, width, height, total, depth } = mindmapLayout(root);
  const esc2 = (s) => esc(String(s || ''));

  const paths = links
    .map(([a, b]) => {
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const mx = (x1 + x2) / 2;
      return `<path class="mm-link d${Math.min(b.depth, 4)}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`;
    })
    .join('');

  const boxes = nodes
    .map(
      (n) => `<g class="mm-node d${Math.min(n.depth, 4)}">
      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.depth === 0 ? 11 : 8}"/>
      <text x="${n.x + n.w / 2}" y="${n.y + n.h / 2}" dominant-baseline="central" text-anchor="middle">${esc2(n.label)}</text>
    </g>`,
    )
    .join('');

  return `
    <div class="card mm-card">
      <h3>${icon('mindmap', 15)}${esc(mm.title || '思维导图')}
        <span class="spacer"></span>
        <span class="mm-meta">${total} 个节点 · ${depth + 1} 层</span>
      </h3>
      <div class="mm-tools">
        <button class="btn sm ghost" data-mm-zoom="out" title="缩小">${icon('x', 12)}</button>
        <span class="mm-zoom" id="mmZoom">100%</span>
        <button class="btn sm ghost" data-mm-zoom="in" title="放大">${icon('plus', 12)}</button>
        <button class="btn sm ghost" data-mm-fit>适应窗口</button>
        <button class="btn sm ghost" data-mm-fit="1">1:1</button>
      </div>
      <div class="mm-canvas" id="mmCanvas">
        <div class="mm-scaler" id="mmScaler" style="width:${width}px;height:${height}px">
          <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
               aria-label="${esc2(mm.title || '思维导图')}">${paths}${boxes}</svg>
        </div>
      </div>
      <p class="hint" style="margin:10px 0 0">节点只写关键词，关系看连线：越往右越具体，同一横排的可以并列比较。图大时可以缩放或适应窗口。</p>
    </div>`;
}

/** 缩放：整张图按倍数缩放，容器跟着改尺寸，滚动条才对得上 */
function applyMindmapZoom(z) {
  const scaler = $('#mmScaler');
  if (!scaler) return;
  const svg = scaler.querySelector('svg');
  if (!svg) return;
  const w = Number(svg.getAttribute('width')) || 1;
  const h = Number(svg.getAttribute('height')) || 1;
  const clamped = Math.max(0.2, Math.min(3, z));
  svg.style.transformOrigin = '0 0';
  svg.style.transform = `scale(${clamped})`;
  scaler.style.width = `${w * clamped}px`;
  scaler.style.height = `${h * clamped}px`;
  scaler.dataset.zoom = String(clamped);
  const label = $('#mmZoom');
  if (label) label.textContent = `${Math.round(clamped * 100)}%`;
}

function wireMindmapTools() {
  const canvas = $('#mmCanvas');
  if (!canvas) return;
  const fit = (target) => {
    const scaler = $('#mmScaler');
    const svg = scaler?.querySelector('svg');
    if (!svg) return;
    const w = Number(svg.getAttribute('width')) || 1;
    const h = Number(svg.getAttribute('height')) || 1;
    // 适应窗口时不要把图放大到超过 100%，那样只会变糊
    const z = Math.min(1, (canvas.clientWidth - 24) / w, (canvas.clientHeight - 24) / h);
    applyMindmapZoom(target === 1 ? 1 : z);
  };
  $$('[data-mm-zoom]').forEach((b) =>
    b.addEventListener('click', () => {
      const cur = Number($('#mmScaler')?.dataset.zoom || 1);
      applyMindmapZoom(b.dataset.mmZoom === 'in' ? cur * 1.2 : cur / 1.2);
    }),
  );
  $$('[data-mm-fit]').forEach((b) =>
    b.addEventListener('click', () => fit(b.dataset.mmFit === '1' ? 1 : 0)),
  );
  // 默认先适应窗口，大图一进来就能看全貌
  fit(0);
}

function summaryMindmap(mm, { compact = false } = {}) {
  const branches = arr(mm?.branches);
  if (!branches.length) return '';
  const svg = (d) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  return `<div class="mindmap ${compact ? 'compact' : ''}">
    <div class="mm-root">
      <span class="mm-root-dot">${svg('<circle cx="12" cy="12" r="3"/>')}</span>
      <b>${esc(mm.root || '总主题')}</b>
    </div>
    <div class="mm-branches">
      ${branches
        .map(
          (b, i) => `<div class="mm-branch" style="--i:${i}">
            <div class="mm-branch-head">
              <span class="mm-branch-idx">${i + 1}</span>
              <span class="mm-branch-name">${esc(b.name || '')}</span>
            </div>
            ${!compact && b.note ? `<div class="mm-branch-note">${esc(b.note)}</div>` : ''}
            ${
              arr(b.children).length
                ? `<div class="mm-leaves">${b.children
                    .map(
                      (c) => `<div class="mm-leaf">
                        <span class="mm-leaf-name">${esc(c.name || c)}</span>
                        ${!compact && c && c.note ? `<span class="mm-leaf-note">${esc(c.note)}</span>` : ''}
                      </div>`,
                    )
                    .join('')}</div>`
                : ''
            }
          </div>`,
        )
        .join('')}
    </div>
  </div>`;
}

function renderSummary(sm) {
  if (!sm) {
    return `<div class="card"><h3>${icon('layers', 15)}总结分析</h3><p style="color:var(--ink-2)">总结分析还没有生成。点右上角 <b>「重新生成本节」</b> 试试。</p></div>`;
  }
  if (sm.skipped) return '';

  const concepts = arr(sm.concepts);
  const tables = arr(sm.tables);
  const confusions = arr(sm.confusions);
  const path = arr(sm.learningPath);
  const checks = arr(sm.selfCheck);

  const hero = `<div class="hero" style="background:linear-gradient(135deg,#1d2b3a,#2f4b4a)">
    <h1>${esc(sm.title || '知识总结')}</h1>
    <div class="facts">
      <span class="fact">${concepts.length} 个知识点</span>
      <span class="fact">${tables.length} 张表</span>
      <span class="fact">${arr(sm.mindmap?.branches).length} 支思维导图</span>
      <span class="fact">${checks.length} 道自测题</span>
    </div>
    ${sm.bigPicture ? `<p style="margin:16px 0 0;font-size:14.5px;line-height:1.95;color:rgba(255,255,255,.9)">${esc(sm.bigPicture)}</p>` : ''}
  </div>`;

  // 思维导图只是个点缀：缩成一张小卡放在最上面，不占章节编号，
  // 真正把知识讲透靠的是下面的知识点和表格
  const mapCard = arr(sm.mindmap?.branches).length
    ? `<div class="mm-aside">${summaryMindmap(sm.mindmap, { compact: true })}</div>`
    : '';

  const conceptCard = concepts.length
    ? `<div class="card"><h3><span class="num">1</span>知识点逐个讲透</h3>
        <div class="sum-concepts">${concepts
          .map((c, i) => {
            const d = dnd({
              title: `知识点：${String(c.term || '').slice(0, 50)}`,
              source: '总结分析 · 知识点',
              text: [c.term, c.plain, c.why, c.detail, c.relations, c.background].filter(Boolean).join('\n\n'),
            });
            return `<div class="sum-concept" ${d.attrs}>
              <div class="sc-head"><span class="sc-idx">${i + 1}</span><b>${esc(c.term || '')}</b>${d.btn}</div>
              ${c.plain ? `<p class="sc-plain">${esc(c.plain)}</p>` : ''}
              ${c.why ? `<div class="sc-row"><span class="sc-tag">为什么需要</span><span>${esc(c.why)}</span></div>` : ''}
              ${c.detail ? `<div class="sc-detail">${mdToHtml(c.detail)}</div>` : ''}
              ${c.relations ? `<div class="sc-row"><span class="sc-tag">关系</span><span>${esc(c.relations)}</span></div>` : ''}
              ${c.background && !/^课件已讲清楚/.test(c.background) ? `<div class="sc-bg">${icon('alert', 12)} 背景补充：${esc(c.background)}</div>` : ''}
            </div>`;
          })
          .join('')}</div></div>`
    : '';

  const tableCard = tables.length
    ? `<div class="card"><h3><span class="num">2</span>对照表
        <span class="spacer"></span>
        <span style="font-weight:400;color:var(--ink-4);font-size:12px">凡是能摆在一起比的，都用表来看</span>
      </h3>${tables.map(summaryTable).join('')}</div>`
    : '';

  const confCard = confusions.length
    ? `<div class="card"><h3><span class="num">3</span>最容易混的地方</h3>
        <div class="sum-confusions">${confusions
          .map(
            (c) => `<div class="sum-confusion">
              <div class="sf-pair">${esc(c.pair || '')}</div>
              ${c.difference ? `<div class="sf-line"><b>区别</b>${esc(c.difference)}</div>` : ''}
              ${c.howToTell ? `<div class="sf-line"><b>怎么判断</b>${esc(c.howToTell)}</div>` : ''}
            </div>`,
          )
          .join('')}</div></div>`
    : '';

  const pathCard = path.length
    ? `<div class="card"><h3><span class="num">4</span>从零开始的顺序</h3>
        <div class="sum-path">${path
          .map(
            (s, i) => `<div class="sp-step">
              <span class="sp-no">${esc(s.step ?? i + 1)}</span>
              <div class="sp-body">
                <b>${esc(s.title || '')}</b>
                ${s.why ? `<div class="sp-why">${esc(s.why)}</div>` : ''}
                ${s.checkpoint ? `<div class="sp-check">${icon('target', 12)}过关标准：${esc(s.checkpoint)}</div>` : ''}
              </div>
            </div>`,
          )
          .join('')}</div></div>`
    : '';

  const checkCard = checks.length
    ? `<div class="card"><h3><span class="num">5</span>自测
        <span class="spacer"></span>
        <span style="font-weight:400;color:var(--ink-4);font-size:12px">答不上来就回去看对应的知识点</span>
      </h3>
      <div class="sum-checks">${checks
        .map(
          (c, i) => `<details class="sum-check">
            <summary><span class="sq-idx">${i + 1}</span>${esc(c.q || '')}</summary>
            <div class="sq-body">
              <div class="sq-a"><b>答案</b>${esc(c.a || '')}</div>
              ${c.tests ? `<div class="sq-tests">${icon('target', 11)} 检验：${esc(c.tests)}</div>` : ''}
            </div>
          </details>`,
        )
        .join('')}</div></div>`
    : '';

  return hero + mapCard + conceptCard + tableCard + confCard + pathCard + checkCard;
}

/* --------------------------- 3. 学习规划 --------------------------- */

function renderGuide(g) {
  if (!g) return `<div class="note-box">学习规划没有生成成功，可以重试。</div>`;
  // 兼容两代数据：新的是 studyFlow（学习者视角），老项目里还存着 lessonFlow（教案视角）
  const isStudy = arr(g.studyFlow).length > 0;
  const flow = isStudy ? arr(g.studyFlow) : arr(g.lessonFlow);
  const totalMin = flow.reduce((n, f) => n + (Number(f.minutes) || 0), 0);

  const flowCard = flow.length
    ? `<div class="card">
        <h3><span class="num">1</span>${isStudy ? '学习步骤' : '课堂流程'}${totalMin ? `（合计约 ${totalMin} 分钟）` : ''}</h3>
        <div style="overflow-x:auto">
        <table class="flow-table">
          <thead><tr><th>阶段</th><th>用时</th><th>看哪里</th>${isStudy ? '<th>做什么</th><th>容易卡住</th><th>过关标准</th>' : '<th>教师做什么</th><th>学生做什么</th><th>课件怎么用</th>'}</tr></thead>
          <tbody>
            ${flow
              .map(
                (f) => `<tr>
              <td class="phase">${esc(f.phase)}</td>
              <td class="mins">${esc(f.minutes ?? '—')}′</td>
              <td class="mins">${esc(f.location || '—')}</td>
              ${isStudy
                ? `<td>${esc(stripBold(f.whatToDo) || '—')}</td><td>${esc(stripBold(f.watchOut) || '—')}</td><td>${esc(stripBold(f.checkpoint) || '—')}</td>`
                : `<td>${esc(f.teacherAction || '—')}</td><td>${esc(f.studentAction || '—')}</td><td>${esc(f.howToUseCourseware || '—')}</td>`}
            </tr>`,
              )
              .join('')}
          </tbody>
        </table>
        </div>
        ${flow.some((f) => f.script)
          ? `<div style="margin-top:16px"><b style="font-size:13px">${icon('mic', 13)} 讲解稿（可直接照着念）</b>
              ${flow.filter((f) => f.script).map((f) => `<div class="stem" style="margin-top:10px;margin-bottom:0"><span class="lbl">${esc(f.phase)}${f.location ? ` · ${esc(f.location)}` : ''}</span>${esc(f.script)}</div>`).join('')}
            </div>`
          : ''}
      </div>`
    : '';

  const qList = arr(g.selfQuestions).length ? arr(g.selfQuestions) : arr(g.questions);
  const qIsStudy = arr(g.selfQuestions).length > 0;
  const questions = qList.length
    ? `<div class="card">
        <h3><span class="num">2</span>${qIsStudy ? '学到这儿应该能回答' : '课堂提问设计'}</h3>
        ${qList.map((q, i) => `<div class="qa-item">
            <div class="q"><span class="n">${i + 1}</span><span>${esc(q.question)}</span></div>
            <div class="a">${qIsStudy ? '参考答案' : '参考回答'}：${esc(q.answer || '—')}</div>
            <div class="p">${qIsStudy ? '检验' : '目的'}：${esc(q.purpose || '—')}${q.location ? ` ｜ 对应 ${esc(q.location)}` : ''}</div>
          </div>`).join('')}
      </div>`
    : '';

  const practice = arr(g.practice).length ? arr(g.practice) : arr(g.activities);
  const activities = practice.length
    ? `<div class="card">
        <h3><span class="num">3</span>${arr(g.practice).length ? '动手练习' : '课堂活动'}</h3>
        ${practice.map((a) => `<div class="concept">
            <b>${esc(a.name)}</b> <span style="font-size:12px;color:var(--text-3)">${esc(a.duration || '')}</span>
            ${arr(a.steps).length ? `<div style="margin-top:8px">${listHtml(a.steps, '')}</div>` : ''}
            ${a.materials ? `<p style="font-size:12.5px;color:var(--text-3)">${arr(g.practice).length ? '需要准备' : '材料'}：${esc(a.materials)}</p>` : ''}
          </div>`).join('')}
      </div>`
    : '';

  const hwData = g.tasks || g.homework;
  const hw = hwData
    ? `<div class="card">
        <h3><span class="num">4</span>${g.tasks ? '要动手做的事' : '作业布置'}</h3>
        <div class="grid-2">
          <div><b style="font-size:13px;color:var(--ok)">必做</b>${listHtml(hwData.basic)}</div>
          <div><b style="font-size:13px;color:var(--warn)">选做 / 拓展</b>${listHtml(hwData.advanced)}</div>
        </div>
      </div>`
    : '';

  const diffData = g.byLevel || g.differentiation;
  const diff = diffData
    ? `<div class="card">
        <h3><span class="num">5</span>${g.byLevel ? '不同基础怎么学' : '分层教学'}</h3>
        <div class="concept"><b>基础薄弱</b><p>${esc(diffData.struggling || '—')}</p></div>
        <div class="concept"><b>正常进度</b><p>${esc(diffData.average || '—')}</p></div>
        <div class="concept"><b>学有余力</b><p>${esc(diffData.advanced || '—')}</p></div>
      </div>`
    : '';

  const assessment = arr(g.assessment).length
    ? `<div class="card"><h3><span class="num">6</span>${g.byLevel ? '怎么确认学会了' : '学习效果检验'}</h3>${listHtml(g.assessment)}</div>`
    : '';

  const pitfalls = arr(g.pitfalls).length
    ? `<div class="card"><h3><span class="num">7</span>${g.byLevel ? '容易卡住的地方' : '使用这份课件的注意事项'}</h3>${listHtml(g.pitfalls)}</div>`
    : '';

  const tips = arr(g.tips).length
    ? `<div class="card"><h3><span class="num">8</span>${g.byLevel ? '学习技巧' : '提效技巧'}</h3><div class="pill-row">${g.tips.map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div></div>`
    : '';

  const positioning = g.positioning
    ? `<div class="card"><h3>${icon('pin', 14)} ${g.byLevel ? '这份材料在你学习里的位置' : '这份课件的定位'}</h3><p style="margin:0;font-size:13.5px;color:var(--text-2)">${esc(stripBold(g.positioning))}</p></div>`
    : '';

  return positioning + flowCard + questions + activities + hw + diff + assessment + pitfalls + tips;
}

/* --------------------------- 4. 逐页讲解 --------------------------- */

function renderNarration(n) {
  const shape = state.project?.shape || {};
  const video = arr(shape.video)[0];

  // 上传了上课录像 → 讲解稿以录像里的真实讲法为准，不再由 AI 生成
  const videoCard = video
    ? `<div class="card">
        <h3>${icon('mic', 15)}上课录像</h3>
        <video class="lecture-video" src="${esc(video.mediaUrl)}" controls preload="metadata"></video>
        <div class="slide-bar">
          <span>${esc(video.originalName)}</span>
          <span class="spacer"></span>
          <button class="btn sm accent" id="transcribeBtn">${icon('wand', 13)}从视频生成讲解稿</button>
        </div>
        <p class="hint" style="margin:10px 0 0">已检测到上课录像：讲解稿会改用录像里的真实语音（按页对齐），不再由 AI 代写。</p>
      </div>`
    : '';

  const segs = arr(n?.segments);
  if (!segs.length) {
    return `${videoCard}
      <div class="card">
        <h3>${icon('mic', 15)}逐页讲解稿</h3>
        <p style="color:var(--ink-2)">${
          video
            ? '还没有讲解稿。点上面的「从视频生成讲解稿」，平台会转写录像语音并按页对齐。'
            : '没有生成讲解稿。若课件是扫描版 PDF 或纯图片，可能没有可提取的文字。'
        }</p>
      </div>`;
  }

  const fromVideo = segs.some((s) => s.fromVideo);
  const aiCount = segs.filter((s) => s.aiFilled).length;
  // 左下角问答锚定在「当前页」上；没选过就是第一页

  return `
    ${videoCard}
    <div class="hero" style="background:linear-gradient(135deg,#141c2c,#24395c)">
      <h1>逐页讲解模式</h1>
      <p>共 ${segs.length} 页讲解稿。左边是你要说的话，右边是课件的原页面截图，可以单独翻课件页。</p>
      <div class="facts">
        <span class="fact">按方向键或空格翻页</span>
        <span class="fact">按 Esc 退出</span>
        <span class="fact">按 F 全屏</span>
        ${fromVideo ? '<span class="fact">讲解稿来源：上课录像</span>' : ''}
        ${aiCount ? `<span class="fact">其中 ${aiCount} 页为 AI 补写</span>` : ''}
      </div>
      <div style="margin-top:18px"><button class="btn primary" id="startPresent">${icon('play', 14)}进入全屏讲解</button></div>
    </div>
    ${segs
      .map((s, i) => {
        // 整页讲解稿可拖进右侧 AI 咨询
        const d = dnd({
          title: s.location || `第 ${i + 1} 页`,
          source: `逐页讲解${s.fromVideo ? ' · 录像原话' : s.aiFilled ? ' · AI 补写' : ''}`,
          text: [
            s.title ? `标题：${s.title}` : '',
            s.scriptEn ? `英文原话：${s.scriptEn}` : '',
            `讲解稿：${s.script || ''}`,
            arr(s.keyPoints).length ? `要点：${s.keyPoints.join('；')}` : '',
            s.askClass ? `自问：${s.askClass}` : '',
            s.board ? `关键式子：${s.board}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        return `<div class="card" ${d.attrs}>
        <h3><span class="num">${i + 1}</span>${esc(s.location || `第 ${i + 1} 页`)}　<span style="font-weight:500;color:var(--ink-2)">${esc(s.title || '')}</span>
          ${s.aiFilled ? '<span class="tag type">AI 补写</span>' : ''}
          ${s.fromVideo ? '<span class="tag src">录像原话</span>' : ''}
          <span class="spacer"></span>
          <button class="btn sm ghost" data-jump="${i}">${icon('play', 13)}讲这一页</button>
        </h3>
        <div class="narration-row">
          <div class="narration-thumb"><div class="slide-stage" data-thumb="${i}"></div></div>
          <div>
            ${s.scriptEn ? `<p style="margin:0 0 8px;font-size:13.5px;line-height:1.85;color:var(--ink-2)">${esc(s.scriptEn)}</p>
              <p style="margin:0 0 12px;font-size:14px;line-height:1.9">${esc(s.script || '')}</p>` : `<p style="margin:0 0 12px;font-size:14px;line-height:1.9">${esc(s.script || '')}</p>`}
            ${arr(s.keyPoints).length ? `<div class="pill-row" style="margin-bottom:10px">${s.keyPoints.map((k) => `<span class="pill">${esc(k)}</span>`).join('')}</div>` : ''}
            ${s.askClass ? `<div class="note-box">${icon('help', 13)} 自问：${esc(s.askClass)}</div>` : ''}
            ${s.board ? `<div class="board-box"><span class="lbl">关键式子</span>${esc(s.board)}</div>` : ''}
            ${s.transition ? `<p style="margin:12px 0 0;color:var(--ink-3);font-size:12.5px;font-style:italic">过渡：${esc(s.transition)}</p>` : ''}
          </div>
        </div>
        ${d.btn}
      </div>`;
      })
      .join('')}`;
}

function wireNarration() {
  $('#startPresent')?.addEventListener('click', () => openPresenter(0));
  $$('[data-jump]').forEach((b) => b.addEventListener('click', () => openPresenter(Number(b.dataset.jump))));
  $('#transcribeBtn')?.addEventListener('click', () => transcribeVideo());

  // 缩略图懒渲染：滚到可见才画，避免一次渲染几十页 PDF
  const segs = arr(state.project?.analysis?.narration?.segments);
  const thumbs = $$('[data-thumb]');
  const paint = (el) => {
    const target = slideTarget(segs[Number(el.dataset.thumb)]);
    mountSlide(el, target?.file?.previewPdf, target?.page || 1, { width: 520 });
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          paint(e.target);
        }
      },
      { rootMargin: '400px' },
    );
    thumbs.forEach((el) => io.observe(el));
  } else {
    thumbs.forEach(paint);
  }
}

/**
 * 找出某段讲解稿对应「哪份课件的哪一页」，用于右侧/左侧的课件截图。
 * 优先用预览 PDF（真截图），找不到就退回第一份能做截图的文件。
 */
function slideTarget(seg) {
  const found = seg ? findBlock(seg.location) : null;
  if (found?.file?.previewPdf) {
    const page = Number(found.block?.page ?? found.block?.index ?? 1) || 1;
    return { file: found.file, page };
  }
  const files = state.project?.files || [];
  const f = files.find((x) => x.previewPdf && x.role === 'courseware') || files.find((x) => x.previewPdf);
  return f ? { file: f, page: 1 } : null;
}

/** 把讲解稿的位置（第N页）映射回抽取到的原文块 */
function findBlock(location) {
  const text = String(location || '');
  const m = text.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  const wantSlide = /幻灯片|slide/i.test(text);
  const files = state.project?.files || [];

  // 先按结构化字段匹配，再退回按标签匹配
  let candidates = [];
  for (const f of files) {
    for (const b of f.blocks || []) {
      if (b.index === n || b.page === n) candidates.push({ file: f, block: b });
    }
  }
  if (!candidates.length) {
    for (const f of files) {
      for (const b of f.blocks || []) {
        const lm = String(b.label || '').match(/\d+/);
        if (lm && parseInt(lm[0], 10) === n) candidates.push({ file: f, block: b });
      }
    }
  }
  if (!candidates.length) return null;
  // PPTX 是「第N页幻灯片」，PDF 是「第N页」；同一项目里两种会撞号，这里消歧
  const isSlide = (c) => c.block.type === 'slide' || c.file.kind === 'pptx';
  // 同一页码在多份文件里都存在时（例如「实验指导」和「课件」都是第1页），优先用「课件」
  const isCourseware = (c) => c.file.role === 'courseware';
  if (wantSlide) return candidates.find(isSlide) || candidates[0];

  const nonSlide = candidates.filter((c) => !isSlide(c));
  return nonSlide.find(isCourseware) || nonSlide[0] || candidates.find(isCourseware) || candidates[0];
}

/* ------------------------- 装到手机桌面（PWA） ------------------------- */

/**
 * 为什么这么做：
 *   安卓（Chrome / Edge / 三星浏览器）支持 `beforeinstallprompt`，
 *   可以真的「一键安装」—— 点一下系统就弹安装框，装完桌面就有图标。
 *   iOS 的 Safari 故意不提供这个事件，只能走「分享 → 添加到主屏幕」，
 *   所以那边给一张带图示的说明，而不是假装能一键装。
 */
const INSTALL = { deferred: null, standalone: false };

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.matchMedia?.('(display-mode: fullscreen)')?.matches ||
    window.navigator.standalone === true
  );
}

function isIOS() {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ 的 UA 伪装成 Mac，用触摸点数补判
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function syncInstallBtn() {
  const btn = $('#installBtn');
  if (!btn) return;
  // 已经装过了就不用再提示
  if (isStandalone()) {
    btn.hidden = true;
    return;
  }
  // 安卓：系统给了安装事件才显示（说明这个浏览器真的能装）
  if (INSTALL.deferred) {
    btn.hidden = false;
    btn.title = '安装到手机桌面';
    return;
  }
  // iOS：没有安装事件，但确实能装，给说明
  btn.hidden = !isIOS();
  btn.title = '添加到主屏幕';
}

async function installApp() {
  // 安卓：调起系统的安装框
  if (INSTALL.deferred) {
    const ev = INSTALL.deferred;
    INSTALL.deferred = null;
    try {
      ev.prompt();
      const res = await ev.userChoice;
      if (res?.outcome === 'accepted') toast('已开始安装，装好后桌面就有图标了');
      else toast('已取消安装，随时可以再点右上角安装');
    } catch {
      toast('这个浏览器没能弹出安装框，可以手动从菜单里「安装应用」', 'err');
    }
    syncInstallBtn();
    return;
  }
  showIosInstallHelp();
}

/** iOS 的「添加到主屏幕」步骤图。只能这么装，所以说清楚。 */
function showIosInstallHelp() {
  openModal(
    `<h3>${icon('download', 15)} 添加到手机桌面</h3>
     <p style="color:var(--ink-2);font-size:13.5px;line-height:1.8;margin:0 0 14px">
       iPhone / iPad 上要装到桌面，需要走 Safari 的分享菜单（这是系统限制，所有网页都一样）：
     </p>
     <ol class="ios-steps">
       <li><span class="ios-n">1</span><div>用 <b>Safari</b> 打开这个页面（微信 / QQ 内置浏览器不行，右上角「⋯」→ 用 Safari 打开）</div></li>
       <li><span class="ios-n">2</span><div>点屏幕<b>底部中间</b>的分享按钮 <span class="ios-share">${icon('upload', 13)}</span></div></li>
       <li><span class="ios-n">3</span><div>在弹出菜单里往下找到 <b>「添加到主屏幕」</b>，点它</div></li>
       <li><span class="ios-n">4</span><div>右上角点 <b>「添加」</b> —— 桌面就会出现图标，点开是全屏的，和 App 一样</div></li>
     </ol>
     <div class="modal-actions"><button class="btn primary" data-close>知道了</button></div>`,
  );
}

function wireInstall() {
  INSTALL.standalone = isStandalone();
  window.addEventListener('beforeinstallprompt', (e) => {
    // 拦下系统默认的小横幅，改成我们自己的按钮，位置更明确
    e.preventDefault();
    INSTALL.deferred = e;
    syncInstallBtn();
  });
  window.addEventListener('appinstalled', () => {
    INSTALL.deferred = null;
    syncInstallBtn();
    toast('已装到桌面，以后点图标就能直接打开');
  });
  $('#installBtn')?.addEventListener('click', installApp);
  syncInstallBtn();
}

/* ---------------------- 项目 / 项目组的导出与导入 ---------------------- */

/** 一个文件带走整个项目（含课件原件、生成的内容、做题记录、对话） */
function exportCurrentProject() {
  const p = state.project;
  if (!p?.id) return;
  if (isStaticProject(p)) return;
  const url = `/api/projects/${p.id}/export.bundle`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('已开始导出，稍等片刻');
}

function isStaticProject() {
  return typeof IS_STATIC !== 'undefined' && IS_STATIC;
}

/** 导出整个项目组 */
function exportGroup(groupId) {
  if (!groupId) return;
  const a = document.createElement('a');
  a.href = `/api/groups/${groupId}/export.bundle`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('已开始导出这个项目组');
}

/**
 * 导入：文件是 JSON，可能很大（内嵌了课件原件），所以用 fetch 直接 POST 文本，
 * 不走表单，也不预览，导完刷新列表。
 */
async function importBundleFile(file) {
  if (!file) return;
  if (file.size > 512 * 1024 * 1024) {
    toast('这个文件太大了（超过 512MB），没法导入', 'err');
    return;
  }
  toast(`正在导入 ${file.name}…`);
  try {
    const text = await file.text();
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: text,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `导入失败（${res.status}）`);
    await loadWorkspace();
    const names = arr(data.projects).map((x) => x.name).join('、');
    toast(`导入完成：${data.projects.length} 个项目（${names}）${data.groups ? `，新建 ${data.groups} 个项目组` : ''}`);
    // 直接切到导进来的第一个，省得用户自己找
    if (data.projects[0]?.id) await switchProject(data.projects[0].id);
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* --------------------------- 主题：深色 / 浅色 --------------------------- */

const THEME_KEY = 'cw_theme';

/** 用户没选过就跟随系统 */
function currentTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    /* 无痕模式下读不到，跟随系统即可 */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}

/** 主题全部靠 data-theme 覆盖 CSS 变量，组件样式不用改 */
function applyTheme(mode) {
  const m = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = m;
  const btn = $('#themeBtn');
  if (btn) {
    btn.innerHTML = icon(m === 'dark' ? 'sun' : 'moon', 15);
    btn.title = m === 'dark' ? '切换到浅色' : '切换到深色';
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', m === 'dark' ? '#0e1218' : '#f5f6f8');
}

function setTheme(mode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* 存不下也无所谓，这次会话内仍然是生效的 */
  }
  applyTheme(mode);
}

function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/* ------------------ 逐页讲解：左下角「就这一页提问」 ------------------ */

/** 当前页对应的那条讲解稿 */
function narrSegment(index) {
  const segs = arr(state.project?.analysis?.narration?.segments);
  // 这个问答面板现在只出现在全屏讲解里，所以「当前页」就是讲解走到的那一段。
  // 注意：拼 HTML 的那一刻 .presenter 还没插进 DOM，检测不到 —— 所以允许显式传页码。
  const want = Number.isFinite(index) ? index : state.presenter.index;
  const i = Math.max(0, Math.min(want, segs.length - 1));
  return segs[i] || null;
}

/**
 * 把「当前页」打包成给模型的上下文。
 * 翻页时这个上下文会跟着换，所以问答永远是针对当前这一页的。
 */
function narrAttachment() {
  const s = narrSegment();
  if (!s) return null;
  const text = [
    s.title ? `标题：${s.title}` : '',
    s.script ? `讲解稿：${s.script}` : '',
    arr(s.keyPoints).length ? `要点：${s.keyPoints.join('；')}` : '',
    s.askClass ? `自问：${s.askClass}` : '',
    s.board ? `关键式子：${s.board}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (!text) return null;
  return {
    title: `${s.location || ''}${s.title ? ' ' + s.title : ''}`.trim() || '这一页',
    source: '逐页讲解 · 当前页',
    text,
  };
}

/** 展开 / 收起。收起时整块向右滑出屏幕，只留右上角一个小把手可以再叫回来。 */
function expandPageChat(open) {
  state.pageChat.open = open;
  const panel = $('#pageChat');
  const handle = $('#pcHandle');
  const btn = $('#pcToggle');
  if (btn) btn.innerHTML = icon(open ? 'down' : 'chat', 13);

  if (open) {
    // 先把它摆回屏幕外，再在下一帧滑进来，才有「滑入」的动感
    if (panel) {
      panel.hidden = false;
      panel.classList.remove('collapsed', 'sliding-out');
      panel.style.transform = 'translateX(calc(100% + 32px))';
      panel.style.opacity = '0';
      requestAnimationFrame(() => {
        panel.style.transform = '';
        panel.style.opacity = '';
      });
    }
    if (handle) handle.hidden = true;
    setTimeout(() => $('#pcInput')?.focus(), 220);
  } else {
    if (handle) handle.hidden = false;
    if (panel) {
      panel.classList.add('collapsed', 'sliding-out');
      panel.style.transform = '';
      panel.style.opacity = '';
    }
  }
}

function pageChatMsg(m) {
  const isUser = m.role === 'user';
  return `<div class="pc-msg ${isUser ? 'user' : 'ai'}">
    <div class="pc-bubble">${isUser ? esc(m.content).replace(/\n/g, '<br>') : mdToHtml(stripAiMarks(m.content))}</div>
  </div>`;
}

function renderPageChat(index) {
  const s = narrSegment(index);
  const msgs = arr(state.project?.pageChat);
  const open = state.pageChat.open !== false;
  state.pageChat.open = open;
  return `
  <button class="pc-handle" id="pcHandle" ${open ? 'hidden' : ''} title="展开「就这一页提问」">
    ${icon('chat', 13)}<span>就这一页提问</span>
  </button>
  <div class="page-chat ${open ? '' : 'collapsed'}" id="pageChat">
    <div class="pc-head">
      <span class="pc-dot"></span>
      <b id="pcPage">${esc(s?.location || `第 ${state.presenter.index + 1} 页`)}</b>
      <span class="pc-title" id="pcTitle">${esc(s?.title || '')}</span>
      <span class="spacer"></span>
      <button class="icon-btn" id="pcClear" title="清空这一栏的对话">${icon('trash', 13)}</button>
      <button class="icon-btn" id="pcToggle" title="展开 / 收起">${icon(open ? 'down' : 'chat', 13)}</button>
    </div>
    <div class="pc-body">
      <div class="pc-hint">问的是<b>当前这一页</b>；翻到别页再问，上下文会跟着换。</div>
      <div class="pc-msgs" id="pcMsgs">${
        msgs.length
          ? msgs.map(pageChatMsg).join('')
          : '<div class="pc-empty">这一页有哪里没懂？直接问，AI 会只就这一页和你讲。</div>'
      }</div>
      <div class="pc-compose">
        <textarea id="pcInput" rows="1" placeholder="就这一页提问，Enter 发送"></textarea>
        <button class="btn sm primary" id="pcSend">${icon('send', 13)}</button>
      </div>
    </div>
  </div>`;
}

function wirePageChat() {
  const panel = $('#pageChat');
  if (!panel) return;
  $('#pcToggle')?.addEventListener('click', () => expandPageChat(panel.classList.contains('collapsed')));
  $('#pcHandle')?.addEventListener('click', () => expandPageChat(true));
  $('#pcClear')?.addEventListener('click', async () => {
    const ok = await confirmBox({ title: '清空这一栏的对话？', body: '不会影响右侧 AI 咨询，也不会动生成好的内容。', okText: '清空' });
    if (!ok) return;
    state.project.pageChat = [];
    try {
      await api(`/api/projects/${state.project.id}/ask?channel=page`, { method: 'DELETE' });
    } catch {
      /* 服务端没删掉也无妨，本地已经清了 */
    }
    render();
  });
  const input = $('#pcInput');
  const send = () => pageChatSend();
  $('#pcSend')?.addEventListener('click', send);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  });
}

async function pageChatSend() {
  if (state.pageChat.sending) return;
  const input = $('#pcInput');
  const question = (input?.value || '').trim();
  if (!question) return;
  if (!state.project?.id) return;
  if (keyRequired() && !state.apiKey) {
    openGate('需要 API Key 才能提问');
    return;
  }
  const attachment = narrAttachment();
  const attachments = attachment ? [attachment] : [];

  state.pageChat.sending = true;
  const local = arr(state.project.pageChat);
  local.push({ role: 'user', content: question, at: new Date().toISOString() });
  local.push({ role: 'assistant', content: '', streaming: true, at: new Date().toISOString() });
  state.project.pageChat = local;
  if (input) {
    input.value = '';
    input.style.height = 'auto';
  }
  render();

  const box = () => $('#pcMsgs .pc-msg:last-child .pc-bubble');
  const paint = (html) => {
    const b = box();
    if (b) b.innerHTML = html;
    const msgs = $('#pcMsgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  };
  try {
    let acc = '';
    await postSSE(
      `/api/projects/${state.project.id}/ask`,
      { question, attachments, channel: 'page' },
      (e) => {
        if (e.type === 'delta') {
          acc += e.text || '';
          local[local.length - 1].content = acc;
          paint(mdToHtml(stripAiMarks(acc)) + '<span style="opacity:.4">▌</span>');
        } else if (e.type === 'fatal') {
          if (e.needsKey) openGate(e.message);
          throw new Error(e.message || '回答失败');
        }
      },
    );
    if (!local[local.length - 1].content) throw new Error('模型没有返回内容，请重试');
    delete local[local.length - 1].streaming;
    state.pageChat.sending = false;
    render();
  } catch (err) {
    state.pageChat.sending = false;
    local.pop();
    local.pop();
    if (input) input.value = question;
    toast(err.message, 'err');
    render();
  }
}

/* --------------------------- 全屏讲解模式 --------------------------- */

function openPresenter(index = 0) {
  const segs = arr(state.project?.analysis?.narration?.segments);
  if (!segs.length) {
    toast('还没有讲解稿，请先生成分析', 'err');
    return;
  }
  state.presenter.index = Math.max(0, Math.min(index, segs.length - 1));
  state.presenter.slideOffset = 0;
  state.presenter.seconds = 0;
  renderPresenter();
  clearInterval(state.presenter.timer);
  state.presenter.timer = setInterval(() => {
    state.presenter.seconds += 1;
    const el = $('#presTimer');
    if (el) el.textContent = fmtTime(state.presenter.seconds);
  }, 1000);
  document.body.style.overflow = 'hidden';
}

function closePresenter() {
  clearInterval(state.presenter.timer);
  state.presenter.timer = null;
  $('#presenterRoot').innerHTML = '';
  document.body.style.overflow = '';
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function fmtTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderPresenter() {
  const segs = arr(state.project?.analysis?.narration?.segments);
  const i = state.presenter.index;
  const s = segs[i];
  if (!s) return closePresenter();
  const target = slideTarget(s);
  const pdf = target?.file?.previewPdf || '';
  const basePage = target?.page || 1;
  const offset = state.presenter.slideOffset || 0;
  const page = Math.max(1, basePage + offset);
  const pct = ((i + 1) / segs.length) * 100;
  const noShot = target && !pdf ? target.file.previewNote || '这份文件暂时生成不了截图' : '';

  $('#presenterRoot').innerHTML = `
    <div class="presenter">
      <div class="presenter-head">
        <span class="loc">${esc(s.location || `第 ${i + 1} 页`)}</span>
        <h3>${esc(s.title || '')}</h3>
        <span class="timer" id="presTimer">00:00</span>
        <span class="counter">${i + 1} / ${segs.length}</span>
        <button class="btn sm" id="presFs" title="藏掉浏览器界面（真全屏）。按 Esc 会直接退出讲解模式" style="background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.12);color:#e2e8f0">${icon('maximize', 13)}<span id="presFsLabel">真全屏</span></button>
        <button class="btn sm" id="presExit" style="background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.12);color:#e2e8f0">${icon('x', 13)}退出</button>
      </div>
      <div class="presenter-main">
        <div class="presenter-col">
          <div class="col-label">讲解稿${s.scriptEn ? '（上：英文原话　下：中文翻译）' : ''}</div>
          ${
            s.scriptEn
              ? `<div class="script-text en">${esc(s.scriptEn)}</div>
                 <div class="script-zh-tag">中文翻译</div>
                 <div class="script-text">${esc(s.script || '（本页没有讲解稿）')}</div>`
              : `<div class="script-text">${esc(s.script || '（本页没有讲解稿）')}</div>`
          }
          ${
            arr(s.keyPoints).length
              ? `<div class="kp"><h5>必须记住</h5><ul class="clean">${s.keyPoints.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>`
              : ''
          }
          ${s.askClass ? `<div class="ask">${icon('help', 13)} 自问：${esc(s.askClass)}</div>` : ''}
          ${s.board ? `<div class="board-dark">${esc(s.board)}</div>` : ''}
          ${s.transition ? `<div class="transition-row">过渡：${esc(s.transition)}</div>` : ''}
        </div>
        <div class="presenter-col">
          <div class="col-label">课件 · ${esc(target?.file?.originalName || '未匹配到课件')}</div>
          <div class="slide-stage" id="presSlide"></div>
          <div class="slide-bar">
            <button id="presSlidePrev" ${offset <= 0 ? 'disabled' : ''}>${icon('left', 12)}上一页</button>
            <span>第 <b id="presSlideNum">${page}</b> / <span id="presSlideTotal">…</span> 页</span>
            <button id="presSlideNext">下一页${icon('right', 12)}</button>
            <span class="spacer"></span>
            <span>${esc(noShot)}</span>
          </div>
          ${topicStrip(i)}
        </div>
      </div>
      <div class="presenter-foot">
        <button id="presPrev" ${i === 0 ? 'disabled' : ''}>${icon('left', 13)}上一段</button>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <button id="presNext" ${i === segs.length - 1 ? 'disabled' : ''}>下一段${icon('right', 13)}</button>
      </div>
      ${renderPageChat(i)}
    </div>`;

  $('#presExit').addEventListener('click', closePresenter);
  $('#presFs').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else $('.presenter')?.requestFullscreen?.().catch(() => toast('浏览器不允许全屏', 'err'));
  });
  const fsLabel = $('#presFsLabel');
  if (fsLabel) fsLabel.textContent = document.fullscreenElement ? '退出全屏' : '真全屏';
  $('#presPrev').addEventListener('click', () => goPresenter(-1));
  $('#presNext').addEventListener('click', () => goPresenter(1));

  // 课件翻页（在同一段讲解里自由前后翻课件）
  const flip = (d) => {
    const next = Math.max(0, (state.presenter.slideOffset || 0) + d);
    state.presenter.slideOffset = next;
    renderPresenter();
  };
  $('#presSlidePrev').addEventListener('click', () => flip(-1));
  $('#presSlideNext').addEventListener('click', () => flip(1));
  // 点「同主题」里的某一段就直接跳过去
  $$('[data-topic-jump]').forEach((el) =>
    el.addEventListener('click', () => {
      const n = Number(el.dataset.topicJump);
      if (Number.isFinite(n) && n !== state.presenter.index) openPresenter(n);
    }),
  );

  wirePageChat();
  // 全屏讲解里刻意不做课件放大：这里课件已是主角，再放大反而盖住讲解稿
  mountSlide($('#presSlide'), pdf, page, { width: 1500 });
  slideCount(pdf).then((total) => {
    const el = $('#presSlideTotal');
    if (el) el.textContent = total || '?';
    const nx = $('#presSlideNext');
    if (nx && total && page >= total) nx.disabled = true;
  });


}

/**
 * 课件原图悬停放大 —— **只在非全屏的标签页里生效**。
 *
 * 效果是「整张图**浮起来**」：放大 1.5 倍、带投影浮在页面之上压住下边的卡片，
 * 页面其它部分一点都不动，移开就还原。
 *
 * 只做 scale、不做位移：transform-origin 本来就是 center，
 * 所以放大前后的中心位置完全一致。以前那套 translate + scale（把图搬到屏幕正中间、
 * 放大 2 倍）已经去掉了 —— 用户要的是「原地长大一点」，不是「换个地方看大图」。
 *
 * 光有 transform 还不够，`.slide-stage` 自带的 overflow: hidden 会把放大的部分裁掉
 * （尺寸算出来是大了，看到的还是那一小块），所以 .lifted 那句还要放开 overflow，
 * 见 styles.css。
 *
 * 全屏讲解里不做放大：那里课件已是主角，再放大反而盖住讲解稿。
 * 用事件委托挂在 document 上：缩略图是异步渲染出来的，逐个绑定会漏。
 * 触屏没有 hover，改成点一下浮起、再点一下还原；触摸后浏览器补发的 mouseover
 * 必须屏蔽掉，否则「点开」会被紧跟的 click 立刻收回，表现成点了没反应。
 */
function wireSlideZoom() {
  const stageOf = (target) => target?.closest?.('.tab-body .slide-stage');

  const raise = (stage) => {
    const img = stage.querySelector('.slide-img');
    if (!img || img.dataset.lifted === '1') return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 只放大、不位移：transform-origin 就是 center，
    // 所以放大前后的中心位置完全一致（不做 translate，也不改 transform-origin）。
    img.dataset.lifted = '1';
    img.style.transform = 'scale(1.5)';
    stage.classList.add('lifted');
  };

  const drop = (stage) => {
    const img = stage?.querySelector?.('.slide-img');
    if (!img || img.dataset.lifted !== '1') return;
    delete img.dataset.lifted;
    img.style.transform = '';
    stage.classList.remove('lifted');
  };

  const dropAll = (except) => {
    document.querySelectorAll('.tab-body .slide-stage.lifted').forEach((s) => {
      if (s !== except) drop(s);
    });
  };

  // 触屏上浏览器会在手指离开后补发一串鼠标事件（mouseover → click）。
  // 如果 hover 逻辑也响应，就会「刚点开放大、紧接着又被自己收回」，
  // 表现成点了没反应。所以记下触摸时刻，触摸后短时间内只认点击。
  const TOUCH_GRACE = 900;
  let lastTouch = -1e9;
  const fromTouch = () => Date.now() - lastTouch < TOUCH_GRACE;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') lastTouch = Date.now();
  }, true);

  document.addEventListener('mouseover', (e) => {
    if (fromTouch()) return;
    const stage = stageOf(e.target);
    dropAll(stage);
    if (stage) raise(stage);
  });
  document.addEventListener('mouseout', (e) => {
    if (fromTouch()) return;
    const stage = stageOf(e.target);
    if (!stage) return;
    // 还在同一张图里挪动就不还原
    if (e.relatedTarget && stage.contains(e.relatedTarget)) return;
    drop(stage);
  });

  document.addEventListener('click', (e) => {
    if (!fromTouch()) return;
    const stage = stageOf(e.target);
    if (!stage) { dropAll(null); return; } // 手指点别处就收回
    if (e.target.closest('button')) return;
    if (stage.classList.contains('lifted')) drop(stage);
    else {
      dropAll(stage);
      raise(stage);
    }
  });
}

/**
 * 当前页「同主题」的那几页。
 *
 * 优先用讲解稿里的 topic 字段（连续几页同主题时，模型会写成同一个词）；
 * 老数据没有 topic 就退回「当前页 ±1」，至少给出上下文。
 */
function sameTopicOf(index) {
  const segs = arr(state.project?.analysis?.narration?.segments);
  const cur = segs[index];
  if (!cur) return null;
  const hasTopic = segs.some((s) => String(s.topic || '').trim());
  const keyOf = (s) => String(s.topic || s.title || '').trim();
  const key = keyOf(cur);

  let from = index;
  let to = index;
  if (hasTopic && key) {
    while (from > 0 && keyOf(segs[from - 1]) === key) from--;
    while (to < segs.length - 1 && keyOf(segs[to + 1]) === key) to++;
  } else {
    from = Math.max(0, index - 1);
    to = Math.min(segs.length - 1, index + 1);
  }
  const items = [];
  for (let i = from; i <= to; i++) items.push({ i, s: segs[i] });
  return { key: hasTopic ? key : '相邻内容', items, byTopic: hasTopic && Boolean(key) };
}

function topicStrip(index) {
  const g = sameTopicOf(index);
  if (!g || g.items.length < 2) return '';
  return `
    <div class="topic-strip">
      <div class="ts-head">
        ${icon('route', 12)}
        <span>${g.byTopic ? '同一主题' : '上下文'}</span>
        <b>${esc(g.key)}</b>
        <span class="ts-range">第 ${g.items[0].i + 1}–${g.items[g.items.length - 1].i + 1} 段</span>
      </div>
      <ul class="ts-list">
        ${g.items
          .map(
            (x) => `<li class="ts-item ${x.i === index ? 'cur' : ''}" data-topic-jump="${x.i}" title="跳到第 ${x.i + 1} 段">
            <span class="ts-loc">${esc(x.s.location || `第 ${x.i + 1} 页`)}</span>
            <span class="ts-title">${esc(x.s.title || '')}</span>
          </li>`,
          )
          .join('')}
      </ul>
    </div>`;
}

function goPresenter(delta) {
  const segs = arr(state.project?.analysis?.narration?.segments);
  const next = state.presenter.index + delta;
  if (next < 0 || next >= segs.length) return;
  state.presenter.index = next;
  state.presenter.slideOffset = 0; // 换段就回到该段对应的课件页
  renderPresenter();
}

/* --------------------------- 5. 课件问答 --------------------------- */

function renderChat() {
  const chat = state.project?.chat || [];
  const suggestions = [
    '用一句话概括这份课件的核心内容',
    '这份课件里最难的知识点是哪个？为什么难？',
    '帮我出一道考察本课件重点的随堂测题，并给答案',
    '如果我只有 10 分钟复习，应该看哪几页？',
  ];
  $('#tabBody').innerHTML = `
    <div class="chat-wrap">
      <div class="chat-log" id="chatLog">
        ${
          chat.length
            ? chat.map((m) => msgHtml(m.role, m.content)).join('')
            : `<div class="empty" style="margin-top:6vh">
                <div class="big">${icon('chat', 46)}</div>
                <h2>就这份课件提问</h2>
                <p>回答只依据你上传的课件内容，并会告诉你答案在第几页。</p>
              </div>`
        }
      </div>
      <div class="suggest" id="suggestRow">${suggestions.map((s) => `<button data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <div class="chat-input-row">
        <textarea id="chatInput" rows="2" placeholder="输入你的问题，Enter 发送，Shift+Enter 换行"></textarea>
        <button class="btn primary" id="chatSend">发送</button>
      </div>
    </div>`;

  const input = $('#chatInput');
  const send = () => askChat(input.value.trim());
  $('#chatSend').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $$('#suggestRow button').forEach((b) =>
    b.addEventListener('click', () => {
      input.value = b.dataset.q;
      send();
    }),
  );
  scrollChat();
}

/** 有些模型会把回答包成 {"answer": "..."}，这里兜底拆开 */
function normalizeAnswer(text) {
  const s = String(text ?? '').trim();
  if (!s.startsWith('{')) return s;
  try {
    const obj = JSON.parse(s);
    for (const key of ['answer', 'content', 'reply', 'text', 'response', 'result']) {
      if (typeof obj[key] === 'string') return obj[key];
    }
  } catch {
    /* 不是完整 JSON，原样返回 */
  }
  return s;
}

function msgHtml(role, content) {
  const isUser = role === 'user';
  return `<div class="msg ${isUser ? 'user' : 'assistant'}">
    <span class="avatar">${isUser ? '我' : 'AI'}</span>
    <div class="bubble">${isUser ? esc(content).replace(/\n/g, '<br>') : mdToHtml(stripAiMarks(normalizeAnswer(content)))}</div>
  </div>`;
}

function scrollChat() {
  const log = $('#chatLog');
  if (log) log.scrollTop = log.scrollHeight;
}

async function askChat(question) {
  if (!question || state.chatStreaming) return;
  if (!state.project?.files?.length) {
    toast('请先上传课件', 'err');
    return;
  }
  state.chatStreaming = true;
  const input = $('#chatInput');
  input.value = '';
  const log = $('#chatLog');
  if (log.querySelector('.empty')) log.innerHTML = '';
  log.insertAdjacentHTML('beforeend', msgHtml('user', question));
  const holder = document.createElement('div');
  holder.innerHTML = msgHtml('assistant', '');
  const bubble = holder.querySelector('.bubble');
  bubble.innerHTML = SPIN_SVG + '正在查阅课件…';
  log.appendChild(holder.firstElementChild);
  scrollChat();

  let answer = '';
  let raf = null;
  const paint = () => {
    bubble.innerHTML = mdToHtml(stripAiMarks(answer)) + '<span style="opacity:.4">▌</span>';
    scrollChat();
  };
  try {
    await postSSE(`/api/projects/${state.project.id}/chat`, { question }, (evt) => {
      if (evt.type === 'delta') {
        answer += evt.text;
        if (!raf) raf = requestAnimationFrame(() => { raf = null; paint(); });
      } else if (evt.type === 'fatal') {
        throw new Error(evt.message);
      }
    });
    bubble.innerHTML = mdToHtml(stripAiMarks(answer)) || '<i>（没有返回内容）</i>';
    state.project.chat = state.project.chat || [];
    state.project.chat.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
  } catch (err) {
    bubble.innerHTML = `<span style="color:var(--danger)">出错了：${esc(err.message)}</span>`;
    toast(err.message, 'err');
  } finally {
    state.chatStreaming = false;
    scrollChat();
  }
}

/* --------------------------- 分析流程 --------------------------- */

/**
 * 跑分析。
 * @param {string[]} [stages] 只生成这些模式；不传 = 全都生成（老行为）
 */
async function runAnalysis(stages, langMode = 'zh') {
  if (!state.project?.files?.length) return;
  if (!state.project.isMine) {
    toast('这是公开的演示项目，只能查看。请点左侧「新建」建立自己的项目。', 'err');
    return;
  }
  if (!hasUsableKey()) {
    openGate('分析课件需要 API Key');
    return;
  }
  const want = arr(stages).length ? stages : stageCatalog().map((s) => s.key);
  state.view = 'analyzing';
  state.progress = 0;
  // 对照模式要跑两遍，进度里先说清楚，别让人以为卡住了
  state.passLabel = langMode === 'bilingual' ? '准备中 · 中英各一遍' : '';
  // 进度列表按目录顺序列全，没勾的标成 skipped，用户能一眼看出「这次跳过了什么」
  state.stages = stageCatalog().map((s) => ({
    key: s.key,
    label: s.label,
    status: want.includes(s.key) ? 'pending' : 'skipped',
    message: want.includes(s.key) ? '' : '未勾选，已跳过',
  }));
  state.tab = 'overview';
  render();

  const t0 = Date.now();
  try {
    await postSSE(
      `/api/projects/${state.project.id}/analyze`,
      { name: state.project.name, stages: want, langMode, readPagesMode: readModeOfClient() },
      (evt) => {
      if (evt.type === 'start') {
        state.stages.forEach((s) => {
          if (s.status !== 'skipped') s.status = 'pending';
        });
        render();
      } else if (evt.type === 'pass') {
        // 对照模式要跑两遍，进度里标出来现在跑的是哪一遍
        state.passLabel = `第 ${evt.index}/${evt.total} 遍 · ${evt.passLabel}`;
        state.stages.forEach((s) => {
          if (s.status !== 'skipped') {
            s.status = 'pending';
            s.ms = 0;
            s.detail = '';
          }
        });
        render();
      } else if (evt.type === 'stage') {
        const s = state.stages.find((x) => x.key === evt.stage);
        if (s) {
          s.status = evt.status;
          s.ms = evt.ms;
          if (evt.message) s.message = evt.message;
        }
        state.progress = evt.progress ?? state.progress;
        render();
      } else if (evt.type === 'stage-detail') {
        const s = state.stages.find((x) => x.key === evt.stage);
        if (s) s.detail = evt.message;
        render();
      } else if (evt.type === 'saved') {
        state.project = evt.project;
      } else if (evt.type === 'fatal') {
        throw new Error(evt.message);
      }
    });
    if (!state.project.analysis) state.project = await api(`/api/projects/${state.project.id}`);
    state.view = 'done';
    const errs = arr(state.project.analysis?.errors);
    if (errs.length) toast(`完成，但有 ${errs.length} 个环节失败`, 'err');
    else toast(`分析完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`, 'ok');
  } catch (err) {
    state.view = state.project.analysis ? 'done' : 'ready';
    toast(err.message, 'err');
  }
  render();
}

/* --------------------------- 上传 / 文件操作 --------------------------- */

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const box = $('#uploadProgress');
  box.innerHTML = files
    .map((f) => `<div class="upload-item" data-n="${esc(f.name)}">${SPIN_SVG}${esc(f.name)}</div>`)
    .join('');
  try {
    const result = await uploadWithProgress(state.project.id, files, (pct) => {
      box.querySelectorAll('.upload-item').forEach((el) => {
        el.innerHTML = SPIN_SVG + `${esc(el.dataset.n)} — ${Math.round(pct * 100)}%`;
      });
    });
    const okCount = result.added?.length || 0;
    const failCount = result.failed?.length || 0;
    if (okCount) toast(`成功解析 ${okCount} 个文件`, 'ok');
    for (const f of result.failed || []) toast(`${f.originalName}：${f.error}`, 'err');
    if (!okCount && failCount) toast('没有文件被成功解析', 'err');
    state.project = result.project || (await api(`/api/projects/${state.project.id}`));
    if (okCount && state.project.analysis) state.project.analysisStale = true;
    syncView();
    if (state.view === 'done' && okCount) state.view = 'done';
    render();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    box.innerHTML = '';
  }
}

async function deleteFile(id) {
  try {
    const res = await api(`/api/projects/${state.project.id}/files/${id}`, { method: 'DELETE' });
    state.project = res.project;
    syncView();
    render();
    toast('已移除文件');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function viewExtracted(id) {
  try {
    const data = await api(`/api/projects/${state.project.id}/files/${id}/text`);
    const blocks = data.blocks || [];
    openModal(`
      <h3>${esc(data.originalName)}</h3>
      <p class="hint">这是平台从文件里实际提取到的文字（模型看到的就是这些）。共 ${blocks.length} 个段落。若内容明显缺失，说明该文件可能是扫描版或纯图片。</p>
      <div style="max-height:52vh;overflow:auto;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:14px;font-size:12.5px;line-height:1.8;white-space:pre-wrap">${blocks
        .map((b) => `<div style="margin-bottom:12px"><b style="color:var(--brand);font-size:11.5px">[${esc(b.label)}]</b><br>${esc(b.text)}</div>`)
        .join('')}</div>
      <div class="modal-actions"><button class="btn" data-close>关闭</button></div>
    `);
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* --------------------------- 弹窗 / 设置 --------------------------- */

function openModal(html, { dismissible = true, wide = false } = {}) {
  $('#modalRoot').innerHTML = `<div class="modal-mask"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
  $$('#modalRoot [data-close]').forEach((b) => b.addEventListener('click', closeModal));
  if (dismissible) {
    $('#modalRoot .modal-mask').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-mask')) closeModal();
    });
  }
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
  state.gateOpen = false;
}

/**
 * 轻量输入框（代替原生 prompt —— 原生 prompt 不能带说明文字，样式也突兀）。
 * 返回 Promise<string|null>，取消时 resolve(null)。
 */
function promptText({ title = '请输入', label = '', value = '', placeholder = '', hint = '' } = {}) {
  return new Promise((resolve) => {
    openModal(
      `<h3>${esc(title)}</h3>
       ${label ? `<label class="field-label">${esc(label)}</label>` : ''}
       <input type="text" id="promptInput" class="text-input" value="${esc(value)}" placeholder="${esc(placeholder)}">
       ${hint ? `<p class="prompt-hint">${esc(hint)}</p>` : ''}
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="promptOk">确定</button>
       </div>`,
    );
    const input = $('#promptInput');
    input.focus();
    input.select();
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    $('#promptOk').addEventListener('click', () => done(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });
    $$('#modalRoot [data-close]').forEach((b) => b.addEventListener('click', () => resolve(null)));
    $('#modalRoot .modal-mask')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-mask')) resolve(null);
    });
  });
}

/** 确认框，返回 Promise<boolean> */
function confirmBox({ title = '确认', body = '', okText = '确定', danger = true } = {}) {
  return new Promise((resolve) => {
    openModal(
      `<h3>${esc(title)}</h3>
       <p style="color:var(--text-2);font-size:13.5px;line-height:1.8">${body}</p>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn ${danger ? 'danger' : 'primary'}" id="confirmOk">${esc(okText)}</button>
       </div>`,
    );
    let answered = false;
    const done = (v) => {
      if (answered) return;
      answered = true;
      closeModal();
      resolve(v);
    };
    $('#confirmOk').addEventListener('click', () => done(true));
    $$('#modalRoot [data-close]').forEach((b) => b.addEventListener('click', () => done(false)));
    $('#modalRoot .modal-mask')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-mask')) done(false);
    });
  });
}

/* --------------------------- API Key 引导页 & 设置 --------------------------- */

const PROVIDER_FALLBACK = [
  {
    id: 'deepseek',
    name: 'DeepSeek（推荐）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '便宜、中文好，注册后在「API Keys」页面创建。',
  },
  {
    id: 'custom',
    name: '自定义（其他 OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
    keyUrl: '',
    note: '填入自己的接口地址与模型名。',
  },
];

function providers() {
  return arr(state.config?.providers).length ? state.config.providers : PROVIDER_FALLBACK;
}

function currentProvider() {
  return providers().find((p) => p.id === state.providerId) || providers()[0];
}

/**
 * 首次进入的引导页：让访客自己填 API Key，并告诉他到哪里申请。
 * @param {string} reason 可选，说明为什么现在需要 Key
 */
function openGate(reason = '') {
  state.gateOpen = true;
  const cfg = state.config || {};
  const first = providers()[0];
  const demo = (state.config?.hasDemo ?? true) ? `<button class="btn" id="gateDemo">先看看演示项目（不用 Key）</button>` : '';
  openModal(
    `
    <div class="gate">
      <div class="gate-icon">${icon('key', 22)}</div>
      <h3>开始前，请先填入你自己的 API Key</h3>
      <p class="hint">
        ${reason ? `<b style="color:var(--warn)">${esc(reason)}</b><br>` : ''}
        本站不提供也不保存 API Key —— 用的是<b>你自己的账号额度</b>，Key 只保存在你的浏览器里，随请求发给服务器用完即弃。
      </p>

      <div class="gate-steps">
        <div class="gate-step">
          <span class="n">1</span>
          <div>到 <a href="${esc(first.keyUrl)}" target="_blank" rel="noopener">${esc(first.keyUrl)}</a> 注册并创建一个 API Key（形如 <code>sk-...</code>）</div>
        </div>
        <div class="gate-step">
          <span class="n">2</span>
          <div>把 Key 粘贴到下面，点「保存并测试」</div>
        </div>
      </div>

      <div class="field">
        <label>API Key</label>
        <input type="password" id="gateKey" placeholder="sk-..." autocomplete="off" autofocus>
      </div>
      <div class="field">
        <label>服务商</label>
        <select id="gateProvider">
          ${providers()
            .map((p) => `<option value="${esc(p.id)}" ${p.id === state.providerId ? 'selected' : ''}>${esc(p.name)}</option>`)
            .join('')}
        </select>
      </div>
      <div id="gateExtra"></div>
      <div id="gateTestResult"></div>
      <div class="modal-actions" style="justify-content:space-between">
        <div>${demo}</div>
        <div style="display:flex;gap:9px">
          <button class="btn" id="gateLater">稍后再说</button>
          <button class="btn primary" id="gateSave">保存并测试</button>
        </div>
      </div>
      <p class="hint" style="margin:14px 0 0;font-size:11.5px">
        提示：Key 只存在本机浏览器（localStorage）。换台电脑或清空浏览器数据后需要重新填写。
      </p>
    </div>
  `,
    { dismissible: false },
  );

  renderGateExtra();
  $('#gateProvider').addEventListener('change', () => {
    state.providerId = $('#gateProvider').value;
    lsSet(LS.provider, state.providerId);
    renderGateExtra();
  });
  $('#gateSave').addEventListener('click', () => saveKeysFromGate());
  $('#gateLater')?.addEventListener('click', () => {
    state.gateOpen = false;
    closeModal();
  });
  $('#gateDemo')?.addEventListener('click', () => {
    state.gateOpen = false;
    closeModal();
    toast('这是只读的演示项目，想用 AI 功能请填写 API Key', '');
  });
  $('#gateKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveKeysFromGate();
  });
  setTimeout(() => $('#gateKey')?.focus(), 50);
}

/** 自定义服务商时，引导页要多问接口地址和模型名 */
function renderGateExtra() {
  const p = currentProvider();
  const box = $('#gateExtra');
  if (!box) return;
  if (p.id !== 'custom') {
    box.innerHTML = `<p class="hint" style="margin:-4px 0 14px">${esc(p.note || '')}<br>接口：<code>${esc(p.baseUrl)}</code>　默认模型：<code>${esc(p.model)}</code></p>`;
    return;
  }
  box.innerHTML = `
    <div class="field">
      <label>接口地址（OpenAI 兼容，需支持 /chat/completions）</label>
      <input type="text" id="gateBase" value="${esc(state.apiBase || '')}" placeholder="https://your-host/v1">
    </div>
    <div class="field">
      <label>模型名</label>
      <input type="text" id="gateModel" value="${esc(state.apiModel || '')}" placeholder="your-model">
    </div>`;
}

function gateStatus(html) {
  const box = $('#gateTestResult');
  if (box) box.innerHTML = html;
}

async function saveKeysFromGate() {
  const key = ($('#gateKey')?.value || '').trim();
  if (!key) {
    toast('请先填入 API Key', 'err');
    return;
  }
  const p = currentProvider();
  state.providerId = p.id;
  state.apiKey = key;
  state.apiBase = p.id === 'custom' ? ($('#gateBase')?.value || '').trim() : p.baseUrl;
  state.apiModel = p.id === 'custom' ? ($('#gateModel')?.value || '').trim() : p.model;

  const btn = $('#gateSave');
  btn.disabled = true;
  btn.innerHTML = SPIN_SVG + '正在测试…';
  gateStatus('');
  try {
    const r = await api('/api/verify-key', { method: 'POST', body: '{}' });
    persistKeys();
    gateStatus(`<div class="gate-ok">${icon('check', 13)} 连接成功（${esc(r.model)}，${r.ms}ms）</div>`);
    renderConfigChips();
    toast('API Key 已保存并验证通过', 'ok');
    state.gateOpen = false;
    setTimeout(() => {
      closeModal();
      render();
      maybeShowGate();
    }, 700);
  } catch (err) {
    gateStatus(`<div class="gate-err">${icon('x', 13)} ${esc(err.message)}</div>`);
    btn.disabled = false;
    btn.textContent = '保存并测试';
  }
}

function persistKeys() {
  lsSet(LS.key, state.apiKey);
  lsSet(LS.base, state.apiBase);
  lsSet(LS.model, state.apiModel);
  lsSet(LS.provider, state.providerId);
}

function openSettings() {
  const cfg = state.config || {};
  const p = currentProvider();
  openModal(`
    <h3>设置</h3>
    <p class="hint">
      ${
        cfg.hasServerKey && !cfg.publicMode
          ? '本站已内置 API Key，你可以直接用；也可以换成自己的（换成自己的会用自己的额度）。'
          : '填入你自己的 API Key。它只保存在本机浏览器，不会上传到服务器，也不会被服务端保存。'
      }
    </p>
    <div class="field">
      <label>服务商</label>
      <select id="setProvider">
        ${providers()
          .map((x) => `<option value="${esc(x.id)}" ${x.id === state.providerId ? 'selected' : ''}>${esc(x.name)}</option>`)
          .join('')}
      </select>
    </div>
    <div id="setProviderHint"></div>
    <div class="field">
      <label>API Key ${state.apiKey ? '<span style="color:var(--ok)">（已保存，留空表示不改）</span>' : ''}</label>
      <input type="password" id="setKey" placeholder="${state.apiKey ? '••••••••••••' : 'sk-...'}" autocomplete="off">
    </div>
    <div class="field">
      <label>接口地址</label>
      <input type="text" id="setBase" value="${esc(state.apiBase || p.baseUrl || cfg.baseUrl || '')}">
    </div>
    <div class="field">
      <label>模型</label>
      <input type="text" id="setModel" value="${esc(state.apiModel || p.model || cfg.model || '')}">
    </div>
    <div id="setTestResult"></div>
    <div class="modal-actions" style="justify-content:space-between">
      <div>${state.apiKey ? '<button class="btn" id="clearKey">清除我的 Key</button>' : ''}</div>
      <div style="display:flex;gap:9px">
        <button class="btn" data-close>取消</button>
        <button class="btn" id="testKey">测试连接</button>
        <button class="btn primary" id="saveSettings">保存</button>
      </div>
    </div>
  `);

  const hint = () => {
    const sel = providers().find((x) => x.id === $('#setProvider').value) || p;
    $('#setProviderHint').innerHTML = sel.keyUrl
      ? `<p class="hint" style="margin:-4px 0 14px">申请地址：<a href="${esc(sel.keyUrl)}" target="_blank" rel="noopener">${esc(sel.keyUrl)}</a>${sel.note ? `<br>${esc(sel.note)}` : ''}</p>`
      : `<p class="hint" style="margin:-4px 0 14px">${esc(sel.note || '')}</p>`;
    if ($('#setBase').value.trim() === '' && sel.baseUrl) $('#setBase').value = sel.baseUrl;
    if ($('#setModel').value.trim() === '' && sel.model) $('#setModel').value = sel.model;
  };
  hint();

  $('#setProvider').addEventListener('change', () => {
    const sel = providers().find((x) => x.id === $('#setProvider').value);
    $('#setBase').value = sel?.baseUrl || '';
    $('#setModel').value = sel?.model || '';
    hint();
  });

  const collect = () => {
    const sel = providers().find((x) => x.id === $('#setProvider').value) || p;
    return {
      providerId: sel.id,
      apiKey: ($('#setKey').value || '').trim() || state.apiKey,
      apiBase: ($('#setBase').value || '').trim(),
      apiModel: ($('#setModel').value || '').trim(),
    };
  };

  const applyLocal = (v) => {
    state.providerId = v.providerId;
    state.apiKey = v.apiKey;
    state.apiBase = v.apiBase;
    state.apiModel = v.apiModel;
    persistKeys();
    renderConfigChips();
  };

  $('#testKey').addEventListener('click', async () => {
    const v = collect();
    const prev = { ...state };
    Object.assign(state, { providerId: v.providerId, apiKey: v.apiKey, apiBase: v.apiBase, apiModel: v.apiModel });
    $('#testKey').disabled = true;
    $('#setTestResult').innerHTML = '<p class="hint">正在测试…</p>';
    try {
      const r = await api('/api/verify-key', { method: 'POST', body: '{}' });
      $('#setTestResult').innerHTML = `<div class="gate-ok">${icon('check', 13)} 连接成功（${esc(r.model)}，${r.ms}ms）</div>`;
    } catch (err) {
      $('#setTestResult').innerHTML = `<div class="gate-err">${icon('x', 13)} ${esc(err.message)}</div>`;
      Object.assign(state, { apiKey: prev.apiKey, apiBase: prev.apiBase, apiModel: prev.apiModel, providerId: prev.providerId });
    } finally {
      $('#testKey').disabled = false;
    }
  });

  $('#saveSettings').addEventListener('click', () => {
    const v = collect();
    if (keyRequired() && !v.apiKey) {
      toast('请填入 API Key', 'err');
      return;
    }
    applyLocal(v);
    closeModal();
    state.gateOpen = false;
    toast('设置已保存', 'ok');
    render();
  });

  $('#clearKey')?.addEventListener('click', () => {
    state.apiKey = '';
    state.apiBase = '';
    state.apiModel = '';
    persistKeys();
    renderConfigChips();
    closeModal();
    toast('已清除本机保存的 API Key');
    maybeShowGate();
  });
}


/* --------------------------- 事件绑定 --------------------------- */

function wireStaticEvents() {
  const dz = $('#dropzone');
  const input = $('#fileInput');

  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    handleFiles(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('drag');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('drag');
    }),
  );
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  // 整页拖拽也接受
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length && !e.target.closest('#dropzone')) handleFiles(e.dataTransfer.files);
  });

  $('#analyzeBtn').addEventListener('click', openAnalyzeModal);
  $('#exportBtn').addEventListener('click', () => {
    if (!state.project?.analysis) return;
    if (IS_STATIC) {
      window.CWBackend.downloadExport(state.project.id);
      return;
    }
    window.location.href = `/api/projects/${state.project.id}/export.md`;
  });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#packBtn')?.addEventListener('click', exportCurrentProject);
  $('#unpackBtn')?.addEventListener('click', () => $('#importInput')?.click());
  $('#importInput')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) importBundleFile(f);
  });
  $('#themeBtn').addEventListener('click', toggleTheme);
  applyTheme(currentTheme());
  wireInstall();
  wireSlideZoom();

  // 手机端：侧栏是抽屉，点左上角按钮滑出，点遮罩或选中项目后收起
  const closeNav = () => $('.app')?.classList.remove('nav-open');
  const navBtn = $('#navBtn');
  if (navBtn) {
    navBtn.innerHTML = icon('list', 16);
    navBtn.addEventListener('click', () => $('.app')?.classList.toggle('nav-open'));
  }
  $('#navScrim')?.addEventListener('click', closeNav);
  // 点了某个项目就切过去，抽屉这时候应该让位给内容
  $('#groupList')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-proj]')) setTimeout(closeNav, 0);
  });

  $('#newProjectBtn').addEventListener('click', () => newProjectUI());
  $('#newGroupBtn').addEventListener('click', newGroupUI);
  wireGroups();
  wireDock();

  $('#fileList').addEventListener('click', (e) => {
    // 点类别标签 → 打开「这份材料算什么」面板
    const tag = e.target.closest('[data-role]');
    if (tag) {
      e.stopPropagation();
      openRolePicker(tag.dataset.role);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'del') deleteFile(btn.dataset.id);
    if (btn.dataset.act === 'view') viewExtracted(btn.dataset.id);
  });

  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab || tab.disabled) return;
    state.tab = tab.dataset.tab;
    if (location.hash !== `#${state.tab}`) history.replaceState(null, '', `#${state.tab}`);
    render();
  });

  window.addEventListener('hashchange', () => {
    const h = location.hash.replace(/^#/, '');
    if (h === 'present') return openPresenter(0);
    if (TABS.some((t) => t.id === h) && h !== state.tab && state.view === 'done') {
      state.tab = h;
      render();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!$('.presenter')) return;
    if (e.key === 'Escape') {
      // Esc 的语义是「退出全屏讲解」。讲解模式本身是一个铺满视口的浮层，
      // 不依赖浏览器的 Fullscreen API，所以这里直接关掉它就对了。
      e.preventDefault();
      closePresenter();
    } else if (['ArrowRight', ' ', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      goPresenter(1);
    } else if (['ArrowLeft', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      goPresenter(-1);
    } else if (e.key === 'f' || e.key === 'F') {
      // 真·全屏（藏掉浏览器界面）是额外选项，不是进入讲解模式的必要条件
      if (document.fullscreenElement) document.exitFullscreen?.();
      else $('.presenter')?.requestFullscreen?.().catch(() => {});
    }
  });

  // 在真·全屏下按 Esc，浏览器会先把全屏收掉（这个事件收不到按键），
  // 于是用户会觉得「只退出了大屏、没退出讲解」。这里补一刀：一旦离开全屏，
  // 讲解模式也一起收掉，保证一次 Esc 就能回到普通界面。
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && $('.presenter')) closePresenter();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#modalRoot').innerHTML) closeModal();
  });
}

init().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message}`, 'err');
});
