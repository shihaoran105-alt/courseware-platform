import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

import { ROOT } from './config.mjs';
import { readVersion } from './version.mjs';
import { logError } from './log.mjs';

const DEFAULT_VERSION_URL = 'https://raw.githubusercontent.com/shihaoran105-alt/courseware-platform/main/version.json';
const DEFAULT_DOWNLOAD_BASE = 'https://raw.githubusercontent.com/shihaoran105-alt/courseware-platform/main';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把 Node 那句没头没脑的 `TypeError: fetch failed` 翻译成能照着排查的说法。
 *
 * 用户更新时看到的原话就是「fetch fail」—— 既不知道是 DNS、超时还是连接被掐，
 * 也不知道该找谁。真正的信息全藏在 err.cause 里（undici 的风格），这里把它掏出来。
 */
function describeFetchError(err, url, label) {
  const cause = err?.cause || {};
  const code = cause.code || cause.errno || '';
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* url 本身有问题就用原串 */
  }

  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new Error(
      `下载${label}超时：${host} 在限定时间内没传完。` +
        `GitHub 在国内经常被限速，可以稍后重试；如果一直不行，请在设置里把「更新检查地址」指向可用的镜像。`,
    );
  }

  const known = {
    ENOTFOUND: `解析不了 ${host} 的域名 —— 多半是 DNS 或断网`,
    EAI_AGAIN: `DNS 查询超时（${host}）`,
    ECONNRESET: `与 ${host} 的连接被中途重置`,
    ECONNREFUSED: `${host} 拒绝连接`,
    ETIMEDOUT: `连接 ${host} 超时`,
    EPIPE: `与 ${host} 的连接中断`,
    CERT_HAS_EXPIRED: `${host} 的证书已过期`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `无法验证 ${host} 的证书`,
    // undici（Node 自带的 fetch）自己的错误码。实测「连接被掐」报的是 UND_ERR_SOCKET，
    // 文案是 "other side closed"，不翻译的话用户还是看不懂。
    UND_ERR_SOCKET: `与 ${host} 的连接被对端关闭（下载中途断开）`,
    UND_ERR_CONNECT_TIMEOUT: `连接 ${host} 超时`,
    UND_ERR_HEADERS_TIMEOUT: `${host} 迟迟不返回响应头`,
    UND_ERR_BODY_TIMEOUT: `${host} 传到一半就不动了`,
  };
  const why = known[code] || cause.message || err?.message || '网络错误';
  return new Error(
    `下载${label}失败：${why}${code ? `（${code}）` : ''}。` +
      `\n地址：${url}` +
      `\n如果网络到 GitHub 不稳定，可以稍后重试；实在不行就在设置里把「更新检查地址」换成可达的镜像。`,
  );
}

/** 这些错是「过一会儿再来一次可能就好了」，值得重试 */
function isTransient(err) {
  const code = err?.cause?.code || err?.cause?.errno || '';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ].includes(code);
}

/**
 * 下载一个 URL。
 *
 * 两个讲究：
 *  · **重试**：GitHub 这边连接被重置很常见（实测一次 1.6 MB 的包要 13 秒），
 *    掐一次就整个更新失败太亏，抖动两下自己就好了。
 *  · **超时分开给**：小清单 30 秒够了，发行包要留足（限速时几十秒都正常），
 *    所以传进来的 timeoutMs 分开设。
 */
async function fetchBytes(url, type = 'arrayBuffer', { label = '', timeoutMs = 30_000, retries = 2 } = {}) {
  const full = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(full, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'courseware-platform-updater' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // 5xx / 429 是临时的，值得再试；4xx 直接认命
        const retryable = res.status >= 500 || res.status === 429;
        const err = new Error(
          `下载${label}失败（HTTP ${res.status}）。` +
            (retryable
              ? '对面服务临时出问题了，稍后重试通常就好。'
              : '地址可能已经失效，请检查更新地址。'),
        );
        err.isHttpError = true; // 已经是给人看的文案了，别再套一层「下载…失败」
        if (retryable && attempt < retries) {
          lastErr = err;
          console.warn(`[update] HTTP ${res.status}，${attempt + 1}/${retries} 次重试`);
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw err;
      }
      return type === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransient(err)) {
        console.warn(
          `[update] 下载${label}中断（${err?.cause?.code || err?.name || '未知'}），` +
            `${attempt + 1}/${retries} 次重试`,
        );
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (err?.isHttpError) throw err;
      throw describeFetchError(err, url, label);
    }
  }
  throw lastErr?.isHttpError ? lastErr : describeFetchError(lastErr, url, label);
}

