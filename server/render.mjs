/**
 * 课件渲染：把上传的课件变成「可以在浏览器里逐页画成图片」的 PDF。
 *
 *   PDF          → 直接复制
 *   PPTX / DOCX  → LibreOffice headless 转 PDF
 *   其他         → 放弃，前端退回文字模式
 *
 * 为什么中间要过一层 PDF：浏览器只有 pdf.js 这一个通用的高分页渲染引擎，
 * 而 PDF 页面画出来的就是「原文件在常规大小下的样子」，正是我们想要的截图。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { rendererState } from './config.mjs';

const execFileAsync = promisify(execFile);

/** 能被 LibreOffice 转成 PDF 的格式 */
export const CONVERTIBLE_EXTS = ['pptx', 'ppt', 'docx', 'doc', 'rtf', 'odt', 'odp', 'ods', 'xlsx', 'xls', 'csv'];

export function canRender(ext) {
  if (ext === 'pdf') return true;
  return CONVERTIBLE_EXTS.includes(ext) && rendererState().office;
}

/**
 * 生成预览用 PDF
 * @param {{srcPath:string, ext:string, outPath:string, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, outPath?:string, reason?:string, ms?:number}>}
 */
export async function buildPreviewPdf({ srcPath, ext, outPath, timeoutMs = 180000 }) {
  const started = Date.now();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // 1) 本来就是 PDF
  if (ext === 'pdf') {
    try {
      fs.copyFileSync(srcPath, outPath);
      return { ok: true, outPath, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, reason: `复制 PDF 失败：${err.message}` };
    }
  }

  // 2) Office 文档 → LibreOffice 转 PDF
  const { office, soffice } = rendererState();
  if (!CONVERTIBLE_EXTS.includes(ext)) {
    return { ok: false, reason: `.${ext} 不支持转成截图` };
  }
  if (!office) {
    return { ok: false, reason: '未安装 LibreOffice，无法把 Office 文档转成截图' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lo-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lo-profile-'));
  try {
    await execFileAsync(
      soffice,
      [
        '--headless',
        '--norestore',
        '--nolockcheck',
        `-env:UserInstallation=file://${profile}`,
        '--convert-to',
        'pdf',
        '--outdir',
        tmpDir,
        srcPath,
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );

    // LibreOffice 输出文件名 = 原文件名（扩展名换成 pdf）
    const base = path.basename(srcPath).replace(/\.[^.]+$/, '');
    let produced = path.join(tmpDir, `${base}.pdf`);
    if (!fs.existsSync(produced)) {
      // 偶发大小写/编码差异，扫一遍目录兜底
      const pdfs = fs.readdirSync(tmpDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
      if (!pdfs.length) {
        return { ok: false, reason: 'LibreOffice 没有输出 PDF（文件可能已损坏或格式不受支持）' };
      }
      produced = path.join(tmpDir, pdfs[0]);
    }

    const stat = fs.statSync(produced);
    if (stat.size < 512) {
      return { ok: false, reason: 'LibreOffice 输出的 PDF 异常小，可能转换失败' };
    }
    fs.copyFileSync(produced, outPath);
    return { ok: true, outPath, ms: Date.now() - started };
  } catch (err) {
    const msg = String(err.stderr || err.message || err).slice(0, 300);
    return { ok: false, reason: `LibreOffice 转换失败：${msg}` };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** 给媒体文件名加个短随机后缀，避免并发覆盖 */
export function mediaName(prefix, ext) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
}
