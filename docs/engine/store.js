/* ============================================================
   静态版的本地存储
   首选 IndexedDB（容量大，一份分析结果 JSON 就有 100KB+），
   但 IndexedDB 在部分环境会不可用甚至直接卡住（隐私模式、某些
   headless 浏览器、企业策略），所以带 3 秒超时并自动降级到
   localStorage —— 宁可容量小一点，也绝不能让页面卡死。
   ============================================================ */

const DB_NAME = 'courseware-static';
const DB_VERSION = 1;
const STORE = 'projects';
const IDX_KEY = 'cw_project_index';
const CURRENT_KEY = 'cw_current_project';
const OPEN_TIMEOUT_MS = 3000;

/** 'unknown' | 'indexeddb' | 'localstorage' */
let mode = 'unknown';
let idbPromise = null;

const timeout = (ms, label) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 超时')), ms));

/* ------------------------------ IndexedDB ------------------------------ */

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('打开本地数据库失败'));
    req.onblocked = () => reject(new Error('本地数据库被其他标签页占用'));
  });
}

function idbRun(db, m, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, m);
    const req = fn(t.objectStore(STORE));
    let value;
    if (req) req.onsuccess = () => (value = req.result);
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error || new Error('本地数据库操作失败'));
    t.onabort = () => reject(t.error || new Error('本地数据库事务被中断'));
  });
}

/* ------------------------------ localStorage 兜底 ------------------------------ */

const projKey = (id) => 'cw_proj_' + id;

function lsIndex() {
  try {
    const v = JSON.parse(localStorage.getItem(IDX_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function lsWriteIndex(ids) {
  try {
    localStorage.setItem(IDX_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* 忽略 */
  }
}

function lsPut(project) {
  try {
    localStorage.setItem(projKey(project.id), JSON.stringify(project));
  } catch {
    throw new Error('浏览器存储空间已满，请删掉一些旧课件再试。');
  }
  lsWriteIndex([...lsIndex(), project.id]);
  return project;
}

function lsGet(id) {
  try {
    const raw = localStorage.getItem(projKey(id));
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function lsAll() {
  return lsIndex()
    .map((id) => lsGet(id))
    .filter(Boolean);
}

function lsDel(id) {
  try {
    localStorage.removeItem(projKey(id));
  } catch {
    /* 忽略 */
  }
  lsWriteIndex(lsIndex().filter((x) => x !== id));
}

/* ------------------------------ 选择后端 ------------------------------ */

async function backend() {
  if (mode !== 'unknown') return mode;
  try {
    if (typeof indexedDB === 'undefined') throw new Error('浏览器不支持 IndexedDB');
    idbPromise = openIdb();
    await timeout(OPEN_TIMEOUT_MS, 'IndexedDB');
    mode = 'indexeddb';
  } catch (err) {
    console.warn('[storage] IndexedDB 不可用，降级到 localStorage：' + err.message);
    mode = 'localstorage';
    idbPromise = null;
  }
  return mode;
}

/** 供界面显示当前用的是哪种存储 */
export function storageMode() {
  return mode === 'unknown' ? '检测中' : mode;
}

/* ------------------------------ 对外接口 ------------------------------ */

export async function putProject(project) {
  if ((await backend()) === 'indexeddb') {
    const db = await idbPromise;
    await idbRun(db, 'readwrite', (s) => s.put(project));
    return project;
  }
  return lsPut(project);
}

export async function getProject(id) {
  if ((await backend()) === 'indexeddb') {
    const db = await idbPromise;
    return idbRun(db, 'readonly', (s) => s.get(id));
  }
  return lsGet(id);
}

export async function allProjects() {
  if ((await backend()) === 'indexeddb') {
    const db = await idbPromise;
    return (await idbRun(db, 'readonly', (s) => s.getAll())) || [];
  }
  return lsAll();
}

export async function delProject(id) {
  if ((await backend()) === 'indexeddb') {
    const db = await idbPromise;
    await idbRun(db, 'readwrite', (s) => s.delete(id));
    return;
  }
  lsDel(id);
}

export function currentId() {
  try {
    return localStorage.getItem(CURRENT_KEY) || '';
  } catch {
    return '';
  }
}

export function setCurrentId(id) {
  try {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 抹掉所有本地数据 */
export async function wipeAll() {
  if ((await backend()) === 'indexeddb') {
    const db = await idbPromise;
    await idbRun(db, 'readwrite', (s) => s.clear());
  } else {
    for (const id of lsIndex()) lsDel(id);
  }
  setCurrentId('');
}
