import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

import { ROOT } from './config.mjs';
import { readVersion } from './version.mjs';

const DEFAULT_VERSION_URL = 'https://raw.githubusercontent.com/shihaoran105-alt/courseware-platform/main/version.json';
const DEFAULT_DOWNLOAD_BASE = 'https://raw.githubusercontent.com/shihaoran105-alt/courseware-platform/main';

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

async function fetchBytes(url, type = 'arrayBuffer') {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'courseware-platform-updater' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  return type === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}

export async function prepareUpdate() {
  const manifest = await fetchBytes(process.env.UPDATE_CHECK_URL || DEFAULT_VERSION_URL, 'json');
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
  const bytes = await fetchBytes(archiveUrl);
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
