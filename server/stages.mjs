/**
 * 讲解模式的清单与推荐。
 *
 * 「点了分析到底生成哪些东西」这件事，服务端、静态版、前端弹窗都要用同一份定义，
 * 所以单独放这里，避免三处各写一份然后慢慢走样。
 *
 * 推荐的思路：看这个项目里有哪些类别的材料，只推荐真的用得上的模式 ——
 * 只传了一份实验指导，就没必要硬生成「学习规划」和「练习题」。
 */
import { classifyRole } from './roles.mjs';

/** 八个模式。key 和 pipeline 里的 stage key 一一对应 */
export const STAGE_CATALOG = [
  {
    key: 'analysis',
    label: '课件分析',
    labelEn: 'Courseware analysis',
    desc: '通读材料，讲清结构、重点难点，并列出核心概念。',
    descEn: 'Reads the material and lays out its structure, key points, difficult parts and core concepts.',
    tab: 'overview',
    basedOn: ['courseware', 'other'],
  },
  {
    key: 'examples',
    label: '事例讲解',
    labelEn: 'Worked examples',
    desc: '把材料里的例题、案例拆成「题目 → 分步讲解 → 通用方法 → 易错点」。',
    descEn: 'Breaks the examples in the material into question, step-by-step solution, general method and common mistakes.',
    tab: 'examples',
    basedOn: ['courseware'],
  },
  {
    key: 'guide',
    label: '学习规划',
    labelEn: 'Study plan',
    desc: '给学习者一份「这份材料该怎么学」的规划：先学什么、每部分花多久、怎么自测。',
    descEn: 'A study plan for the learner: what to study first, how long to spend, and how to check yourself.',
    tab: 'guide',
    basedOn: ['courseware'],
  },
  {
    key: 'narration',
    label: '逐页讲解稿',
    labelEn: 'Narration script',
    desc: '每一页写一段可以照着念的讲稿，并支持全屏讲解模式。',
    descEn: 'Writes a read-aloud script for every page, and powers presenter mode.',
    tab: 'narration',
    basedOn: ['courseware', 'lab', 'exercise'],
  },
  {
    key: 'summary',
    label: '总结分析',
    labelEn: 'Study notes',
    desc: '不按课件结构走，把里面的知识重新梳理一遍：表格 + 思维导图讲透，目标是让没看过课件的人也能学会。',
    descEn: 'Ignores the courseware structure and re-organises the knowledge itself — tables and mind maps, written to teach someone who never saw the deck.',
    tab: 'summary',
    basedOn: ['courseware', 'lab', 'exercise', 'other'],
  },
  {
    key: 'mindmap',
    label: '思维导图',
    labelEn: 'Mind map',
    desc: '把材料画成一张思维导图：节点尽量短，靠连线表达逻辑关系，文字只作提示。',
    descEn: 'Draws the material as a mind map — very short node labels, logic carried by the links rather than prose.',
    tab: 'mindmap',
    basedOn: ['courseware', 'lab', 'exercise', 'other'],
  },
  {
    key: 'quiz',
    label: '练习题',
    labelEn: 'Practice questions',
    desc: '整理出可以让学生动手做的题，附答案、解析与易错点。',
    descEn: 'Builds a set of questions students can work through, with answers, explanations and common pitfalls.',
    tab: 'quiz',
    basedOn: ['exercise', 'courseware'],
  },
  {
    key: 'lab',
    label: '做 Lab',
    labelEn: 'Lab',
    desc: '把实验内容整理成可以照着做的分步实验，含原理与记录表。',
    descEn: 'Turns the lab content into a step-by-step practical, with background theory and a results table.',
    tab: 'lab',
    basedOn: ['lab'],
  },
];

export const STAGE_KEYS = STAGE_CATALOG.map((s) => s.key);

export function stageLabel(key) {
  return STAGE_CATALOG.find((s) => s.key === key)?.label || key;
}

/**
 * 根据项目里的材料类别，推荐该生成哪些模式。
 * @returns {{picked: string[], why: string[], skippedByVideo: boolean}}
 */
export function recommendStages(files = []) {
  const roles = new Set(files.map((f) => f.role || classifyRole(f.originalName, f.kind)));
  const has = (r) => roles.has(r);

  const picked = new Set();
  const why = [];

  if (has('courseware')) {
    ['analysis', 'examples', 'guide', 'narration'].forEach((k) => picked.add(k));
    why.push('有课件 · 讲义 → 分析内容、讲事例、给教学方案、写逐页讲解稿');
  }
  if (has('lab')) {
    picked.add('lab');
    why.push('有实验指导 → 整理成可以照着做的 Lab');
  }
  if (has('exercise')) {
    picked.add('quiz');
    why.push('有习题 / 作业 → 整理成可以做的练习题');
  }
  if (has('courseware') || has('lab') || has('exercise')) {
    picked.add('summary');
    picked.add('mindmap');
    why.push('不管什么材料 → 都可以重新梳理一遍知识点（表格 + 思维导图），并单独画一张思维导图');
  }
  if (has('solution')) {
    // 答案册本身不产出模式，但它是讲解和出题的依据，单独说明一下
    why.push('有标准答案 → 讲题和出题时会以它为准');
  }

  // 上课录像：逐页讲解稿改用录像转写，这一轮不重复生成
  let skippedByVideo = false;
  if (has('video')) {
    if (picked.delete('narration')) skippedByVideo = true;
    why.push('有上课录像 → 逐页讲解稿稍后用录像转写生成，这一轮先不做');
  }

  // 一个模式都推不出来（比如只有图片、只有「其他」材料）
  if (!picked.size && !skippedByVideo) {
    picked.add('analysis');
    why.push('没有识别出具体类别 → 先做一次基础分析，把内容读一遍');
  }

  // 保持目录顺序，界面上不会跳来跳去
  const order = STAGE_KEYS.indexOf.bind(STAGE_KEYS);
  return { picked: [...picked].sort((a, b) => order(a) - order(b)), why, skippedByVideo };
}

/** 校验前端传来的模式清单：去掉不认识的、去重、保持目录顺序 */
export function normalizeStages(input) {
  if (!Array.isArray(input)) return null;
  const want = new Set(input.map((x) => String(x)));
  const out = STAGE_KEYS.filter((k) => want.has(k));
  return out.length ? out : null;
}
