/**
 * 分析流水线：课件 → 内容分析 → 事例讲解 → 教学应用方案 → 逐页讲解稿 → 练习题 → Lab
 *
 * 每个阶段独立容错：某一阶段失败不会让整体失败，前端会看到哪一步出错。
 */
import { AIError, completeJSON, stream } from './client.mjs';
import {
  ALIGN_SYSTEM,
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
  TRANSLATE_SYSTEM,
  alignUser,
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
  translateUser,
} from './prompts.mjs';

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
export async function runFullAnalysis({ files, cfg, emit = () => {}, signal, skipNarration = false }) {
  const started = Date.now();
  const context = files.context;
  const summary = fileSummary(files.list);
  // 有答案册就把答案原文一并交给模型，answer 字段以它为准
  const key = answerKeyExcerpt(files, {});
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
          user: quizUser(context, summary, key.text),
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

  // 有上课录像时，讲解稿由录像转写产生，这里不再重复生成
  const active = skipNarration ? stages.filter((s) => s.key !== 'narration') : stages;
  if (skipNarration) {
    result.narration = { segments: [], skipped: true, reason: '已上传上课录像，讲解稿将以录像转写为准' };
    emit({
      type: 'stage',
      stage: 'narration',
      label: '撰写逐页讲解稿',
      status: 'done',
      ms: 0,
      progress: 0,
      message: '已跳过：将以上课录像的转写为准',
    });
  }

  const totalWeight = active.reduce((n, s) => n + s.weight, 0);
  let doneWeight = 0;

  for (const stage of active) {
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
        user: quizUser(context, summary, answerKeyExcerpt(files, {}).text),
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

/** 位置标记里的「第 N 页」→ N，用来在答案册里找对应页 */
function pageNumsOf(text = '') {
  return [...String(text).matchAll(/第\s*(\d+)\s*页/g)].map((m) => Number(m[1]));
}

/**
 * 取出「官方标准答案」的原文，交给模型当权威依据。
 *
 * 只喂答案册里和这道题相关的页，全塞进去会撑爆上下文、也会让模型跑题。
 * 定位不到页码时退而给整份答案册（通常答案册不长）。
 */
export function answerKeyExcerpt(files, target = {}, maxChars = 12000) {
  const list = files?.list || [];
  let solutions = list.filter((f) => f.role === 'solution' && (f.blocks || []).length);
  if (!solutions.length) return { text: '', from: '' };
  // 调用方已经配对好是哪一份答案册时，就只用那一份，避免串题
  if (target.solutionName) {
    const one = solutions.find((f) => f.originalName === target.solutionName);
    if (one) solutions = [one];
  }

  const wantPages = [
    ...pageNumsOf(target.location),
    ...pageNumsOf(target.stem),
  ].filter((n, i, a) => Number.isFinite(n) && a.indexOf(n) === i);

  const parts = [];
  const names = [];
  for (const f of solutions) {
    names.push(f.originalName);
    const blocks = f.blocks || [];
    let picked = blocks;
    if (wantPages.length) {
      const hit = blocks.filter((b) => {
        const n = Number(b.page ?? b.index);
        return Number.isFinite(n) && wantPages.some((x) => Math.abs(x - n) <= 1);
      });
      if (hit.length) picked = hit;
    }
    for (const b of picked) parts.push(`【${f.originalName} · ${b.label || ''}】\n${String(b.text || '').trim()}`);
  }

  let text = parts.filter((p) => p.trim()).join('\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（答案册内容较长，已截断）';
  return { text, from: names.join('、') };
}

/**
 * 结合课件原文讲解一道题。
 * 同时返回 usedExcerpt，前端可以把「课件原文」和「AI 讲解」并排展示。
 */
export async function explainQuestion({ cfg, question, files, concepts, title, signal, answerKey, answerKeyFrom }) {
  const excerpt = focusExcerpt(files, question.location);
  // 调用方没显式给答案册时，自己从项目里找一份（答案册和题目按文件名配对）
  let keyText = answerKey;
  let keyFrom = answerKeyFrom;
  if (keyText === undefined) {
    const found = answerKeyExcerpt(files, { location: question.location, stem: question.stem });
    keyText = found.text;
    keyFrom = found.from;
  }
  const { data, usage } = await completeJSON(cfg, {
    system: EXPLAIN_SYSTEM,
    user: explainUser({ question, excerpt, concepts, analysisTitle: title, answerKey: keyText, answerKeyFrom: keyFrom }),
    maxTokens: 6000,
    temperature: 0.25,
    signal,
  });
  return { result: data, excerpt, answerKeyUsed: keyText ? keyFrom : '', usage };
}



/* ---------------------- 上课录像 → 逐页讲解稿 ---------------------- */

/** 课件页清单（按顺序），用于和录像转写对齐 */
export function pageListFor(files, maxChars = 40000) {
  const out = [];
  const docs = (files.list || []).filter((f) => f.role !== 'video' && (f.blocks || []).length);
  // 多份文档时，「第 1 页」会在不同文件里重复，必须带上文件名才能唯一对应
  const multi = docs.length > 1;
  for (const f of docs) {
    const tag = multi ? f.originalName : '';
    for (const b of f.blocks || []) {
      const text = String(b.text || '').trim();
      if (!text) continue;
      out.push({
        location: tag ? `${b.label}｜${tag}` : b.label,
        title: b.title || '',
        points: [text.slice(0, 300)],
      });
    }
  }
  // 页数太多时按预算等比截断要点，避免把对齐请求撑爆
  const total = out.reduce((n, p) => n + p.points[0].length, 0);
  if (total > maxChars) {
    const k = maxChars / total;
    for (const p of out) p.points = [p.points[0].slice(0, Math.max(60, Math.floor(p.points[0].length * k)))];
  }
  return out;
}

/** 转写主要是英文还是中文 */
export function detectLang(segments) {
  const text = (segments || []).map((s) => s.text || '').join('');
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  return latin > cjk * 3 ? 'en' : 'zh';
}

/**
 * 把录像转写按课件页对齐，产出逐页讲解稿。
 * 录像里讲到的页 → 用老师原话；没讲到的页 → 标 aiFilled，交给 AI 补写。
 */
export async function alignTranscript({ cfg, files, transcript, signal }) {
  const pages = pageListFor(files);
  if (!pages.length) throw new Error('课件里没有可对齐的页面（可能整份都是图片）');
  const lang = detectLang(transcript);

  // 转写太长就等比例截断（保头保尾），避免超出上下文
  let segs = transcript;
  const total = segs.reduce((n, s) => n + s.text.length, 0);
  if (total > 45000) {
    const k = 45000 / total;
    segs = segs.map((s) => ({ ...s, text: s.text.slice(0, Math.max(40, Math.floor(s.text.length * k))) }));
  }

  const { data } = await completeJSON(cfg, {
    system: ALIGN_SYSTEM,
    user: alignUser({ pages, transcript: segs, lang }),
    maxTokens: 8000,
    temperature: 0.2,
    signal,
  });

  const got = Array.isArray(data?.segments) ? data.segments : [];
  // 按位置索引回填，保证「一页不落、顺序不乱」
  const byLoc = new Map(got.map((s) => [String(s.location || '').replace(/\s+/g, ''), s]));
  const merged = pages.map((p, i) => {
    const hit = byLoc.get(String(p.location).replace(/\s+/g, '')) || got[i] || {};
    const transcriptText = String(hit.transcript || '').trim();
    return {
      location: p.location,
      title: hit.title || p.title || '',
      transcript: transcriptText,
      fromVideo: Boolean(transcriptText),
      aiFilled: !transcriptText,
      start: Number(hit.start) || 0,
      end: Number(hit.end) || 0,
      keyPoints: Array.isArray(hit.keyPoints) ? hit.keyPoints : [],
      askClass: hit.askClass || '',
      transition: hit.transition || '',
    };
  });
  return { segments: merged, lang, pages };
}

/** 英文讲解批量翻成中文（逐段对应） */
export async function translateSegments({ cfg, segments, signal }) {
  const items = segments.map((s) => String(s.transcript || '').slice(0, 1500));
  const idx = items.map((x, i) => ({ x, i })).filter((o) => o.x.trim());
  if (!idx.length) return segments;

  const { data } = await completeJSON(cfg, {
    system: TRANSLATE_SYSTEM,
    user: translateUser(idx.map((o) => o.x)),
    maxTokens: 8000,
    temperature: 0.2,
    signal,
  });
  const map = new Map((data?.items || []).map((x) => [Number(x.i), x.zh]));
  return segments.map((s, i) => {
    const pos = idx.findIndex((o) => o.i === i);
    return { ...s, zh: pos >= 0 ? map.get(pos) || '' : '' };
  });
}

/** 把 AI 补写的那几页填上讲解稿（用已有的 narration 生成逻辑，按页对齐） */
/**
 * 给「录像没讲到」的页面补写讲解稿。
 * 必须分批：一次几十页会超出 max_tokens，输出会被截断成不完整的 JSON。
 */
export async function fillMissingScripts({ cfg, files, segments, signal, onUsage = () => {}, emit = () => {}, batchSize = 8 }) {
  const need = segments.filter((s) => s.aiFilled);
  if (!need.length) return segments;

  // 建一个「位置 → 该页原文」的索引，喂给模型当依据
  const chunks = chunkBlocks(files.list);
  const docs = (files.list || []).filter((f) => f.role !== 'video' && (f.blocks || []).length);
  const multi = docs.length > 1;
  const pool = new Map();
  for (const c of chunks) {
    for (const b of c.blocks) {
      pool.set(String(b.label).replace(/\s+/g, ''), b.text);
      if (multi && c.file) pool.set(String(b.label + '｜' + c.file).replace(/\s+/g, ''), b.text);
    }
  }
  const key = (loc) => String(loc || '').replace(/\s+/g, '');
  // 模型有时会把「位置｜标题｜原文」整行原样当成 location 回吐，
  // 所以再算一个「截到 第 N 页｜文件名 为止」的宽松键做兜底。
  const locKey = (loc) => {
    const s = String(loc || '').trim();
    const cut = s.indexOf('【');
    const parts = (cut > 0 ? s.slice(0, cut) : s)
      .split('｜')
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length >= 2) return key(parts[0] + '｜' + parts[1]);
    const m = s.match(/第\s*\d+\s*页/);
    return m ? key(m[0]) : key(s);
  };
  const textOf = (loc) => pool.get(key(loc)) || pool.get(locKey(loc)) || '';

  const byLoc = new Map();
  const batches = [];
  for (let i = 0; i < need.length; i += batchSize) batches.push(need.slice(i, i + batchSize));

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    emit({
      type: 'stage-detail',
      stage: 'transcribe',
      message: '正在为录像没讲到的页面补写讲解稿 ' + (bi + 1) + '/' + batches.length + '…',
    });

    const pageText = batch
      .map(
        (s) =>
          '- 位置：【' + s.location + '】\n' +
          '  标题：' + (s.title || '（无）') + '\n' +
          '  原文：' + String(textOf(s.location)).replace(/\n/g, ' ').slice(0, 600)
      )
      .join('\n\n');

    const { data, usage } = await completeJSON(cfg, {
      system: NARRATION_SYSTEM,
      user:
        '下面是课件中「课堂录像没有讲到」的几页。请为每一页写一段讲解稿，输出 JSON。\n\n' +
        '【这些页】\n' + pageText + '\n\n' +
        '输出格式：\n' +
        '{ "segments": [ { "location": "只填【】里的位置标记", "title": "本页小标题", "script": "150-250字讲解稿", "keyPoints": ["2-4条"] } ] }\n\n' +
        '要求：\n' +
        '- 必须覆盖上面列出的每一页，一页一条，不要漏。\n' +
        '- location 只照抄【】里的位置标记，不要带标题、不要带原文、不要加任何其他文字。\n' +
        '- 讲解稿必须依据「原文」写，可以引用其中的公式、寄存器名、步骤编号。\n' +
        '- 原文里有的信息就正常讲解，不要写「课件未提供」；只有原文确实为空时才简短说明。',
      maxTokens: 6000,
      signal,
    });
    onUsage(usage);

    for (const s of data?.segments || []) {
      if (!s?.location) continue;
      byLoc.set(key(s.location), s);
      byLoc.set(locKey(s.location), s);
    }
  }

  return segments.map((s) => {
    if (!s.aiFilled) return s;
    const hit = byLoc.get(key(s.location)) || byLoc.get(locKey(s.location));
    return {
      ...s,
      script: hit?.script || '',
      title: s.title || hit?.title || '',
      keyPoints: (hit?.keyPoints && hit.keyPoints.length ? hit.keyPoints : s.keyPoints) || [],
    };
  });
}
