/* ============================================================
   静态版引导脚本（必须是普通脚本，且在 app.js 之前加载）
   1) 同步设置 window.CW_STATIC，app.js 在解析时就要读到
   2) 用动态 import 懒加载 ESM 引擎，避免 app.js 的初始化跑在引擎之前
   3) 顺便把 pdf.js 预加载好（解析 PDF 时才用得到）
   ============================================================ */

window.CW_STATIC = true;

let enginePromise = null;
const engine = () => (enginePromise ??= import('./engine/backend.js'));

window.CWBackend = {
  async api(path, options) {
    return (await engine()).api(path, options);
  },
  async postSSE(path, body, onEvent) {
    return (await engine()).postSSE(path, body, onEvent);
  },
  async upload(projectId, files, onProgress) {
    return (await engine()).upload(projectId, files, onProgress);
  },
  async downloadExport(projectId) {
    return (await engine()).downloadExport(projectId);
  },
};

// pdf.js 是 ESM，这里预加载并把实例挂到 window，供 engine/extract.js 使用
window.pdfjsReady = import('./vendor/pdf.min.mjs')
  .then((m) => {
    m.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
    window.pdfjsLib = m;
    return m;
  })
  .catch((err) => {
    console.error('[pdf.js 加载失败]', err);
    return null;
  });
