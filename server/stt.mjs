/**
 * 语音转文字
 *
 * 三家服务商，按可用性自动选择：
 *   local  → 本地 whisper.cpp。完全免费、离线、不限时长（推荐）
 *   xfyun  → 讯飞「录音文件转写」：upload → 轮询 getResult（有免费额度）
 *   openai → POST /v1/audio/transcriptions（whisper-1，需要能连上 api.openai.com）
 *
 * 统一输出：{ provider, text, segments:[{ start, end, text }] }，时间戳单位秒。
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { loadServerConfig, xfyunConfig } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 本地 whisper.cpp ------------------------------ */

const WHISPER_BINS = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli'];
const MODEL_DIRS = [
  path.join(os.homedir(), '.cache', 'whisper-models'),
  path.join(os.homedir(), '.cache', 'whisper.cpp'),
  '/opt/homebrew/share/whisper.cpp/models',
];
const MODEL_PREFERENCE = [
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3.bin',
  'ggml-medium.bin',
  'ggml-small.bin',
  'ggml-base.bin',
  'ggml-tiny.bin',
];

export function findWhisperCli() {
  for (const p of WHISPER_BINS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略 */
    }
  }
  return '';
}

export function findWhisperModel() {
  const explicit = process.env.WHISPER_MODEL;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const dir of MODEL_DIRS) {
    for (const name of MODEL_PREFERENCE) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* 忽略 */
      }
    }
  }
  return '';
}

function localReady() {
  return Boolean(findWhisperCli() && findWhisperModel());
}

/**
 * 用本地 whisper.cpp 转写。完全免费、离线、不限时长。
 * whisper-cli 的 JSON 输出里，offsets 是毫秒。
 */
async function transcribeLocal(audioPath, { onProgress } = {}) {
  const bin = findWhisperCli();
  const model = findWhisperModel();
  if (!bin) throw new Error('没找到 whisper-cli，请先执行 brew install whisper-cpp');
  if (!model) {
    throw new Error(
      '没找到 whisper 模型文件。下载一个放到 ~/.cache/whisper-models/ 即可：\n' +
        'curl -L -o ~/.cache/whisper-models/ggml-large-v3-turbo.bin ' +
        'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    );
  }

  const outBase = audioPath.replace(/\.wav$/i, '') + '.whisper';
  const args = [
    '-m', model,
    '-f', audioPath,
    '-oj',                                        // 输出 JSON（带时间戳）
    '-of', outBase,
    '-l', process.env.WHISPER_LANG || 'auto',     // 自动识别中/英
    '-t', String(Math.max(4, Math.min(8, os.cpus().length - 1))),
    '--print-progress',
  ];

  onProgress?.(`本地转写中（${path.basename(model)}，首次跑会稍慢）…`);

  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastPct = -1;
    const onChunk = (buf) => {
      const m = buf.toString().match(/progress\s*=\s*(\d+)%/);
      if (!m) return;
      const pct = Number(m[1]);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        onProgress?.(`本地转写中… ${pct}%`);
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('whisper-cli 退出码 ' + code))));
  });

  const jsonPath = outBase + '.json';
  if (!fs.existsSync(jsonPath)) throw new Error('whisper-cli 没有输出 JSON 结果');
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const items = raw.transcription || raw.segments || [];

  const segments = items
    .map((it) => {
      const off = it.offsets || {};
      const from = Number(off.from ?? 0) / 1000;
      const to = Number(off.to ?? 0) / 1000;
      return { start: from, end: to > from ? to : from + 1, text: String(it.text || '').trim() };
    })
    .filter((s) => s.text);

  try {
    fs.unlinkSync(jsonPath);
  } catch {
    /* 忽略 */
  }

  if (!segments.length) throw new Error('本地转写没有识别出任何句子（音频里可能没有人声）');
  return {
    text: segments.map((s) => s.text).join('\n'),
    segments,
    language: raw.result?.language || raw.params?.language || '',
  };
}

/* ------------------------------ 选择服务商 ------------------------------ */

/**
 * 优先级：STT_PROVIDER 环境变量可强制指定；
 * 否则 本地（免费无限）→ 讯飞（有免费额度）→ Groq（免费额度）→ OpenAI。
 */
