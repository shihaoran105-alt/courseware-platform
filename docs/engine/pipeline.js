/**
 * 分析流水线：课件 → 内容分析 → 事例讲解 → 教学应用方案 → 逐页讲解稿 → 练习题 → Lab
 *
 * 每个阶段独立容错：某一阶段失败不会让整体失败，前端会看到哪一步出错。
 */
import { AIError, completeJSON, stream } from './ai.js';
import {
  ANALYZE_SYSTEM,
  CHAT_SYSTEM,
  EXAMPLES_SYSTEM,
  EXPLAIN_SYSTEM,
  GRADE_SYSTEM,
  GUIDE_SYSTEM,
  LABCHECK_SYSTEM,
  LAB_SYSTEM,
  NARRATION_SYSTEM,
  QUIZ_SYSTEM,
  analyzeUser,
  chatUser,
  examplesUser,
  explainUser,
  gradeUser,
  guideUser,
  labCheckUser,
  labUser,
  narrationUser,
  quizUser,
} from './prompts.js';

/** 把文件清单整理成给模型看的一行行摘要 */
export function fileSummary(files) {
  return files
    .map((f) => {
      const bits = [`类型 ${f.kind}`];
      if (f.meta?.pages) bits.push(`${f.meta.pages} 页`);
      if (f.meta?.slides) bits.push(`${f.meta.slides} 页幻灯片`);
      if (f.meta?.withNotes) bits.push(`含 ${f.meta.withNotes} 页备注`);
      if (f.meta?.tables) bits.push(`${f.meta.tables} 个表格`);
      return `- ${f.originalName}（${bits.join('，')}）`;
    })
    .join('\n');
}

const CHUNK_CHARS = 12000;
const CHUNK_BLOCKS = 10;

/** 按块把课件切成若干段（逐页讲解稿需要分段生成，避免一次输出太长被截断） */
function chunkBlocks(files) {
  const chunks = [];
  for (const f of files) {
    if (!f.text) continue;
    const usable = f.blocks.filter((b) => String(b.text || '').trim());
    if (!usable.length) continue;

    let current = [];
    let size = 0;
    for (const b of usable) {
      const len = b.text.length;
      if (current.length && (size + len > CHUNK_CHARS || current.length >= CHUNK_BLOCKS)) {
        chunks.push({ file: f.originalName, blocks: current });
        current = [];
        size = 0;
      }
      current.push(b);
      size += len;
    }
    if (current.length) chunks.push({ file: f.originalName, blocks: current });
  }
  return chunks;
}

function chunkToContext(chunk) {
  return chunk.blocks.map((b) => `[${b.label}] ${b.text}`).join('\n\n');
}

/**
 * 分段生成逐页讲解稿（长课件一次性输出会被截断，所以按 10 页 / 12000 字切段后合并）
 * 单段失败只跳过该段，不影响整体。
 */
export async function generateNarration({ files, cfg, emit = () => {}, signal, onUsage = () => {} }) {
  const chunks = chunkBlocks(files.list);
  if (!chunks.length) return { segments: [] };
  const segments = [];
  for (let i = 0; i < chunks.length; i++) {
    emit({
      type: 'stage-detail',
      stage: 'narration',
      message: `正在撰写讲解稿 ${i + 1}/${chunks.length}（${chunks[i].file}）`,
    });
    try {
      const { data, usage } = await completeJSON(cfg, {
        system: NARRATION_SYSTEM,
        user: narrationUser(chunkToContext(chunks[i]), files.list),
        maxTokens: 8000,
        signal,
      });
      onUsage(usage);
      if (Array.isArray(data?.segments)) segments.push(...data.segments);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      emit({
        type: 'stage-detail',
        stage: 'narration',
        level: 'warn',
        message: `第 ${i + 1} 段讲解稿生成失败，已跳过：${err.message}`,
      });
    }
  }
  return { segments };
}

/**
 * 执行完整分析流水线
 * @param {object} opts
 * @param {Array} opts.files 已抽取的文件
 * @param {object} opts.cfg 运行时配置
 * @param {(evt:object)=>void} opts.emit 进度回调
 */
