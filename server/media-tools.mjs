/**
 * 音视频处理（依赖 ffmpeg）
 * 只做三件事：探测时长、提取音轨、按大小切段。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

let ffmpegPath = null;
let probed = false;

export function findFfmpeg() {
  if (probed) return ffmpegPath;
  probed = true;
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(p)) {
        ffmpegPath = p;
        break;
      }
    } catch {
      /* 忽略 */
    }
  }
  return ffmpegPath;
}

export function ffmpegState() {
  const p = findFfmpeg();
  return { available: Boolean(p), path: p, note: p ? '' : '未安装 ffmpeg，无法从视频里提取音频' };
}

async function run(args, timeoutMs = 30 * 60 * 1000) {
  const bin = findFfmpeg();
  if (!bin) throw new Error('未安装 ffmpeg，无法处理音视频。请先 brew install ffmpeg');
  return execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
}

/** 时长（秒） */
export async function probeDuration(file) {
  const bin = findFfmpeg();
  if (!bin) return 0;
  try {
    // ffmpeg -i 会把信息打到 stderr，从中读 Duration
    const { stderr } = await execFileAsync(bin, ['-i', file, '-hide_banner'], { timeout: 60000 }).catch((e) => ({
      stderr: String(e.stderr || ''),
    }));
    const m = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {
    return 0;
  }
}

/**
 * 从视频/音频里抽出一条 16k 单声道 wav（转写接口的通用要求）
 * @returns {Promise<{ok:boolean, out?:string, duration:number, reason?:string}>}
 */
export async function extractAudio(src, out, { sampleRate = 16000, channels = 1 } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    await run(['-y', '-i', src, '-vn', '-ac', String(channels), '-ar', String(sampleRate), '-f', 'wav', out]);
    const duration = await probeDuration(out);
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    if (!size) return { ok: false, duration: 0, reason: '提取出的音频是空的（视频可能没有音轨）' };
    return { ok: true, out, duration, size };
  } catch (err) {
    const msg = String(err.stderr || err.message || err).slice(-400);
    return { ok: false, duration: 0, reason: `ffmpeg 提取音频失败：${msg}` };
  }
}

/**
 * 按「秒数」切成多段（转写接口常限制单次时长/体积）
 * @returns {Promise<string[]>} 切出来的分片路径
 */
export async function splitAudio(src, outDir, segmentSeconds = 600) {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, 'part-%03d.wav');
  await run(['-y', '-i', src, '-f', 'segment', '-segment_time', String(segmentSeconds), '-c', 'copy', pattern], 60 * 60 * 1000);
  return fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.wav'))
    .sort()
    .map((f) => path.join(outDir, f));
}