function cleanVersion(value) {
  const version = String(value || '').trim();
  return /^\d+\.\d+\.\d+$/.test(version) ? version : '';
}

function cleanBuildId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100);
}

function cleanSha256(value) {
  const hash = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function compareVersion(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export async function prepareUpdate() {
  const manifest = await fetchBytes(process.env.UPDATE_CHECK_URL || DEFAULT_VERSION_URL, 'json', {
    label: '版本清单',
    timeoutMs: 30_000,
    retries: 2,
  });
  const remoteVersion = cleanVersion(manifest?.version);
  if (!remoteVersion) throw new Error('远端版本信息无效');
  const remoteBuildId = cleanBuildId(manifest?.buildId);
  const local = readVersion();
  const localVersion = cleanVersion(local.version) || '0.0.0';
  const localBuildId = cleanBuildId(local.buildId);
  const versionOrder = compareVersion(remoteVersion, localVersion);
  const sameVersionNeedsRepair = versionOrder === 0 && Boolean(remoteBuildId) && remoteBuildId !== localBuildId;
  if (versionOrder < 0 || (versionOrder === 0 && !sameVersionNeedsRepair)) {
    return {
      updated: false,
      version: localVersion,
      buildId: localBuildId,
      message: `当前已经是最新版 v${localVersion}`,
    };
  }

  const configuredUrl = String(manifest?.packageUrl || '').trim();
  const archiveUrl = /^https?:\/\//i.test(configuredUrl)
    ? configuredUrl
    : `${DEFAULT_DOWNLOAD_BASE}/courseware-platform-v${remoteVersion}.zip`;
  const bytes = await fetchBytes(archiveUrl, 'arrayBuffer', {
    label: '发行包',
    // 发行包 1.6 MB，GitHub 限速时实测要 13 秒，留足余量
    timeoutMs: 180_000,
    retries: 3,
  });
  const expectedSha256 = cleanSha256(manifest?.packageSha256);
  if (expectedSha256) {
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== expectedSha256) throw new Error('下载包校验失败，已停止更新');
  }
  const zip = await JSZip.loadAsync(bytes);
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `courseware-v${remoteVersion}-`));
  const prefix = 'courseware-platform/';

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !name.startsWith(prefix)) continue;
    const relative = name.slice(prefix.length);
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) continue;
    const destination = path.join(stageRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, await entry.async('nodebuffer'));
  }

  const stagedManifest = JSON.parse(fs.readFileSync(path.join(stageRoot, 'version.json'), 'utf8'));
  if (cleanVersion(stagedManifest.version) !== remoteVersion) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw new Error('下载包版本与远端版本清单不一致，已停止更新');
  }

  if (remoteBuildId && cleanBuildId(stagedManifest.buildId) !== remoteBuildId) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw new Error('下载包构建标识与远端清单不一致，已停止更新');
  }

  return {
    updated: true,
    repair: sameVersionNeedsRepair,
    from: localVersion,
    version: remoteVersion,
    buildId: remoteBuildId,
    stageRoot,
  };
}

export function launchUpdateHelper(stageRoot, version) {
  const helperSource = path.join(ROOT, 'scripts', 'finish-update.mjs');
  const helperCopy = path.join(os.tmpdir(), `courseware-finish-update-${process.pid}-${Date.now()}.mjs`);
  fs.copyFileSync(helperSource, helperCopy);
  const child = spawn(process.execPath, [helperCopy, ROOT, stageRoot, String(process.pid), version], {
    cwd: os.tmpdir(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}