export async function runFullAnalysis({ files, cfg, emit = () => {}, signal }) {
  const started = Date.now();
  const context = files.context;
  const summary = fileSummary(files.list);
  const result = {
    analysis: null,
    examples: null,
    guide: null,
    narration: null,
    quiz: null,
    lab: null,
    errors: [],
    usage: { promptTokens: 0, completionTokens: 0 },
    model: cfg.model,
    generatedAt: new Date().toISOString(),
    elapsedMs: 0,
  };

  const addUsage = (u) => {
    if (!u) return;
    result.usage.promptTokens += u.prompt_tokens || 0;
    result.usage.completionTokens += u.completion_tokens || 0;
  };

  if (!context) {
    throw new AIError('这些文件里没有可分析的文字内容（可能是纯图片或扫描件）。建议上传含文字的 PDF / PPTX / DOCX。');
  }

  const stages = [
    {
      key: 'analysis',
      label: '分析课件内容',
      weight: 30,
      run: async () => {
        const { data, usage } = await completeJSON(cfg, {
          system: ANALYZE_SYSTEM,
          user: analyzeUser(context, summary),
          maxTokens: 8000,
          signal,
        });
        addUsage(usage);
        return data;
      },
    },
    {
      key: 'examples',
      label: '讲解课件中的事例',
      weight: 30,
      run: async () => {
        const { data, usage } = await completeJSON(cfg, {
          system: EXAMPLES_SYSTEM,
          user: examplesUser(context, summary),
          maxTokens: 8000,
          signal,
        });
        addUsage(usage);
        return data;
      },
    },
    {
      key: 'guide',
      label: '生成教学应用方案',
      weight: 25,
      run: async () => {
        const { data, usage } = await completeJSON(cfg, {
          system: GUIDE_SYSTEM,
          user: guideUser(context, summary),
          maxTokens: 8000,
          signal,
        });
        addUsage(usage);
        return data;
      },
    },
    {
      key: 'narration',
      label: '撰写逐页讲解稿',
      weight: 12,
      run: () => generateNarration({ files, cfg, emit, signal, onUsage: addUsage }),
    },
    {
      key: 'quiz',
      label: '整理练习题',
      weight: 10,
      run: async () => {
        const { data, usage } = await completeJSON(cfg, {
          system: QUIZ_SYSTEM,
          user: quizUser(context, summary),
          maxTokens: 8000,
          signal,
        });
        addUsage(usage);
        return data;
      },
    },
    {
      key: 'lab',
      label: '整理实验（Lab）',
      weight: 8,
      run: async () => {
        const { data, usage } = await completeJSON(cfg, {
          system: LAB_SYSTEM,
          user: labUser(context, summary),
          maxTokens: 8000,
          signal,
        });
        addUsage(usage);
        return data;
      },
    },
  ];

  const totalWeight = stages.reduce((n, s) => n + s.weight, 0);
  let doneWeight = 0;

  for (const stage of stages) {
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    emit({ type: 'stage', stage: stage.key, label: stage.label, status: 'start', progress: doneWeight / totalWeight });
    const t0 = Date.now();
    try {
      const data = await stage.run();
      result[stage.key] = data;
      doneWeight += stage.weight;
      emit({
        type: 'stage',
        stage: stage.key,
        label: stage.label,
        status: 'done',
        ms: Date.now() - t0,
        progress: doneWeight / totalWeight,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      doneWeight += stage.weight;
      result.errors.push({ stage: stage.key, label: stage.label, message: err.message });
      emit({
        type: 'stage',
        stage: stage.key,
        label: stage.label,
        status: 'error',
        message: err.message,
        progress: doneWeight / totalWeight,
      });
    }
  }

  result.elapsedMs = Date.now() - started;
  emit({ type: 'done', progress: 1, elapsedMs: result.elapsedMs, errors: result.errors });
  return result;
}

/** 单个阶段重跑（前端「重新生成」按钮用） */
export async function rerunStage({ stage, files, cfg, signal }) {
  const context = files.context;
  const summary = fileSummary(files.list);
  switch (stage) {
    case 'analysis': {
      const { data } = await completeJSON(cfg, {
        system: ANALYZE_SYSTEM,
        user: analyzeUser(context, summary),
        maxTokens: 8000,
        signal,
      });
      return data;
    }
    case 'examples': {
      const { data } = await completeJSON(cfg, {
        system: EXAMPLES_SYSTEM,
        user: examplesUser(context, summary),
        maxTokens: 8000,
        signal,
      });
      return data;
    }
    case 'guide': {
      const { data } = await completeJSON(cfg, {
        system: GUIDE_SYSTEM,
        user: guideUser(context, summary),
        maxTokens: 8000,
        signal,
      });
      return data;
    }
    case 'narration':
      return generateNarration({ files, cfg, signal });
    case 'quiz': {
      const { data } = await completeJSON(cfg, {
        system: QUIZ_SYSTEM,
        user: quizUser(context, summary),
        maxTokens: 8000,
        signal,
      });
      return data;
    }
    case 'lab': {
      const { data } = await completeJSON(cfg, {
        system: LAB_SYSTEM,
        user: labUser(context, summary),
        maxTokens: 8000,
        signal,
      });
      return data;
    }
    default:
      throw new Error(`未知阶段：${stage}`);
  }
}

/** 针对课件的追问，流式返回 */
export async function askQuestion({ files, cfg, question, history = [], signal, onDelta }) {
  const messages = history
    .filter((m) => m && m.content)
    .slice(-8)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));

  return stream(cfg, {
    system: CHAT_SYSTEM,
    messages,
    user: chatUser(files.context || '（课件没有可提取的文字内容）', question),
    maxTokens: 4096,
    temperature: 0.3,
    signal,
    onDelta,
  });
}