export function sttProvider() {
  const forced = (process.env.STT_PROVIDER || '').trim().toLowerCase();
  if (['local', 'xfyun', 'groq', 'openai', 'none'].includes(forced)) return forced;

  if (localReady()) return 'local';
  const x = xfyunConfig();
  if (x.appId && (x.secretKey || x.apiSecret)) return 'xfyun';
  if ((process.env.GROQ_API_KEY || '').trim()) return 'groq';
  if ((process.env.OPENAI_API_KEY || '').trim()) return 'openai';
  return 'none';
}

export function sttState() {
  const provider = sttProvider();
  const model = findWhisperModel();
  const note =
    {
      none: '没有可用的语音转写服务，上课录像只能播放',
      local: `使用本地 whisper.cpp（免费、离线、不限时长）${model ? ' · ' + path.basename(model) : ''}`,
      xfyun: '使用讯飞「录音文件转写」',
      groq: '使用 Groq Whisper（免费额度）',
      openai: '使用 OpenAI Whisper',
    }[provider] || provider;
  return {
    provider,
    note,
    localReady: localReady(),
    model: model ? path.basename(model) : '',
  };
}

/* --------------------- OpenAI 兼容的云端 Whisper（OpenAI / Groq） --------------------- */

/**
 * OpenAI 和 Groq 的转写接口是同一套协议，只是 base/model/key 不同。
 * Groq 免费额度更宽松、国内网络也能连上，所以作为 OpenAI 之外的备选。
 */
async function transcribeOpenAILike(audioPath, { key, base, model, label }) {
  if (!key) throw new Error(`没有配置 ${label} 的 API Key`);
  const root = String(base).replace(/\/+$/, '');

  const buf = fs.readFileSync(audioPath);
  if (buf.length > 25 * 1024 * 1024) {
    throw new Error(
      `这一段音频超过 25MB，${label} 接口单次上限就是 25MB。请改用本地 whisper.cpp 或讯飞。`,
    );
  }

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(audioPath));
  form.append('model', model);
  form.append('response_format', 'verbose_json');

  const res = await fetch(`${root}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${label} 接口返回 ${res.status}：${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const segments = (data.segments || []).map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: String(s.text || '').trim(),
  }));
  return { text: String(data.text || '').trim(), segments, language: data.language || '' };
}

function transcribeOpenAI(audioPath) {
  return transcribeOpenAILike(audioPath, {
    key: (process.env.OPENAI_API_KEY || '').trim(),
    base: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_STT_MODEL || 'whisper-1',
    label: 'OpenAI Whisper',
  });
}

function transcribeGroq(audioPath) {
  return transcribeOpenAILike(audioPath, {
    key: (process.env.GROQ_API_KEY || '').trim(),
    base: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
    label: 'Groq Whisper',
  });
}

/* ------------------------------ 讯飞录音文件转写 ------------------------------ */

const XF_HOST = 'https://raasr.xfyun.cn';

/**
 * 讯飞录音文件转写的签名（官方 demo 的确切算法，很容易踩坑）：
 *   1) baseString = MD5(appId + ts)  → 小写十六进制
 *   2) signa      = Base64(HmacSHA1(secretKey, baseString))
 * 注意不是「直接对 appId+ts 做 HMAC」，中间必须先过一道 MD5。
 */
function xfSigna(secretKey, appId, ts) {
  const baseString = crypto.createHash('md5').update(appId + ts).digest('hex').toLowerCase();
  return crypto.createHmac('sha1', secretKey).update(baseString).digest('base64');
}

/** 讯飞返回的 lattice 里塞着一层 JSON 字符串，这里解析成带时间戳的句子 */
function parseXfLattice(latticeRaw) {
  let lattice;
  try {
    lattice = typeof latticeRaw === 'string' ? JSON.parse(latticeRaw) : latticeRaw;
  } catch {
    return [];
  }
  if (!Array.isArray(lattice)) return [];

  const out = [];
  for (const item of lattice) {
    const best = item?.json_1best ?? item;
    const st = typeof best === 'string' ? safeJson(best) : best;
    const words = st?.st?.ws || [];
    let sentence = '';
    for (const w of words) {
      for (const c of w.cw || []) sentence += c.w || '';
    }
    const start = Number(st?.st?.bg) || 0;
    const end = Number(st?.st?.ed) || start;
    const text = sentence.trim();
    if (text) out.push({ start: start / 1000, end: end / 1000, text });
  }
  return out;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function xfUpload(audioPath, { durationMs = 0 } = {}) {
  const { appId, secretKey, apiSecret } = xfyunConfig();
  const ts = Math.floor(Date.now() / 1000).toString();
  const signa = xfSigna(secretKey || apiSecret, appId, ts);
  const buf = fs.readFileSync(audioPath);
  const params = new URLSearchParams({
    appId,
    signa,
    ts,
    fileSize: String(buf.length),
    fileName: path.basename(audioPath),
    // duration 必传，漏了会返回 26600「转写业务通用错误」
    duration: String(Math.max(1000, Math.round(durationMs))),
    categoryId: '0',
  });

  const res = await fetch(`${XF_HOST}/v2/api/upload?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== '000000' || !data.data?.orderId) {
    throw new Error(`讯飞上传失败：${data.code || res.status} ${data.descInfo || data.desc || ''}`.trim());
  }
  return data.data.orderId;
}

