/**
 * 运行时配置解析
 *
 * 两种运行模式：
 *   本机模式（默认）：服务端自己提供 API Key（环境变量 / data/config.json / 本机 DSH 凭据），
 *                     开箱即用，无需访客填写。
 *   公开模式（PUBLIC_MODE=1，或 HOST 绑定到非本机地址时自动开启）：
 *                     服务端**绝不**使用自己的 Key，也绝不下发。每个访客用自己的 Key，
 *                     通过请求头 X-API-Key 传上来，用完即弃、不落盘。
 *
 * 安全约定：
 *   - Key 只在单次请求的内存里存在，不写日志、不落盘、不回传。
 *   - 公开模式下 DSH 凭据 / 环境变量里的 Key 一律不参与解析，防止访客白嫖部署者的额度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KEY_URL, PROVIDERS } from './providers.mjs';

export { DEFAULT_KEY_URL, PROVIDERS };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const PUBLIC_DIR = path.join(ROOT, 'public');

for (const dir of [DATA_DIR, UPLOAD_DIR, CACHE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  maxInputChars: 90000,
  port: 4173,
  host: '127.0.0.1',
};

/** 访客需要 Key 时抛这个，路由层转成 401 + needsKey */
export class NeedKeyError extends Error {
  constructor(message = '需要提供 API Key') {
    super(message);
    this.name = 'NeedKeyError';
    this.code = 'NEED_KEY';
  }
}


function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const truthy = (v) => v === '1' || v === 'true' || v === 'yes';
const falsy = (v) => v === '0' || v === 'false' || v === 'no';

/**
 * 是否公开模式。
 * 显式 PUBLIC_MODE 优先；没设的话，只要 HOST 不是本机回环地址就自动开启——
 * 避免有人 `HOST=0.0.0.0 npm start` 之后把自己的 Key 暴露给整个互联网。
 */
export function isPublicMode() {
  if (truthy(process.env.PUBLIC_MODE)) return true;
  if (falsy(process.env.PUBLIC_MODE)) return false;
  const host = process.env.HOST || DEFAULTS.host;
  return !/^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(host);
}

/** 从 DSH 凭据文件读 Key —— 只在非公开模式下才允许 */
function keyFromDshCredentials() {
  if (isPublicMode()) return '';
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    path.join(os.homedir(), '.dsh', 'credentials.yaml'),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(.+?)\s*$/m);
      if (!m) continue;
      const raw = m[1].replace(/^["']|["']$/g, '').trim();
      if (raw && raw !== 'null' && !raw.startsWith('env:')) return raw;
    } catch {
      /* 忽略 */
    }
  }
  return '';
}

