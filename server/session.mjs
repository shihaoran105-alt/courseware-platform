/**
 * 匿名会话：给每个访客发一个 httpOnly 的 cookie，用来隔离各自的课件与做题记录。
 *
 * 为什么不用登录：这个工具的定位是「打开就能用」。所以用匿名会话做数据隔离，
 * 不做账号体系；换浏览器/清 cookie 就是一份新空间。
 */
import crypto from 'node:crypto';

const COOKIE = 'cw_sid';
const SID_RE = /^[a-f0-9]{32}$/;

/** 每个会话的资源上限，防止公开部署被人刷爆磁盘 */
export const QUOTAS = {
  maxProjects: Number(process.env.MAX_PROJECTS_PER_SESSION) || 30,
  maxStorageMb: Number(process.env.MAX_STORAGE_MB) || 500,
  analyzePerHour: Number(process.env.RATE_ANALYZE_PER_HOUR) || 20,
  gradePerHour: Number(process.env.RATE_GRADE_PER_HOUR) || 400,
  uploadsPerHour: Number(process.env.RATE_UPLOAD_PER_HOUR) || 80,
};

/** sid → { createdAt, lastSeen, bytes, hits: { analyze: [ts], ... } } */
const sessions = new Map();
const HOUR = 3600 * 1000;

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function touch(sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = { createdAt: Date.now(), lastSeen: Date.now(), bytes: 0, hits: {} };
    sessions.set(sid, s);
  }
  s.lastSeen = Date.now();
  return s;
}

export function sessionMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  let sid = cookies[COOKIE];
  if (!SID_RE.test(sid || '')) {
    sid = crypto.randomBytes(16).toString('hex');
    res.cookie(COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 3600 * 1000,
      path: '/',
    });
  }
  req.sid = sid;
  touch(sid);
  next();
}

export function sessionInfo(sid) {
  return sessions.get(sid) || touch(sid);
}

export function addBytes(sid, n) {
  const s = touch(sid);
  s.bytes += Math.max(0, Number(n) || 0);
  return s.bytes;
}

export function usedBytes(sid) {
  return sessions.get(sid)?.bytes || 0;
}

export function overStorage(sid) {
  return usedBytes(sid) > QUOTAS.maxStorageMb * 1024 * 1024;
}

/**
 * 简易限流：同一会话在某类操作上每小时最多 N 次。
 * @returns {{ok: boolean, retryAfterSec?: number}}
 */
export function checkRate(sid, action) {
  const limitKey = `${action}PerHour`;
  const limit = QUOTAS[limitKey];
  if (!limit) return { ok: true };
  const s = touch(sid);
  const now = Date.now();
  const list = (s.hits[action] || []).filter((t) => now - t < HOUR);
  if (list.length >= limit) {
    return { ok: false, retryAfterSec: Math.ceil((HOUR - (now - list[0])) / 1000) };
  }
  list.push(now);
  s.hits[action] = list;
  return { ok: true };
}

/** 定期清掉长期不活跃的会话记录（只清内存计数，不动磁盘数据） */
export function sweepSessions(maxIdleMs = 7 * 24 * HOUR) {
  const now = Date.now();
  let n = 0;
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > maxIdleMs) {
      sessions.delete(sid);
      n++;
    }
  }
  return n;
}
