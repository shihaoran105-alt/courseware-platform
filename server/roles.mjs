/**
 * 按文件名判断这份材料「是干什么用的」，用来决定它进哪个模式。
 *
 *   lab       → 实验指导，进「做 Lab」，一步步带着做
 *   exercise  → 习题/作业（tut / tutorial / assignment …），进「做题」
 *   courseware→ 课件/讲义，作为讲解的主体
 *   video     → 上课录像，用来转写并对齐讲解稿
 *   other     → 其他附件
 *
 * 判断只看文件名，不猜内容；同一个项目里如果同时存在课件和习题，
 * 习题的讲解会自动「结合」那份课件。
 */

const LAB_RE = /(^|[^a-z])(lab|labs|laboratory|practical|experiment|exp)([^a-z]|$)|实验|上机/i;
const EXERCISE_RE =
  /(^|[^a-z])(tut|tutorial|tutorials|assignment|assignments|homework|hw|exercise|exercises|coursework|pset|problem\s*set|quiz|test|exam)([^a-z]|$)|习题|作业|练习/i;

export const ROLES = ['lab', 'exercise', 'courseware', 'video', 'other'];

/** 提取器返回的是 pdf / pptx / docx / text / sheet 这类具体类型，不是笼统的 document */
const DOC_KINDS = ['pdf', 'pptx', 'ppt', 'docx', 'doc', 'rtf', 'text', 'sheet', 'xlsx', 'xlsm', 'json', 'html', 'document'];

export function isDocKind(kind = '') {
  return DOC_KINDS.includes(String(kind));
}

export function classifyRole(name = '', kind = '') {
  const n = String(name).toLowerCase();
  if (kind === 'video' || kind === 'audio') return 'video';
  if (LAB_RE.test(n)) return 'lab';
  if (EXERCISE_RE.test(n)) return 'exercise';
  if (isDocKind(kind)) return 'courseware';
  return 'other';
}

/** 给人看的中文名 */
export function roleLabel(role) {
  return (
    {
      lab: '实验指导',
      exercise: '习题 / 作业',
      courseware: '课件',
      video: '上课录像',
      other: '附件',
    }[role] || '附件'
  );
}

/**
 * 看看这个项目里各类材料齐不齐，好决定模式怎么排。
 * @param {Array} files 项目里的文件记录
 */
export function projectShape(files = []) {
  const byRole = { lab: [], exercise: [], courseware: [], video: [], other: [] };
  for (const f of files) byRole[f.role || classifyRole(f.originalName, f.kind)].push(f);
  return {
    ...byRole,
    hasLab: byRole.lab.length > 0,
    hasExercise: byRole.exercise.length > 0,
    hasCourseware: byRole.courseware.length > 0,
    hasVideo: byRole.video.length > 0,
    // 有课件 + 有习题 → 习题讲解要「结合课件」
    canCombine: byRole.courseware.length > 0 && byRole.exercise.length > 0,
  };
}
