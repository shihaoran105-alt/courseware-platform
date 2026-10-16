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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KEY_URL, PROVIDERS } from './providers.mjs';

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

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
  // 读页面截图必须用支持图片的模型。这台环境上 deepseek-v4-pro 明确不认图片
  // （会返回「[Unsupported Image]」），deepseek-flash 实测能准确读出图表和表格。
  visionModel: 'deepseek-flash',
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
 * 是不是**部署者明确声明**的公开部署（PUBLIC_MODE 被显式设成真）。
 *
 * 和 isPublicMode() 的区别很重要：那个函数还会「推测」——
 * 绑了 0.0.0.0 又没设口令时也算公开。但推测出来的公开**不能挡住建访问口令**，
 * 否则就是死锁：
 *     因为没设口令 → 判成公开部署 → 公开部署不允许设口令 → 永远设不上。
 * 用户看到的是「请联系服务器管理员更新」，而管理员就是他自己，无处可联系。
 *
 * 所以凡是「只有服务器主人能做的事」都该用这个函数来判断，
 * 而不是用会推测的 isPublicMode()。
 */
export function explicitPublicMode() {
  return truthy(process.env.PUBLIC_MODE);
}

/**
 * 是否公开模式（公开部署 = 给别人用：访客自带 Key、不能用服务器 Key、不能点更新、限额生效）。
 *
 * 判断顺序：
 *  1. 显式设了 PUBLIC_MODE 就听它的（`npm run start:public` 会设 1；
 *     自建服务器的启动脚本会设 0）。
 *  2. 没设时看绑在哪：绑回环 = 自己用；绑 0.0.0.0 = 对外。
 *  3. **对外但设了访问口令** → 仍然算自己的服务器。
 *     这一条是后加的，也很关键：自己的服务器为了能被局域网 / Tailscale 访问
 *     **必须**绑 0.0.0.0，可是旧规则一律当成公开部署 —— 于是「不能用自己配的 Key、
 *     右上角更新按钮直接消失、只显示『请联系服务器管理员更新』」。
 *     现在有了访问口令这道门，绑 0.0.0.0 不再等于「谁都能进」。
 *     没设口令时仍然按公开部署处理，免得把 Key 白送出去。
 */
export function isPublicMode() {
  if (truthy(process.env.PUBLIC_MODE)) return true;
  if (falsy(process.env.PUBLIC_MODE)) return false;
  const host = process.env.HOST || DEFAULTS.host;
  const exposed = !/^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(host);
  if (!exposed) return false;
  // 对外但设了访问口令 → 还是自己的服务器
  return !accessRequired();
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
    visionModel: process.env.VISION_MODEL || saved.visionModel || DEFAULTS.visionModel,
    maxInputChars: Number(process.env.MAX_INPUT_CHARS) || Number(saved.maxInputChars) || DEFAULTS.maxInputChars,
    port: Number(process.env.PORT) || DEFAULTS.port,
    host: process.env.HOST || DEFAULTS.host,
    // 每次生成思维导图时，额外写一份 markdown 到哪个文件夹（空 = 不写）。
    // 格式按 dsh-mindmap 插件认的规则：文件名 = 根节点，# 标题、缩进列表 = 子节点。
    mindmapDir: process.env.MINDMAP_DIR || saved.mindmapDir || '',
    mindmapExportedAt: saved.mindmapExportedAt || '',
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

  // 界面语言：模型产出的内容要跟着用户选的语言走（前端用 X-Lang 头带上）
  const lang = header('x-lang') === 'en' ? 'en' : 'zh';

  const clientKey = header('x-api-key');
  if (clientKey) {
    return {
      ...base,
      lang,
      apiKey: clientKey,
      keySource: 'client',
      baseUrl: (header('x-api-base') || base.baseUrl).replace(/\/+$/, ''),
      model: header('x-api-model') || base.model,
    };
  }

  if (!isPublicMode()) {
    const { apiKey, source } = serverKey();
    if (apiKey) return { ...base, lang, apiKey, keySource: source };
  }

  throw new NeedKeyError(
    isPublicMode()
      ? '本站需要你自己的 API Key。请点右上角「设置」填入后重试。'
      : '尚未配置 API Key。请在设置中填入，或设置环境变量 DEEPSEEK_API_KEY。',
  );
}

/**
 * 保存服务端偏好。
 * 只有**明确声明**的公开部署才禁止写 Key —— 用 isPublicMode() 会把
 * 「绑了 0.0.0.0 还没设口令」这种推测出来的公开也算进去，
 * 于是 Key 被静默丢掉、界面却提示「已保存」。
 */
export function saveConfig(patch = {}) {
  const saved = readJson(CONFIG_FILE, {});
  const next = { ...saved };
  if (!explicitPublicMode() && typeof patch.apiKey === 'string') {
    const v = patch.apiKey.trim();
    if (v) next.apiKey = v;
    else delete next.apiKey;
  }
  if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) next.baseUrl = patch.baseUrl.trim();
  // 脑图导出的目标文件夹。允许存空字符串 = 关掉这个功能。
  if (typeof patch.mindmapDir === 'string') next.mindmapDir = patch.mindmapDir.trim();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return loadServerConfig();
}

/**
 * 访问口令。
 *
 * 平台本身没有账号体系（定位是「打开就能用」）。可一旦放到外网，
 * 谁知道地址谁就能用你的 API Key、往你磁盘写东西，所以给自建服务器留一道门。
 *
 * 口令来源优先级：环境变量 ACCESS_PASSWORD > 设置里存的。
 * 只存口令的哈希，不存明文。
 */
export function accessPasswordHash() {
  const fromEnv = String(process.env.ACCESS_PASSWORD || '').trim();
  if (fromEnv) return sha256(`env:${fromEnv}`);
  const saved = readJson(CONFIG_FILE, {});
  return String(saved.accessPassword || '').trim();
}

/** 有没有设口令（界面据此决定要不要弹门） */
export function accessRequired() {
  return Boolean(accessPasswordHash());
}

export function setAccessPassword(pw) {
  const saved = readJson(CONFIG_FILE, {});
  const next = { ...saved };
  const v = String(pw ?? '').trim();
  if (v) next.accessPassword = sha256(`set:${v}`);
  else delete next.accessPassword;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return accessRequired();
}

/** 口令比对：把用户输入按同样的方式算一遍再比，用定长比较防时序探测 */
export function checkAccessPassword(pw) {
  const want = accessPasswordHash();
  if (!want) return true;
  const fromEnv = String(process.env.ACCESS_PASSWORD || '').trim();
  const given = sha256(`${fromEnv ? 'env' : 'set'}:${String(pw ?? '').trim()}`);
  if (given.length !== want.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
  } catch {
    return false;
  }
}

/** 给前端的脱敏状态（永远不含 Key 本身） */
export function publicConfig() {
  const base = loadServerConfig();
  const { apiKey } = serverKey();
  return {
    publicMode: isPublicMode(),
    // 这个「公开」是部署者明确声明的，还是平台推测出来的（对外但没设口令）？
    // 前端要靠它给出正确提示：推测出来的那种，设一个访问口令就能变回自己的服务器。
    publicModeExplicit: explicitPublicMode(),
    hasServerKey: Boolean(apiKey),
    accessRequired: accessRequired(),
    mindmapDir: loadServerConfig().mindmapDir,
    model: base.model,
    visionModel: base.visionModel,
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