/** 批改一道题：学生答案 → 判定 + 分数 + 讲解 */
export async function gradeAnswer({ cfg, question, studentAnswer, signal }) {
  const { data, usage } = await completeJSON(cfg, {
    system: GRADE_SYSTEM,
    user: gradeUser({ question, studentAnswer }),
    maxTokens: 3000,
    temperature: 0.2,
    signal,
  });
  return { result: data, usage };
}

/** 检查学生提交的实验记录 */
export async function checkLab({ cfg, lab, records, signal }) {
  const { data, usage } = await completeJSON(cfg, {
    system: LABCHECK_SYSTEM,
    user: labCheckUser({ lab, records }),
    maxTokens: 3500,
    temperature: 0.2,
    signal,
  });
  return { result: data, usage };
}

/* ---------------------- 结合课件讲解题目 ---------------------- */

/**
 * 从课件里挑出与某道题最相关的原文片段。
 * 先按「页码 ±2」定位（并区分页码 / 幻灯片），定位不到就退化成开头若干段。
 */
export function focusExcerpt(files, location, maxChars = 14000) {
  const list = files?.list || [];
  const loc = String(location || '');
  const nums = (loc.match(/\d+/g) || []).map(Number);
  const wantSlide = /幻灯片/.test(loc);

  let picked = [];
  if (nums.length) {
    for (const f of list) {
      for (const b of f.blocks || []) {
        const n = b.index ?? b.page;
        if (n == null) continue;
        const isSlide = b.type === 'slide' || f.kind === 'pptx';
        if (isSlide !== wantSlide) continue;
        if (nums.some((x) => Math.abs(Number(n) - x) <= 2)) picked.push({ file: f.originalName, b });
      }
    }
  }
  if (!picked.length) {
    for (const f of list) {
      for (const b of (f.blocks || []).slice(0, 5)) picked.push({ file: f.originalName, b });
    }
  }

  const seen = new Set();
  let out = '';
  for (const { file, b } of picked) {
    const key = `${file}#${b.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const piece = `[${b.label}]（来自 ${file}）\n${b.text}\n\n`;
    if (out.length + piece.length > maxChars) break;
    out += piece;
  }
  return out.trim();
}

/**
 * 结合课件原文讲解一道题。
 * 同时返回 usedExcerpt，前端可以把「课件原文」和「AI 讲解」并排展示。
 */
export async function explainQuestion({ cfg, question, files, concepts, title, signal }) {
  const excerpt = focusExcerpt(files, question.location);
  const { data, usage } = await completeJSON(cfg, {
    system: EXPLAIN_SYSTEM,
    user: explainUser({ question, excerpt, concepts, analysisTitle: title }),
    maxTokens: 6000,
    temperature: 0.25,
    signal,
  });
  return { result: data, excerpt, usage };
}

