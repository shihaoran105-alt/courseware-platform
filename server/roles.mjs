/**
 * 按文件名判断这份材料「是干什么用的」，用来决定它进哪个模式。
 *
 *   solution  → 标准答案/答案册，作为讲解时的「权威依据」，不进模式、只喂给模型
 *   lab       → 实验指导，进「做 Lab」，一步步带着做
 *   exercise  → 习题/作业（tut / tutorial / assignment …），进「做题」
 *   courseware→ 课件/讲义，作为讲解的主体
 *   video     → 上课录像，用来转写并对齐讲解稿
 *   other     → 其他附件
 *
 * 判断只看文件名，不猜内容；同一个项目里如果同时存在课件和习题，
 * 习题的讲解会自动「结合」那份课件。
 *
 * 注意 solution 的判定必须排在 lab / exercise 前面：
 * 「Tutorial 1 Solution.pdf」「Lab 4 Solution.pdf」这类文件同时命中两个规则，
 * 但它们真正的身份是答案，要和对应的题目文件配成一对，而不是当成题目本身。
 */

const SOLUTION_RE =
  /(^|[^a-z])(solutions?|soln|answers?|ans|answer\s*key|marking\s*scheme|rubric|worked\s*solutions?)([^a-z]|$)|答案|参考答案|标准答案|解答|题解/i;
const LAB_RE = /(^|[^a-z])(lab|labs|laboratory|practical|experiment|exp)([^a-z]|$)|实验|上机/i;
const EXERCISE_RE =
  /(^|[^a-z])(tut|tutorial|tutorials|assignment|assignments|homework|hw|exercise|exercises|coursework|pset|problem\s*set|quiz|test|exam)([^a-z]|$)|习题|作业|练习/i;

export const ROLES = ['solution', 'lab', 'exercise', 'courseware', 'video', 'other'];

/** 提取器返回的是 pdf / pptx / docx / text / sheet 这类具体类型，不是笼统的 document */
const DOC_KINDS = ['pdf', 'pptx', 'ppt', 'docx', 'doc', 'rtf', 'text', 'sheet', 'xlsx', 'xlsm', 'json', 'html', 'document'];

export function isDocKind(kind = '') {
  return DOC_KINDS.includes(String(kind));
}

/** 文件名里带答案字样 → 这是标准答案，不是题目本身 */
export function isSolutionName(name = '') {
  return SOLUTION_RE.test(String(name).toLowerCase());
}

export function classifyRole(name = '', kind = '') {
  const n = String(name).toLowerCase();
  if (kind === 'video' || kind === 'audio') return 'video';
  if (isSolutionName(n)) return 'solution';
  if (LAB_RE.test(n)) return 'lab';
  if (EXERCISE_RE.test(n)) return 'exercise';
  if (isDocKind(kind)) return 'courseware';
  return 'other';
}

/** 给人看的中文名 */
export function roleLabel(role) {
  return (
    {
      solution: '标准答案',
      lab: '实验指导',
      exercise: '习题 / 作业',
      courseware: '课件',
      video: '上课录像',
      other: '附件',
    }[role] || '附件'
  );
}

/**
 * 去掉文件名里「答案/附件」这类后缀和常见题号噪声，得到一个可比对的「同一份作业」的指纹。
 * 用来把 Tut 01 Solution.pdf 和 Tut 01.pdf 认成一对。
 */
function stemOf(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(SOLUTION_RE, ' ')
    .replace(LAB_RE, ' lab ')
    .replace(EXERCISE_RE, ' ')
    .replace(/[\s_\-–—.()[\]（）【】]+/g, ' ')
    .replace(/\b(v|ver|version|final|updated?|rev|draft)\b/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 指纹里的词集合，用来算重叠度 */
function tokensOf(name = '') {
  return new Set(stemOf(name).split(' ').filter((w) => w.length > 1));
}

/**
 * 指纹里的「题号」——只取 1~99 的数字，去掉前导零（02 和 2 是同一个）。
 * 课程代码（3311、3373）这类 4 位数是干扰项，必须排除，
 * 否则「Tut 02」会因为同属 EIE3311 而错误地配上「Tut 01 Solution」。
 */
function qnumsOf(name = '') {
  const out = new Set();
  for (const raw of stemOf(name).match(/\d+/g) || []) {
    const n = Number(raw);
    if (n >= 1 && n <= 99) out.add(String(n));
  }
  return out;
}

/**
 * 为一份题目文件挑出最匹配的标准答案文件。
 *
 * 只有一份答案时直接用它——用户既然只传了一份答案，意图很明显。
 * 有多份时按文件名指纹配对，并且**题号是最强的信号**：
 * 「Tut 02」绝不能配上「Tut 01 Solution」，哪怕它们同属一个课程代码。
 */
export function matchSolution(target, solutions = []) {
  const list = (solutions || []).filter(Boolean);
  if (!list.length) return null;
  if (!target) return list[0];
  if (list.length === 1) return list[0];

  const want = tokensOf(target.originalName || target);
  const wantQ = qnumsOf(target.originalName || target);

  let best = null;
  let bestScore = -Infinity;
  for (const s of list) {
    const got = tokensOf(s.originalName || s);
    const gotQ = qnumsOf(s.originalName || s);

    let hit = 0;
    for (const w of want) if (got.has(w)) hit += 1;
    // 归一化：避免长文件名仅因为词多就占优
    let score = hit / Math.max(want.size, got.size, 1);

    if (wantQ.size && gotQ.size) {
      const qHit = [...wantQ].filter((n) => gotQ.has(n)).length;
      if (!qHit) score -= 1; // 题号完全对不上 → 直接排除
      else score += 0.6 * (qHit / Math.max(wantQ.size, gotQ.size));
    }

    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  // 所有候选题号都对不上时，宁可不给答案，也不要拿错答案当权威
  return bestScore > -0.5 ? best : null;
}

/**
 * 看看这个项目里各类材料齐不齐，好决定模式怎么排。
 * @param {Array} files 项目里的文件记录
 */
export function projectShape(files = []) {
  const byRole = { solution: [], lab: [], exercise: [], courseware: [], video: [], other: [] };
  for (const f of files) {
    const role = f.role || classifyRole(f.originalName, f.kind);
    (byRole[role] || byRole.other).push(f);
  }
  const solutions = byRole.solution;
  return {
    ...byRole,
    hasSolution: solutions.length > 0,
    hasLab: byRole.lab.length > 0,
    hasExercise: byRole.exercise.length > 0,
    hasCourseware: byRole.courseware.length > 0,
    hasVideo: byRole.video.length > 0,
    // 有课件 + 有习题 → 习题讲解要「结合课件」
    canCombine: byRole.courseware.length > 0 && byRole.exercise.length > 0,
    // 只传了答案、没传题目：答案本身就含题干，照样能做题和讲解
    solutionOnly: solutions.length > 0 && !byRole.lab.length && !byRole.exercise.length,
    // 每份题目 → 它对应的那份标准答案
    solutionForExercise: byRole.exercise.map((f) => ({ file: f, solution: matchSolution(f, solutions) })),
    solutionForLab: byRole.lab.map((f) => ({ file: f, solution: matchSolution(f, solutions) })),
  };
}
