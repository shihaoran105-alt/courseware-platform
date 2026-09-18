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
      other: '其他',
    }[role] || '其他'
  );
}

/**
 * 类别清单，给「点一下自己改类别」的选择面板用。
 *
 * 放在这里是想让服务端、静态版、前端共用同一份定义 ——
 * 否则以后加一个类别就要改三个地方，迟早漏一个。
 *   feeds: 这一类的材料会喂给哪些模式，选择面板里要如实告诉用户。
 */
export const ROLE_CATALOG = [
  {
    role: 'courseware',
    label: '课件',
    labelEn: 'Courseware',
    desc: '讲义、PPT、教材章节。作为讲解的主体和「课件原文」的来源。',
    descEn: 'Slides, handouts, textbook chapters. The main subject of the explanation and the source of quoted courseware text.',
    feeds: '课件分析 · 事例讲解 · 教学应用 · 逐页讲解 · 课件原文截图',
    feedsEn: 'Analysis · Worked examples · Teaching plan · Narration · Courseware screenshots',
  },
  {
    role: 'lab',
    label: '实验指导',
    labelEn: 'Lab sheet',
    desc: '实验手册、Lab sheet。用来生成可以照着做的「做 Lab」。',
    descEn: 'Lab manuals and lab sheets. Used to build the step-by-step Lab walkthrough.',
    feeds: '做 Lab · 结合课件讲解 · 逐页讲解',
    feedsEn: 'Lab · Explain with courseware · Narration',
  },
  {
    role: 'exercise',
    label: '习题 / 作业',
    labelEn: 'Tutorial / assignment',
    desc: 'Tutorial、Assignment、Past paper。用来出题和讲题。',
    descEn: 'Tutorials, assignments and past papers. Used to generate and explain questions.',
    feeds: '做题 · 结合课件讲解 · 逐页讲解',
    feedsEn: 'Practice · Explain with courseware · Narration',
  },
  {
    role: 'solution',
    label: '标准答案',
    labelEn: 'Official answers',
    desc: '老师发的答案册 / 题解。讲解时会以它为准，并标注答案出处。',
    descEn: 'Answer keys and worked solutions from the teaching team. Explanations follow it and cite where the answer came from.',
    feeds: '结合课件讲解（权威依据）· 出题时的参考答案',
    feedsEn: 'Explain with courseware (authoritative source) · Reference answers when generating questions',
  },
  {
    role: 'video',
    label: '上课录像',
    labelEn: 'Lecture recording',
    desc: '课堂录屏 / 录音。转写成文字后按课件页对齐成讲解稿。',
    descEn: 'Class recordings. Transcribed and aligned to courseware pages to form the narration script.',
    feeds: '逐页讲解（用录像里的真实讲法）',
    feedsEn: 'Narration (using what was actually said in class)',
  },
  {
    role: 'other',
    label: '其他',
    labelEn: 'Other',
    desc: '参考资料、数据表、附件。只作为背景内容参与分析，不单独占一个模式。',
    descEn: 'References, datasheets and attachments. Used as background material only; does not drive a mode of its own.',
    feeds: '课件分析时的背景材料',
    feedsEn: 'Background material for the analysis',
  },
];

/** 合法的类别（含 auto，表示交给文件名自动判断） */
export const ROLE_IDS = [...ROLES, 'auto'];

export function isValidRole(role) {
  return ROLE_IDS.includes(String(role));
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