/** 服务端自己可用的 Key（公开模式下恒为空） */
export function serverKey() {
  if (isPublicMode()) return { apiKey: '', source: 'none' };
  const saved = readJson(CONFIG_FILE, {});
  const envKey = (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const savedKey = typeof saved.apiKey === 'string' ? saved.apiKey.trim() : '';
  const dshKey = keyFromDshCredentials();
  if (envKey) return { apiKey: envKey, source: 'env' };
  if (savedKey) return { apiKey: savedKey, source: 'saved' };
  if (dshKey) return { apiKey: dshKey, source: 'dsh' };
  return { apiKey: '', source: 'none' };
}

/** 服务端的模型 / 接口 / 上传等偏好（不含 Key） */
export function loadServerConfig() {
  const saved = readJson(CONFIG_FILE, {});
  return {
    baseUrl: (process.env.DEEPSEEK_BASE_URL || saved.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || saved.model || DEFAULTS.model,
    maxInputChars: Number(process.env.MAX_INPUT_CHARS) || Number(saved.maxInputChars) || DEFAULTS.maxInputChars,
    port: Number(process.env.PORT) || DEFAULTS.port,
    host: process.env.HOST || DEFAULTS.host,
  };
}

/**
 * 解析本次请求要用的配置。
 * 优先用访客自己带上来的 Key；非公开模式才回落到服务端的 Key。
 */
export function resolveRequestConfig(req) {
  const base = loadServerConfig();
  const header = (name) => {
    try {
      return String(req?.get?.(name) || '').trim();
    } catch {
      return '';
    }
  };

  const clientKey = header('x-api-key');
  if (clientKey) {
    return {
      ...base,
      apiKey: clientKey,
      keySource: 'client',
      baseUrl: (header('x-api-base') || base.baseUrl).replace(/\/+$/, ''),
      model: header('x-api-model') || base.model,
    };
  }

  if (!isPublicMode()) {
    const { apiKey, source } = serverKey();
    if (apiKey) return { ...base, apiKey, keySource: source };
  }

  throw new NeedKeyError(
    isPublicMode()
      ? '本站需要你自己的 API Key。请点右上角「设置」填入后重试。'
      : '尚未配置 API Key。请在设置中填入，或设置环境变量 DEEPSEEK_API_KEY。',
  );
}

/** 保存服务端偏好（公开模式下禁止写入 Key） */
export function saveConfig(patch = {}) {
  const saved = readJson(CONFIG_FILE, {});
  const next = { ...saved };
  if (!isPublicMode() && typeof patch.apiKey === 'string') {
    const v = patch.apiKey.trim();
    if (v) next.apiKey = v;
    else delete next.apiKey;
  }
  if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) next.baseUrl = patch.baseUrl.trim();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return loadServerConfig();
}

/** 给前端的脱敏状态（永远不含 Key 本身） */
export function publicConfig() {
  const base = loadServerConfig();
  const { apiKey } = serverKey();
  return {
    publicMode: isPublicMode(),
    hasServerKey: Boolean(apiKey),
    model: base.model,
    baseUrl: base.baseUrl,
    maxInputChars: base.maxInputChars,
    providers: PROVIDERS,
    keyUrl: DEFAULT_KEY_URL,
    siteName: process.env.SITE_NAME || '课件讲解平台',
    xfyun: xfyunPublic(),
    renderer: rendererState(),
  };
}

/* --------------------------- 讯飞语音转写凭据 --------------------------- */
/**
 * 凭据来源：环境变量 → data/config.json（已被 .gitignore 排除）。
 * 永远不会回传前端，只回传「配没配」。
 */
export function xfyunConfig() {
  const saved = readJson(CONFIG_FILE, {});
  const x = saved.xfyun || {};
  return {
    appId: process.env.XFYUN_APP_ID || x.appId || '',
    // 录音文件转写真正用来签名的是 Secret Key（控制台里的那串 32 位十六进制）
    secretKey: process.env.XFYUN_SECRET_KEY || x.secretKey || '',
    apiKey: process.env.XFYUN_API_KEY || x.apiKey || '',
    apiSecret: process.env.XFYUN_API_SECRET || x.apiSecret || '',
  };
}

export function hasXfyun() {
  const c = xfyunConfig();
  // 录音文件转写只需要 APPID + Secret Key
  return Boolean(c.appId && (c.secretKey || c.apiSecret));
}

export function xfyunPublic() {
  const c = xfyunConfig();
  return { configured: hasXfyun(), appId: c.appId ? c.appId.slice(0, 4) + '****' : '' };
}

/* ------------------------------ 渲染器状态 ------------------------------ */

let rendererCache = null;

/** 检测 LibreOffice / pdftoppm 是否可用（结果缓存，避免每次请求都探测） */
export function rendererState() {
  if (rendererCache) return rendererCache;
  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
  ];
  let soffice = '';
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        soffice = p;
        break;
      }
    } catch {
      /* 忽略 */
    }
  }
  rendererCache = {
    office: Boolean(soffice),
    soffice,
    note: soffice ? '' : '未检测到 LibreOffice，PPTX/DOCX 无法转成截图，只能显示文字',
  };
  return rendererCache;
}

export function resetRendererCache() {
  rendererCache = null;
}