async function xfResult(orderId) {
  const { appId, secretKey, apiSecret } = xfyunConfig();
  const ts = Math.floor(Date.now() / 1000).toString();
  const signa = xfSigna(secretKey || apiSecret, appId, ts);
  const params = new URLSearchParams({ appId, signa, ts, orderId, resultType: 'transfer' });
  const res = await fetch(`${XF_HOST}/v2/api/getResult?${params}`, {
    method: 'POST',
    body: '',
    signal: AbortSignal.timeout(120000),
  });
  return res.json().catch(() => ({}));
}

async function transcribeXfyun(audioPath, { onProgress, durationMs = 0 } = {}) {
  const { appId, secretKey, apiSecret } = xfyunConfig();
  if (!appId || !(secretKey || apiSecret)) throw new Error('讯飞凭据不完整（需要 APPID / Secret Key）');

  // 没给时长就自己探一下，接口必填
  if (!durationMs) {
    const { probeDuration } = await import('./media-tools.mjs');
    durationMs = Math.round((await probeDuration(audioPath)) * 1000);
  }
  const orderId = await xfUpload(audioPath, { durationMs });
  onProgress?.('已上传到讯飞，正在转写…');

  const deadline = Date.now() + 30 * 60 * 1000;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(6000);
    const data = await xfResult(orderId);
    last = data;

    if (data.code !== '000000') {
      throw new Error(`讯飞转写失败：${data.code} ${data.descInfo || data.desc || ''}`.trim());
    }
    const status = data.data?.status;
    if (status === 1) {
      const lattice = data.data?.result?.lattice ?? data.data?.lattice;
      const segments = parseXfLattice(lattice);
      if (!segments.length) {
        throw new Error('讯飞返回了结果，但没有解析出任何句子（可能录像里没有人声）');
      }
      return { text: segments.map((s) => s.text).join('\n'), segments, language: data.data?.result?.language || '' };
    }
    if (status === -1) {
      throw new Error(`讯飞转写任务失败：${data.data?.failType || data.descInfo || '未知原因'}`);
    }
    onProgress?.(`讯飞转写中…（状态 ${status ?? '排队'}）`);
  }
  throw new Error(`讯飞转写超时。最后一次返回：${JSON.stringify(last).slice(0, 200)}`);
}

/* ------------------------------ 对外入口 ------------------------------ */

/**
 * 转写一段音频
 * @returns {Promise<{provider:string, text:string, segments:Array, language:string}>}
 */
export async function transcribe(audioPath, { onProgress, durationMs = 0 } = {}) {
  const provider = sttProvider();
  if (provider === 'none') {
    throw new Error(
      '没有可用的语音转写服务。\n' +
        '· 免费方案一：brew install whisper-cpp 并下载一个模型到 ~/.cache/whisper-models/\n' +
        '· 免费方案二：申请 Groq 的 API Key，export GROQ_API_KEY=gsk_...\n' +
        '· 或配置讯飞凭据 / OPENAI_API_KEY',
    );
  }
  const label =
    { local: '本地 whisper.cpp', xfyun: '讯飞', groq: 'Groq Whisper', openai: 'OpenAI Whisper' }[provider] ||
    provider;
  onProgress?.(`正在用 ${label} 转写…`);

  const r =
    provider === 'local'
      ? await transcribeLocal(audioPath, { onProgress })
      : provider === 'xfyun'
        ? await transcribeXfyun(audioPath, { onProgress, durationMs })
        : provider === 'groq'
          ? await transcribeGroq(audioPath)
          : await transcribeOpenAI(audioPath);
  return { provider, ...r };
}

/** 不带凭据的状态查询，供前端显示 */
export { sttProvider as currentProvider };
