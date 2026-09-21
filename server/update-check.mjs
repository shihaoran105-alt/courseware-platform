/**
 * 远端版本检查：让「自己 clone 下来跑」的部署也能知道上面发了新版本。
 *
 * 本地服务器手上只有自己磁盘上的 version.json，永远不会知道 GitHub 上有没有更新。
 * 所以这里额外去拉一次远端清单，跟本地比。
 *
 * 三条硬性约束：
 *   1. **绝不阻塞页面**。前端每 45 秒问一次 /api/version，如果每次都等网络，
 *      页面就会被拖死。所以这里只在后台刷新，接口立刻返回上一次的结果。
 *   2. **绝不打扰**。拉不到（断网、仓库私有、没配地址）就当没有更新，静默跳过。
 *   3. **只读检查**。这里返回版本号、构建标识和包元数据；
 *      真正下载与安装只会在用户主动点击更新后发生。
 */
import fs from 'node:fs';
import { CONFIG_FILE, isPublicMode } from './config.mjs';

/** 检查间隔：默认 30 分钟。别设太小，GitHub 会对高频请求限流 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_UPDATE_URL = 'https://raw.githubusercontent.com/shihaoran105-alt/courseware-platform/main/version.json';

/** @type {{at:number, url:string, data:object|null, error:string}} */
let cache = { at: 0, url: '', data: null, error: '' };
let inflight = null;

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 更新检查地址从哪来：环境变量优先，其次 data/config.json。
 * 留空 = 不检查（默认行为，避免给不想联网的人偷偷发请求）。
 */
export function updateCheckUrl() {
  const env = (process.env.UPDATE_CHECK_URL || '').trim();
  if (env) return env;
  const saved = readJson(CONFIG_FILE, {});
  if (typeof saved.updateCheckUrl === 'string') return saved.updateCheckUrl.trim();
  return DEFAULT_UPDATE_URL;
}

export function setUpdateCheckUrl(url) {
  const clean = String(url || '').trim();
  const saved = readJson(CONFIG_FILE, {});
  if (clean) saved.updateCheckUrl = clean;
  else delete saved.updateCheckUrl;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2), 'utf8');
  // 地址换了，之前那份缓存就作废
  cache = { at: 0, url: '', data: null, error: '' };
  return clean;
}

/** 只认 http(s)，防止被塞个 file:// 之类的东西进来 */
export function isSafeUrl(url = '') {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 版本号必须是 1.2.3 这样，别把远端返回的任意字符串渲染出来 */
function cleanVersion(v) {
  const s = String(v || '').trim();
  return /^\d+\.\d+\.\d+$/.test(s) ? s : '';
}

function cleanBuildId(v) {
  return String(v || '').trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100);
}

function cleanSha256(v) {
  const value = String(v || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}

/** 历史条目做一遍瘦身和截断，避免远端返回一个巨大文件把界面撑爆 */
function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  return h.slice(0, 30).map((x) => ({
    version: cleanVersion(x?.version),
    date: String(x?.date || '').slice(0, 20),
    title: String(x?.title || '').slice(0, 200),
    changes: (Array.isArray(x?.changes) ? x.changes : []).slice(0, 40).map((c) => String(c).slice(0, 500)),
  }));
}

async function fetchRemote(url) {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json', 'User-Agent': 'courseware-platform-update-check' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`远端返回 ${res.status}`);
  const data = await res.json();
  const version = cleanVersion(data?.version);
  if (!version) throw new Error('远端 version.json 里没有合法的版本号');
  return {
    version,
    buildId: cleanBuildId(data?.buildId),
    packageUrl: isSafeUrl(data?.packageUrl) ? String(data.packageUrl) : '',
    packageSha256: cleanSha256(data?.packageSha256),
    releasedAt: String(data?.releasedAt || '').slice(0, 40),
    history: cleanHistory(data?.history),
  };
}

/**
 * 后台刷新一次（同一个时刻只会有一个请求在飞）。
 * 无论成功失败都不抛，失败原因记在 cache.error 里。
 */
function refresh(url) {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await fetchRemote(url);
      cache = { at: Date.now(), url, data, error: '' };
    } catch (err) {
      // 失败也记时间戳，否则断网时会变成每次轮询都重试一遍
      cache = { at: Date.now(), url, data: null, error: err.message || String(err) };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 读当前的远端信息。**同步返回、绝不等网络** —— 过期就在后台刷。
 * @param {{force?: boolean}} opts force=true 时会等这次刷新完成（给「检查更新」按钮用）
 */
export async function remoteStatus({ force = false } = {}) {
  // 公开部署里这是服务器级配置，不该让访客改
  const editable = !isPublicMode();
  const url = updateCheckUrl();
  if (!url || !isSafeUrl(url)) {
    return { configured: false, url: '', version: '', error: '', checkedAt: 0, stale: false, editable };
  }

  const age = Date.now() - cache.at;
  const ttl = Number(process.env.UPDATE_CHECK_TTL_MS) || DEFAULT_TTL_MS;
  const sameUrl = cache.url === url;
  const expired = !sameUrl || age > ttl;

  if (force) {
    await refresh(url);
  } else if (expired) {
    // 关键：不 await —— 先把手上的旧结果给出去，网络在后台慢慢跑
    refresh(url);
  }

  const fresh = cache.url === url ? cache : { data: null, error: '', at: 0 };
  return {
    configured: true,
    editable,
    url,
    version: fresh.data?.version || '',
    buildId: fresh.data?.buildId || '',
    packageUrl: fresh.data?.packageUrl || '',
    packageSha256: fresh.data?.packageSha256 || '',
    releasedAt: fresh.data?.releasedAt || '',
    history: fresh.data?.history || [],
    error: fresh.error || '',
    checkedAt: fresh.at || 0,
    // 这次给的是不是还没刷新过的旧数据
    stale: Boolean(fresh.data) && Date.now() - fresh.at > ttl,
  };
}

/** 测试用：把缓存清掉 */
export function resetRemoteCache() {
  cache = { at: 0, url: '', data: null, error: '' };
  inflight = null;
}
