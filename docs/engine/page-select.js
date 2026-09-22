/**
 * 「这一页要不要读图」的判定规则。
 *
 * 服务端（server/index.mjs + server/render-pages.mjs）和 GitHub Pages 静态版
 * （static-src/backend.js）都用这一份，避免两边阈值各调各的。
 * 这里只放纯逻辑，不碰 Node 内置模块，静态版才能直接编译过去用。
 */

/** 读图模式：auto = 只读图片/表格/框图多的页；all = 每页都读；text = 纯文字 */
export const READ_MODES = ['auto', 'all', 'text'];

export const READ_MODE_LABEL = {
  auto: '自动（只读图表页）',
  all: '全部读图',
  text: '纯文字',
};

/** 浏览器里没有 process，取值失败就用默认 */
function envNum(name, fallback) {
  try {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 阈值由真实课件量出来的：扫了 460 页真实课件后，
 * 146 页的位图覆盖率几乎为 0（纯文字），191 页接近 1.0（整页扫描/导出图），
 * 中间那几十页是一张配图。页眉 logo、装饰底图只占百分之几，
 * 所以 0.15 正好把「配图」和「装饰」分开。
 */
export const IMG_RATIO_MIN = envNum('PAGE_IMG_RATIO_MIN', 0.15);

/** 矢量线段数：表格框线、流程图、坐标轴。纯文字页 90% 都在 40 以下 */
export const PATH_SEGS_MIN = envNum('PAGE_PATH_SEGS_MIN', 60);

/** 这一页是不是「图表页」 */
export function pageNeedsImage(stat) {
  if (!stat) return false;
  return Number(stat.imgRatio) >= IMG_RATIO_MIN || Number(stat.pathSegs) >= PATH_SEGS_MIN;
}

/**
 * 按模式挑出要渲染成图片、送给视觉模型的页码（升序）。
 *
 * @param {Array<{page:number, imgRatio:number, pathSegs:number}>} stats
 * @param {'auto'|'all'|'text'} mode
 */
export function selectPages(stats, mode = 'auto') {
  const list = Array.isArray(stats) ? stats : [];
  if (mode === 'text') return [];
  if (mode === 'all') {
    return list
      .map((s) => Number(s.page))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }
  return list
    .filter(pageNeedsImage)
    .map((s) => Number(s.page))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
}

/**
 * 从请求体里解析读图模式。
 * 兼容老客户端：以前只有一个 readPages 开关，关掉就等于纯文字。
 */
export function readModeOf(body = {}) {
  const m = String(body?.readPagesMode || '');
  if (READ_MODES.includes(m)) return m;
  return body?.readPages === false ? 'text' : 'auto';
}

/**
 * 从 pdf.js 的 operator list 里数出这一页的指标。
 *
 * 两个数字都是从绘图指令直接数出来的，不需要把页面渲染成图片：
 *  - imgRatio：位图覆盖的面积占整页的比例（整页扫描件 ≈ 1.0，一张配图 0.2~0.5，
 *    页眉 logo 只有百分之几 —— 光看「有没有图」是分不出来的）
 *  - pathSegs：矢量绘制的线段数（表格框线、流程图、电路图、坐标轴）
 *
 * @param {object} ops pdf.js 的 operator list
 * @param {object} OPS pdfjs.OPS
 * @param {number} pageArea 页面宽 × 高（scale=1）
 */
export function statsFromOperatorList(ops, OPS, pageArea) {
  const IMG_OPS = new Set(
    [
      OPS.paintImageXObject,
      OPS.paintJpegXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintImageMaskXObjectRepeat,
    ].filter((v) => v !== undefined),
  );
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let imgArea = 0;
  let imgCount = 0;
  let pathSegs = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const a = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform && a && a.length >= 6) ctm = mul(ctm, a);
    else if (IMG_OPS.has(fn)) {
      imgCount++;
      // 单位正方形经过 CTM 之后的面积，就是这张图实际画出来占多大
      imgArea += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
    } else if (fn === OPS.constructPath && a && a[0]) {
      pathSegs += a[0].length;
    }
  }
  return {
    imgCount,
    imgRatio: imgArea / Math.max(1, pageArea),
    pathSegs,
  };
}
