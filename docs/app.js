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
function apiHeaders() {
  const h = { 'Content-Type': 'application/json' };
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
      releasedAt: v.releasedAt || '',
      history: arr(v.history),
      // 页面刚加载时，当前版本就是「我这一页的版本」
      loaded: initial || !prev ? v.version : prev.loaded,
      // 远端（GitHub）上的版本，由服务端后台去拉，拉不到就是空的
      remote: v.remote || null,
    };
    renderVersionChip();
    if (!initial && prev && prev.current !== v.version) {
      toast(`平台已更新到 ${v.version}，点右上角版本号查看更新内容`, 'ok');
    }
    // 远端出现比本地更新的版本时提示一次（同一条只提示一次，别每 45 秒烦人）
    const rv = state.version.remote?.version;
    if (!initial && rv && compareVersion(rv, v.version) > 0 && state.versionNotice !== rv) {
      state.versionNotice = rv;
      toast(`GitHub 上已有新版本 v${rv}，点右上角版本号看更新内容`, 'ok');
    }
  } catch {
    /* 拿不到就当作没有版本信息，不打扰用户 */
  }
}

/** 右上角该显示什么状态：page = 我这一页旧了；remote = GitHub 上有新版；ok */
function versionChipState() {
  const v = state.version;
  if (!v?.current) return { kind: 'none' };
  const pageStale = Boolean(v.loaded) && v.loaded !== v.current;
  const rv = v.remote?.version || '';
  const remoteNewer = Boolean(rv) && compareVersion(rv, v.current) > 0;
  // 页面旧了就先解决页面（点一下就能好）；否则看远端有没有新版
  if (pageStale) return { kind: 'page', from: v.loaded, to: v.current };
  if (remoteNewer) return { kind: 'remote', from: v.current, to: rv };
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
    el.textContent = `v${s.from} → v${s.to}`;
    el.title = `GitHub 上已发布 v${s.to}，点一下看更新内容`;
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
  if (!rv || compareVersion(rv, v.current) <= 0) return [];
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

  // 二、GitHub 上有更新的版本 —— 自建部署需要自己去拉代码
  if (s.kind === 'remote' || remotePending.length) {
    parts.push(`<div class="update-remote">
      <p style="color:var(--ink-2);font-size:13.5px;margin:0 0 4px">
        GitHub 上已发布 <b>v${esc(remote.version)}</b>，你这边是 <b>v${esc(v.current)}</b>。
        这份部署是你自己跑的，需要你手动拉一次代码。
      </p>
      <div class="changelog">${remotePending.map(block).join('') || `<p style="color:var(--ink-4)">（远端没有给出更新说明）</p>`}</div>
      <div class="cmd-box">
        <div class="cmd-lbl">在你的项目目录里执行</div>
        <code>git pull</code>
        <code># 然后重启服务（Ctrl+C 后重新 npm start）</code>
      </div>
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
       ${s.kind === 'page' ? `<button class="btn primary" id="doUpdate">${icon('download', 13)}更新平台</button>` : ''}
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
function doUpdate() {
  const v = state.version?.current || Date.now();
  const { pathname, hash } = window.location;
  window.location.replace(`${pathname}?v=${encodeURIComponent(v)}${hash}`);
}

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
  { id: 'guide', label: '教学应用', icon: 'compass' },
  { id: 'narration', label: '逐页讲解', icon: 'mic' },
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
    ${m.content ? `<div class="dock-bubble">${isUser ? esc(m.content) : mdToHtml(m.content)}</div>` : ''}
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
      box.innerHTML = mdToHtml(local[local.length - 1].content);
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
    { role: 'courseware', label: '课件', desc: '讲义、PPT、教材章节。', feeds: '课件分析 · 事例讲解 · 教学应用 · 逐页讲解' },
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
      } else if (act.dataset.gact === 'add') newProjectUI(id);
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

function renderTabs() {
  const enabled = state.view === 'done';
  $('#tabs').innerHTML = TABS.map(
    (t) => `<button class="tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}" ${enabled ? '' : 'disabled style="opacity:.45"'}>${t.label}</button>`,
  ).join('');
  const stale = state.project?.analysisStale && state.project?.analysis;
  $('#tabs').insertAdjacentHTML(
    'beforeend',
    `<div class="spacer"></div>${stale ? `<span class="chip warn">${icon(alert, 12)}文件已变动，建议重新生成</span>` : ''}`,
  );
}

function renderBody() {
  // 正文要被整体替换，上一轮登记的拖拽 key 全部作废
  dndStore.clear();
  const body = $('#tabBody');
  if (state.view === 'empty') {
    body.innerHTML = `
      <div class="empty">
        <div class="big">${icon('book', 46)}</div>
        <h2>把课件交给我，我给你一份能直接上课的讲解方案</h2>
        <p>支持 PDF、PPTX、DOCX、TXT、Markdown、CSV、XLSX 等格式，可一次上传多个文件。</p>
        <ol>
          <li>把课件文件拖进左侧上传区</li>
          <li>点击「开始讲解分析」</li>
          <li>得到 <b>课件内容分析</b>、<b>事例讲解</b>、<b>教学应用方案</b>、<b>逐页讲解稿</b>、<b>练习题</b>、<b>实验（Lab）</b></li>
          <li>用「全屏讲解模式」照着讲；学生可在「做题」「做lab」里直接作答并得到批改</li>
          <li>导出 Markdown 改教案</li>
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
        <p>点击左下角 <b>「开始讲解分析」</b>，我会读完整份课件，产出内容分析、事例讲解、教学应用方案和逐页讲解稿。</p>
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
  if (state.tab === 'overview') inner = renderOverview(a.analysis);
  else if (state.tab === 'examples') inner = renderExamples(a.examples);
  else if (state.tab === 'guide') inner = renderGuide(a.guide, a.analysis);
  else if (state.tab === 'combine') inner = renderCombine();
  else if (state.tab === 'narration') inner = renderNarration(a.narration);
  else if (state.tab === 'quiz') inner = renderQuiz(a.quiz);
  else if (state.tab === 'lab') inner = renderLab(a.lab);
  else if (state.tab === 'chat') {
    renderChat();
    return;
  }
  const stageMap = {
    overview: 'analysis',
    examples: 'examples',
    guide: 'guide',
    narration: 'narration',
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
  const demoBar = mine
    ? ''
    : `<div class="demo-bar">
         <span>${icon('users', 14)} 你正在浏览<b>公开演示项目</b>（只读）。里面的内容是用别人的课件生成的，可以直接体验讲解模式、做题和做 Lab。</span>
         <button class="btn sm primary" id="demoOwn">建立我自己的项目 →</button>
       </div>`;
  body.innerHTML = `<div class="panel">${demoBar}${banner}${staleBar}${rerunBar}${inner}</div>`;

  // 被跳过的节只挂一个「只生成这一节」按钮，别的交互都没东西可挂
  const genBtn = $('#genThisStage');
  if (genBtn) {
    genBtn.addEventListener('click', () => rerunStageUI(genBtn.dataset.stage, genBtn));
    $('#demoOwn')?.addEventListener('click', () => switchToOwnProject(true));
    return;
  }

  if (state.tab === 'narration') wireNarration();
  else if (state.tab === 'combine') wireCombine();
  else if (state.tab === 'quiz') wireQuiz();
  else if (state.tab === 'lab') wireLab();
  const rb = $('#rerunBtn');
  if (rb) rb.addEventListener('click', () => rerunStageUI(rb.dataset.stage, rb));
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
      body: JSON.stringify({ stage }),
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
      <h2 style="margin:0 0 6px;font-size:19px">正在读你的课件…</h2>
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
    { key: 'guide', label: '教学应用', desc: '生成课堂流程、时间分配、互动设计。' },
    { key: 'narration', label: '逐页讲解稿', desc: '每一页写一段可以照着念的讲稿。' },
    { key: 'quiz', label: '练习题', desc: '整理出可以做的题，附答案与解析。' },
    { key: 'lab', label: '做 Lab', desc: '把实验整理成可以照着做的分步实验。' },
  ];
}

function stageLabelOf(key) {
  return stageCatalog().find((s) => s.key === key)?.label || key;
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

  const syncGo = () => {
    const n = selected().length;
    const go = $('#stageGo');
    if (!go) return;
    go.disabled = n === 0;
    go.innerHTML = n ? `${icon('play', 13)}开始生成（${n} 项）` : '至少勾一项';
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
    closeModal();
    runAnalysis(keys);
  });
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
      <p style="margin:0;color:var(--text-2);font-size:13.5px">每个事例都拆成了「题目 → 分步讲解 → 通用方法 → 易错点 → 板书」，可以直接照着讲。</p>
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
              <div><h5>${esc(s.title)}</h5><p>${esc(s.detail)}</p></div>
            </div>`,
                )
                .join('')}</div>`
            : ''
        }
        ${e.method ? `<div class="note-box"><b>通用方法：</b>${esc(e.method)}</div>` : ''}
        ${e.answer ? `<div class="answer"><b>答案 / 结论：</b>${esc(e.answer)}</div>` : ''}
        ${arr(e.keyPoints).length ? `<div style="margin-top:14px"><b style="font-size:13px">关键点</b>${listHtml(e.keyPoints)}</div>` : ''}
        ${arr(e.pitfalls).length ? `<div class="note-box"><b>易错点</b>${listHtml(e.pitfalls, '')}</div>` : ''}
        ${e.board ? `<div class="board-box"><span class="lbl">板书</span>${esc(e.board)}</div>` : ''}
      </div>
    </div>`;
      })
      .join('')
  );
}

/* --------------------------- 3. 教学应用 --------------------------- */

function renderGuide(g) {
  if (!g) return `<div class="note-box">教学应用方案没有生成成功，可以重试。</div>`;
  const flow = arr(g.lessonFlow);
  const totalMin = flow.reduce((n, f) => n + (Number(f.minutes) || 0), 0);

  const flowCard = flow.length
    ? `<div class="card">
        <h3><span class="num">1</span>课堂流程${totalMin ? `（合计约 ${totalMin} 分钟）` : ''}</h3>
        <div style="overflow-x:auto">
        <table class="flow-table">
          <thead><tr><th>环节</th><th>用时</th><th>课件位置</th><th>教师做什么</th><th>学生做什么</th><th>课件怎么用</th></tr></thead>
          <tbody>
            ${flow
              .map(
                (f) => `<tr>
              <td class="phase">${esc(f.phase)}</td>
              <td class="mins">${esc(f.minutes ?? '—')}′</td>
              <td class="mins">${esc(f.location || '—')}</td>
              <td>${esc(f.teacherAction || '—')}</td>
              <td>${esc(f.studentAction || '—')}</td>
              <td>${esc(f.howToUseCourseware || '—')}</td>
            </tr>`,
              )
              .join('')}
          </tbody>
        </table>
        </div>
        ${
          flow.some((f) => f.script)
            ? `<div style="margin-top:16px"><b style="font-size:13px">${icon('mic', 13)} 教师口播讲稿（可直接照着念）</b>
                ${flow
                  .filter((f) => f.script)
                  .map(
                    (f) => `<div class="stem" style="margin-top:10px;margin-bottom:0">
                    <span class="lbl">${esc(f.phase)}${f.location ? ` · ${esc(f.location)}` : ''}</span>${esc(f.script)}</div>`,
                  )
                  .join('')}
              </div>`
            : ''
        }
      </div>`
    : '';

  const questions = arr(g.questions).length
    ? `<div class="card">
        <h3><span class="num">2</span>课堂提问设计</h3>
        ${g.questions
          .map(
            (q, i) => `<div class="qa-item">
            <div class="q"><span class="n">${i + 1}</span><span>${esc(q.question)}</span></div>
            <div class="a">参考回答：${esc(q.answer || '—')}</div>
            <div class="p">目的：${esc(q.purpose || '—')}${q.location ? ` ｜ 对应 ${esc(q.location)}` : ''}</div>
          </div>`,
          )
          .join('')}
      </div>`
    : '';

  const activities = arr(g.activities).length
    ? `<div class="card">
        <h3><span class="num">3</span>课堂活动</h3>
        ${g.activities
          .map(
            (a) => `<div class="concept">
            <b>${esc(a.name)}</b> <span style="font-size:12px;color:var(--text-3)">${esc(a.duration || '')}</span>
            ${arr(a.steps).length ? `<div style="margin-top:8px">${listHtml(a.steps, '')}</div>` : ''}
            ${a.materials ? `<p style="font-size:12.5px;color:var(--text-3)">材料：${esc(a.materials)}</p>` : ''}
          </div>`,
          )
          .join('')}
      </div>`
    : '';

  const hw = g.homework
    ? `<div class="card">
        <h3><span class="num">4</span>作业布置</h3>
        <div class="grid-2">
          <div><b style="font-size:13px;color:var(--ok)">必做</b>${listHtml(g.homework.basic)}</div>
          <div><b style="font-size:13px;color:var(--warn)">选做 / 拓展</b>${listHtml(g.homework.advanced)}</div>
        </div>
      </div>`
    : '';

  const diff = g.differentiation
    ? `<div class="card">
        <h3><span class="num">5</span>分层教学</h3>
        <div class="concept"><b>基础薄弱的学生</b><p>${esc(g.differentiation.struggling || '—')}</p></div>
        <div class="concept"><b>中等水平的学生</b><p>${esc(g.differentiation.average || '—')}</p></div>
        <div class="concept"><b>学有余力的学生</b><p>${esc(g.differentiation.advanced || '—')}</p></div>
      </div>`
    : '';

  const assessment = arr(g.assessment).length
    ? `<div class="card"><h3><span class="num">6</span>学习效果检验</h3>${listHtml(g.assessment)}</div>`
    : '';

  const pitfalls = arr(g.pitfalls).length
    ? `<div class="card"><h3><span class="num">7</span>使用这份课件的注意事项</h3>${listHtml(g.pitfalls)}</div>`
    : '';

  const tips = arr(g.tips).length
    ? `<div class="card"><h3><span class="num">8</span>提效技巧</h3><div class="pill-row">${g.tips.map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div></div>`
    : '';

  const positioning = g.positioning
    ? `<div class="card"><h3>${icon('pin', 14)} 这份课件的定位</h3><p style="margin:0;font-size:13.5px;color:var(--text-2)">${esc(g.positioning)}</p></div>`
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
            s.askClass ? `提问：${s.askClass}` : '',
            s.board ? `板书：${s.board}` : '',
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
            ${s.askClass ? `<div class="note-box">${icon('help', 13)} 提问：${esc(s.askClass)}</div>` : ''}
            ${s.board ? `<div class="board-box"><span class="lbl">板书</span>${esc(s.board)}</div>` : ''}
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
        <button class="btn sm" id="presFs" style="background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.12);color:#e2e8f0">${icon('maximize', 13)}全屏</button>
        <button class="btn sm" id="presExit" style="background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.12);color:#e2e8f0">${icon('x', 13)}退出</button>
      </div>
      <div class="presenter-main">
        <div class="presenter-col">
          <div class="col-label">照着讲 · 讲解稿${s.scriptEn ? '（上：英文原话　下：中文翻译）' : ''}</div>
          ${
            s.scriptEn
              ? `<div class="script-text en">${esc(s.scriptEn)}</div>
                 <div class="script-zh-tag">中文翻译</div>
                 <div class="script-text">${esc(s.script || '（本页没有讲解稿）')}</div>`
              : `<div class="script-text">${esc(s.script || '（本页没有讲解稿）')}</div>`
          }
          ${
            arr(s.keyPoints).length
              ? `<div class="kp"><h5>必须让学生记住</h5><ul class="clean">${s.keyPoints.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>`
              : ''
          }
          ${s.askClass ? `<div class="ask">${icon('help', 13)} 提问：${esc(s.askClass)}</div>` : ''}
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
        </div>
      </div>
      <div class="presenter-foot">
        <button id="presPrev" ${i === 0 ? 'disabled' : ''}>${icon('left', 13)}上一段</button>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <button id="presNext" ${i === segs.length - 1 ? 'disabled' : ''}>下一段${icon('right', 13)}</button>
      </div>
    </div>`;

  $('#presExit').addEventListener('click', closePresenter);
  $('#presFs').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else $('.presenter')?.requestFullscreen?.().catch(() => toast('浏览器不允许全屏', 'err'));
  });
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

  mountSlide($('#presSlide'), pdf, page, { width: 1500 });
  slideCount(pdf).then((total) => {
    const el = $('#presSlideTotal');
    if (el) el.textContent = total || '?';
    const nx = $('#presSlideNext');
    if (nx && total && page >= total) nx.disabled = true;
  });


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
    '如果学生只有 10 分钟复习，应该看哪几页？',
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
    <div class="bubble">${isUser ? esc(content).replace(/\n/g, '<br>') : mdToHtml(normalizeAnswer(content))}</div>
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
    bubble.innerHTML = mdToHtml(answer) + '<span style="opacity:.4">▌</span>';
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
    bubble.innerHTML = mdToHtml(answer) || '<i>（没有返回内容）</i>';
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
async function runAnalysis(stages) {
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
    await postSSE(`/api/projects/${state.project.id}/analyze`, { name: state.project.name, stages: want }, (evt) => {
      if (evt.type === 'start') {
        state.stages.forEach((s) => {
          if (s.status !== 'skipped') s.status = 'pending';
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
    if (e.key === 'Escape') closePresenter();
    else if (['ArrowRight', ' ', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      goPresenter(1);
    } else if (['ArrowLeft', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      goPresenter(-1);
    } else if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else $('.presenter')?.requestFullscreen?.().catch(() => {});
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#modalRoot').innerHTML) closeModal();
  });
}

init().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message}`, 'err');
});
