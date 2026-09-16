/* ============================================================
   做题 & 做 Lab 模块
   （作为独立脚本在 app.js 之后加载，共用 app.js 里的 state / $ / api / toast 等）
   ============================================================ */

/* 注意：SPIN_SVG 由 app.js 声明（app.js 先加载），这里不要重复声明——
   经典脚本之间重复声明 const 会直接抛 SyntaxError，导致整个文件不执行。 */

const qlState = {
  quizIndex: 0,
  quizFilter: 'all', // all | todo | wrong
  drafts: {}, // 题目 id → { option, notes, text }
  revealed: {}, // 题目 id → true（只看过答案、未批改）
  labIndex: 0,
  busy: false,
};

const scoreClass = (s) => (s >= 85 ? 'ok' : s >= 60 ? 'warn' : 'bad');
const asScore = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
};
const vClass = (v = '') => {
  const s = String(v);
  if (/部分|基本|不错|较好/.test(s)) return 'warn';
  if (/错误|需要返工|未/.test(s) && !/正确/.test(s)) return 'bad';
  if (/正确|很好|完成得/.test(s)) return 'ok';
  return 'warn';
};

function quizQuestions() {
  return arr(state.project?.analysis?.quiz?.questions);
}
function allAttempts() {
  return state.project?.attempts || {};
}
function currentQuestion() {
  return quizQuestions()[qlState.quizIndex];
}

/* ============================ 一、做题 ============================ */

function renderQuiz(quiz) {
  if (!quiz) {
    return `<div class="card"><h3>${icon('pen', 15)}做题</h3><p style="color:var(--text-2)">练习题还没有生成成功。点右上角 <b>「重新生成本节」</b> 试试。</p></div>`;
  }
  return `<div id="quizRoot">${quizInner()}</div>`;
}

/** 过滤后的题目下标（用于「上一题/下一题」） */
function quizWalk() {
  const at = allAttempts();
  return quizQuestions()
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => {
      const r = at[q.id]?.result;
      if (qlState.quizFilter === 'todo') return !r;
      if (qlState.quizFilter === 'wrong') return r && (asScore(r.score) ?? 0) < 85;
      return true;
    })
    .map((x) => x.i);
}

function quizInner() {
  const quiz = state.project?.analysis?.quiz || {};
  const qs = quizQuestions();
  if (!qs.length) {
    return `<div class="card"><h3>${icon('pen', 15)}做题</h3><p style="color:var(--text-2)">课件里没有整理出题目。</p></div>`;
  }
  const at = allAttempts();
  const graded = qs.filter((q) => at[q.id]?.result);
  const scores = graded.map((q) => asScore(at[q.id].result.score) ?? 0);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const correct = graded.filter((q) => (asScore(at[q.id].result.score) ?? 0) >= 85).length;
  const fromCourseware = qs.filter((q) => q.source === '课件原题').length;

  if (qlState.quizIndex >= qs.length || qlState.quizIndex < 0) qlState.quizIndex = 0;
  const q = qs[qlState.quizIndex];
  const attempt = at[q.id] || {};
  const draft = qlState.drafts[q.id] || { option: '', notes: '', text: '' };
  const walk = quizWalk();
  const pos = walk.indexOf(qlState.quizIndex);

  return `
  <div class="card quiz-head">
    <h3><span class="num">${icon('pen', 12)}</span>练习题　<span style="font-weight:400;color:var(--text-3);font-size:12.5px">共 ${qs.length} 题，其中 ${fromCourseware} 题来自课件原题</span></h3>
    <div class="quiz-stats">
      <div class="stat"><b>${graded.length}<span>/${qs.length}</span></b><i>已作答</i></div>
      <div class="stat ${avg === null ? '' : scoreClass(avg)}"><b>${avg === null ? '—' : avg}</b><i>平均分</i></div>
      <div class="stat"><b>${correct}</b><i>全对题数</i></div>
    </div>
    ${quiz.coverage ? `<p class="quiz-coverage">覆盖范围：${esc(quiz.coverage)}</p>` : ''}
    <div class="quiz-actions">
      ${[
        ['all', '全部'],
        ['todo', '只看未做'],
        ['wrong', '只看错题'],
      ]
        .map(
          ([k, label]) =>
            `<button class="btn sm ${qlState.quizFilter === k ? 'primary' : ''}" data-qfilter="${k}">${label}</button>`,
        )
        .join('')}
      <span style="flex:1"></span>
      <button class="btn sm" id="quizResetAll">${icon('trash', 13)}重做全部</button>
    </div>
    <div class="qnav">
      ${qs
        .map((item, i) => {
          const r = at[item.id]?.result;
          const sc = r ? asScore(r.score) : null;
          const cls = r ? scoreClass(sc ?? 0) : qlState.drafts[item.id] ? 'draft' : '';
          return `<button class="qnav-btn ${cls} ${i === qlState.quizIndex ? 'current' : ''}" data-qjump="${i}" title="第 ${i + 1} 题${r ? ` · ${sc} 分` : ''}">${i + 1}</button>`;
        })
        .join('')}
    </div>
  </div>

  <div class="card quiz-card">
    <div class="qhead">
      <span class="qnum">第 ${qlState.quizIndex + 1} 题</span>
      ${q.type ? `<span class="tag type">${esc(q.type)}</span>` : ''}
      ${q.difficulty ? `<span class="tag">${esc(q.difficulty)}</span>` : ''}
      ${q.source ? `<span class="tag ${q.source === '课件原题' ? 'src' : ''}">${esc(q.source)}</span>` : ''}
      ${q.location ? `<span class="tag">${icon('pin', 11)}${esc(q.location)}</span>` : ''}
    </div>

    <div class="qstem">${esc(q.stem)}</div>

    ${
      arr(q.options).length
        ? `<div class="qopts">${q.options
            .map(
              (o) => `<label class="option-row">
            <input type="radio" name="quizOpt" value="${esc(o)}" ${draft.option === o ? 'checked' : ''}>
            <span>${esc(o)}</span>
          </label>`,
            )
            .join('')}</div>
        <div class="field" style="margin-top:12px">
          <label>补充说明（选填：写下你的思路，有助于拿步骤分）</label>
          <textarea id="quizNotes" rows="2" placeholder="例如：我选了 B，因为地址从 80H 开始算……">${esc(draft.notes || '')}</textarea>
        </div>`
        : `<div class="field">
          <label>你的答案</label>
          <textarea id="quizAnswer" rows="5" placeholder="写下你的答案${q.type === '计算' ? '，记得写出关键步骤' : ''}……">${esc(draft.text || '')}</textarea>
        </div>`
    }

    <div class="qactions">
      <button class="btn primary" id="quizSubmit">提交答案</button>
      <button class="btn accent" id="quizExplain">${explainOf(q.id) ? '查看课件精讲' : '结合课件讲解'}</button>
      <button class="btn" id="quizReveal">${qlState.revealed[q.id] ? '隐藏答案' : '直接看答案'}</button>
      ${attempt.result ? '<button class="btn" id="quizResetOne">重做本题</button>' : ''}
      <span style="flex:1"></span>
      <button class="btn" id="quizPrev" ${pos <= 0 ? 'disabled' : ''}>上一题</button>
      <button class="btn" id="quizNext" ${pos < 0 || pos >= walk.length - 1 ? 'disabled' : ''}>下一题</button>
    </div>
  </div>

  ${attempt.result ? gradePanel(attempt, q) : ''}
  ${!attempt.result && qlState.revealed[q.id] ? revealPanel(q) : ''}
  ${explainOf(q.id) ? explainPanel(q, explainOf(q.id)) : ''}
  `;
}

/* ---------------- 结合课件讲解：把课件原文和讲解并排呈现 ---------------- */

function explainOf(questionId) {
  return (state.project?.explain || {})[questionId] || null;
}

/** 把 focusExcerpt 生成的文本还原成 [{label, file, text}] */
function parseExcerpt(text) {
  const src = String(text || '');
  const out = [];
  const re = /\[([^\]]+)\]（来自 ([^）]+)）\n/g;
  const heads = [...src.matchAll(re)];
  heads.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : src.length;
    out.push({ label: m[1], file: m[2], text: src.slice(start, end).trim() });
  });
  if (!out.length && src.trim()) out.push({ label: '课件原文', file: '', text: src.trim() });
  return out;
}

/** 从 pageRefs 找出「哪份课件的哪一页」，用于渲染原生页面截图 */
function explainSlideRefs(r) {
  const files = state.project?.files || [];
  const cw =
    files.find((f) => f.role === 'courseware' && f.previewPdf) ||
    files.find((f) => f.previewPdf);
  const pages = arr(r.pageRefs)
    .map((p) => String(p).match(/\d+/))
    .filter(Boolean)
    .map((m) => Number(m[0]))
    .filter((n) => n > 0);
  if (!cw || !pages.length) return [];
  return pages.map((page, i) => ({
    ref: arr(r.pageRefs)[i] || `第 ${page} 页`,
    page,
    pdf: cw.previewPdf,
    fileName: cw.originalName,
  }));
}

function explainPanel(q, entry) {
  const r = entry.result || {};
  const blocks = parseExcerpt(entry.excerpt);
  const slideRefs = explainSlideRefs(r);

  return `
  <div class="card explain-card" id="explainAnchor">
    <div class="explain-head">
      <div>
        <h3>结合课件讲解</h3>
        <p class="explain-sub">左边是课件里的原话，右边是这道题该怎么想</p>
      </div>
      <div class="explain-head-right">
        ${arr(r.pageRefs)
          .map((p) => `<span class="page-ref">${esc(p)}</span>`)
          .join('')}
        <button class="btn sm ghost" id="quizExplainRefresh">重新生成</button>
      </div>
    </div>

    <div class="explain-split">
      <div class="explain-source">
        <div class="col-label">课件原文 · 原页面截图</div>
        ${
          slideRefs.length
            ? slideRefs
                .map(
                  (x, i) => `<div class="src-block">
              <div class="src-label">${esc(x.ref)}<span>${esc(x.fileName)}</span></div>
              <div class="slide-stage" data-eslide="${i}" data-pdf="${esc(x.pdf)}" data-page="${x.page}"></div>
            </div>`,
                )
                .join('')
            : blocks.length
              ? `<div class="note-box" style="margin:0 0 12px">${icon('alert', 12)}这份文件暂时生成不了页面截图，下面是提取出的文字。</div>` +
                blocks
                  .map(
                    (b) => `<div class="src-block">
              <div class="src-label">${esc(b.label)}${b.file ? `<span>${esc(b.file)}</span>` : ''}</div>
              <div class="src-text">${esc(b.text)}</div>
            </div>`,
                  )
                  .join('')
              : '<p class="muted">没有定位到相关原文</p>'
        }
      </div>

      <div class="explain-ai">
        <div class="col-label">讲解</div>
        ${r.focus ? `<div class="explain-focus">${esc(r.focus)}</div>` : ''}

        ${
          arr(r.knowledgePoints).length
            ? `<div class="ex-section">
                <h4>这道题用到的课件知识点</h4>
                ${r.knowledgePoints
                  .map(
                    (k, i) => `<div class="kp-card">
                    <div class="kp-top"><span class="kp-idx">${i + 1}</span><b>${esc(k.point)}</b></div>
                    <div class="kp-quote"><span class="kp-tag">课件原文</span>${esc(k.coursewareSays)}</div>
                    <div class="kp-apply"><span class="kp-tag">用在本题</span>${esc(k.howItApplies)}</div>
                  </div>`,
                  )
                  .join('')}
              </div>`
            : ''
        }

        ${
          arr(r.walkthrough).length
            ? `<div class="ex-section">
                <h4>一步步解</h4>
                <div class="steps">
                  ${r.walkthrough
                    .map(
                      (s, i) => `<div class="step">
                      <span class="dot">${esc(s.step ?? i + 1)}</span>
                      <div>
                        <h5>${esc(s.title)}</h5>
                        <p>${esc(s.detail)}</p>
                        ${s.basedOn ? `<div class="step-based">依据：${esc(s.basedOn)}</div>` : ''}
                      </div>
                    </div>`,
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }

        ${r.answer ? `<div class="answer"><b>答案</b>${esc(r.answer)}</div>` : ''}

        ${
          arr(r.whyWrong).length
            ? `<div class="ex-section">
                <h4>常见错误</h4>
                ${r.whyWrong
                  .map(
                    (w) => `<div class="wrong-card">
                    <div class="wrong-line"><span class="w-tag bad">错解</span>${esc(w.wrong)}</div>
                    <div class="wrong-line"><span class="w-tag">原因</span>${esc(w.reason)}</div>
                    <div class="wrong-line"><span class="w-tag ok">正解</span>${esc(w.correct)}</div>
                  </div>`,
                  )
                  .join('')}
              </div>`
            : ''
        }

        ${
          r.variant?.stem
            ? `<div class="ex-section">
                <h4>举一反三</h4>
                <div class="variant-card">
                  <div class="variant-stem">${esc(r.variant.stem)}</div>
                  ${r.variant.hint ? `<div class="variant-line"><span class="w-tag">提示</span>${esc(r.variant.hint)}</div>` : ''}
                  ${r.variant.answer ? `<div class="variant-line"><span class="w-tag ok">答案</span>${esc(r.variant.answer)}</div>` : ''}
                </div>
              </div>`
            : ''
        }

        ${r.summary ? `<div class="explain-summary">${esc(r.summary)}</div>` : ''}
      </div>
    </div>
  </div>`;
}

function gradePanel(attempt, q) {
  const r = attempt.result;
  const sc = asScore(r.score);
  return `
  <div class="card result-card ${scoreClass(sc ?? 0)}">
    <div class="result-head">
      <span class="verdict ${scoreClass(sc ?? 0)}">${esc(r.verdict || '已批改')}</span>
      <span class="score-big ${scoreClass(sc ?? 0)}">${sc === null ? '—' : sc}<i>分</i></span>
      ${q.location ? `<span class="tag" style="margin-left:auto">${icon('pin', 11)}${esc(q.location)}</span>` : ''}
    </div>
    ${r.comment ? `<p class="result-comment">${esc(r.comment)}</p>` : ''}

    <div class="answer-split">
      <div>
        <h5>你的作答</h5>
        <div class="answer-box mine">${esc(attempt.answer || '—')}</div>
      </div>
      <div>
        <h5>参考答案</h5>
        <div class="answer-box theirs">${esc(r.referenceAnswer || q.answer || '—')}</div>
      </div>
    </div>

    ${arr(r.correct).length ? `<div class="fb ok"><b>${icon('check', 12)} 答对的地方</b>${listHtml(r.correct, '')}</div>` : ''}
    ${arr(r.missing).length ? `<div class="fb bad"><b>${icon('x', 12)} 漏掉 / 答错的地方</b>${listHtml(r.missing, '')}</div>` : ''}
    ${r.explanation ? `<div class="fb"><b>${icon('book', 12)} 解析</b><p>${esc(r.explanation)}</p></div>` : ''}
    ${r.location ? `<p class="review-hint">复习依据：<b>${esc(r.location)}</b></p>` : ''}
  </div>`;
}

function revealPanel(q) {
  return `
  <div class="card result-card">
    <div class="result-head"><span class="verdict">参考答案</span></div>
    <div class="answer-split">
      <div><h5>答案</h5><div class="answer-box theirs">${esc(q.answer || '—')}</div></div>
      <div><h5>解析</h5><div class="answer-box">${esc(q.explanation || '—')}</div></div>
    </div>
    ${arr(q.keyPoints).length ? `<div class="fb"><b>评分要点</b>${listHtml(q.keyPoints, '')}</div>` : ''}
    ${arr(q.pitfalls).length ? `<div class="fb bad"><b>易错点</b>${listHtml(q.pitfalls, '')}</div>` : ''}
    <p class="review-hint">看答案不计入成绩。想让自己真正掌握，建议先自己写一遍再提交批改。</p>
  </div>`;
}

/* ---------------------------- 做题：交互 ---------------------------- */

function saveDraft(q) {
  const hasOpts = arr(q.options).length > 0;
  qlState.drafts[q.id] = hasOpts
    ? { option: document.querySelector('input[name="quizOpt"]:checked')?.value || '', notes: $('#quizNotes')?.value || '', text: '' }
    : { option: '', notes: '', text: $('#quizAnswer')?.value || '' };
}

function readAnswer(q) {
  const hasOpts = arr(q.options).length > 0;
  if (hasOpts) {
    const sel = document.querySelector('input[name="quizOpt"]:checked');
    const notes = ($('#quizNotes')?.value || '').trim();
    if (!sel && !notes) return '';
    return [sel ? sel.value : '', notes ? `（补充说明：${notes}）` : ''].filter(Boolean).join(' ');
  }
  return ($('#quizAnswer')?.value || '').trim();
}

function paintQuiz() {
  const root = $('#quizRoot');
  if (!root) return;
  root.innerHTML = quizInner();
  wireQuiz();
}

function goQuiz(delta) {
  const walk = quizWalk();
  const pos = walk.indexOf(qlState.quizIndex);
  const nextPos = pos < 0 ? 0 : pos + delta;
  if (nextPos < 0 || nextPos >= walk.length) return;
  qlState.quizIndex = walk[nextPos];
  paintQuiz();
}

function wireQuiz() {
  const root = $('#quizRoot');
  if (!root) return;

  $$('[data-qjump]', root).forEach((b) =>
    b.addEventListener('click', () => {
      const q = currentQuestion();
      if (q) saveDraft(q);
      qlState.quizIndex = Number(b.dataset.qjump);
      paintQuiz();
    }),
  );

  $$('[data-qfilter]', root).forEach((b) =>
    b.addEventListener('click', () => {
      qlState.quizFilter = b.dataset.qfilter;
      const walk = quizWalk();
      if (walk.length && !walk.includes(qlState.quizIndex)) qlState.quizIndex = walk[0];
      paintQuiz();
    }),
  );

  $('#quizPrev')?.addEventListener('click', () => {
    const q = currentQuestion();
    if (q) saveDraft(q);
    goQuiz(-1);
  });
  $('#quizNext')?.addEventListener('click', () => {
    const q = currentQuestion();
    if (q) saveDraft(q);
    goQuiz(1);
  });

  $('#quizReveal')?.addEventListener('click', () => {
    const q = currentQuestion();
    qlState.revealed[q.id] = !qlState.revealed[q.id];
    paintQuiz();
  });

  $('#quizSubmit')?.addEventListener('click', submitAnswer);
  $('#quizExplain')?.addEventListener('click', () => loadExplain(false));
  $('#quizExplainRefresh')?.addEventListener('click', () => loadExplain(true));

  $('#quizResetOne')?.addEventListener('click', async () => {
    const q = currentQuestion();
    await resetAttempts(q.id);
    delete qlState.drafts[q.id];
    paintQuiz();
  });

  $('#quizResetAll')?.addEventListener('click', async () => {
    if (!confirm('确定要清空所有作答记录，重新做一遍吗？')) return;
    await resetAttempts(null);
    qlState.drafts = {};
    qlState.revealed = {};
    paintQuiz();
  });

  // 离开输入框时顺手存草稿（不调用模型，不花钱）
  const inputs = $$('#quizAnswer, #quizNotes, input[name="quizOpt"]', root);
  inputs.forEach((el) =>
    el.addEventListener('change', () => {
      const q = currentQuestion();
      if (!q) return;
      saveDraft(q);
      api(`/api/projects/${state.project.id}/answer`, {
        method: 'POST',
        body: JSON.stringify({ questionId: q.id, answer: readAnswer(q) }),
      }).catch(() => {});
    }),
  );
  $('#quizAnswer')?.addEventListener('blur', () => {
    const q = currentQuestion();
    if (q) saveDraft(q);
  });

  // 已经生成过精讲的题，直接把截图挂上
  wireExplainSlides($('#explainAnchor'));

  if (qlState.focusAnswer) {
    qlState.focusAnswer = false;
    ($('#quizAnswer') || $('#quizNotes'))?.focus();
  }
}

async function submitAnswer() {
  if (qlState.busy) return;
  const q = currentQuestion();
  if (!q) return;
  const answer = readAnswer(q);
  if (!answer) {
    toast('请先写下或选择你的答案', 'err');
    return;
  }
  qlState.busy = true;
  const btn = $('#quizSubmit');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = SPIN_SVG + '老师批改中…';
  }
  try {
    const res = await api(`/api/projects/${state.project.id}/grade`, {
      method: 'POST',
      body: JSON.stringify({ questionId: q.id, answer }),
    });
    if (res.project) state.project = res.project;
    paintQuiz();
    const sc = asScore(res.result?.score) ?? 0;
    toast(`${res.result?.verdict || '已批改'}　${sc} 分`, sc >= 60 ? 'ok' : 'err');
  } catch (err) {
    toast(err.message, 'err');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = icon('check', 13) + '提交答案';
    }
  } finally {
    qlState.busy = false;
  }
}

/**
 * 结合课件讲解这道题。
 * @param {boolean} force true 时忽略缓存重新生成
 */
async function loadExplain(force) {
  if (qlState.busy) return;
  const q = currentQuestion();
  if (!q) return;
  qlState.busy = true;
  const btn = force ? $('#quizExplainRefresh') : $('#quizExplain');
  const label = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = SPIN_SVG + (force ? '重新生成中…' : '正在对照课件备课…');
  }
  try {
    const res = await api(`/api/projects/${state.project.id}/explain`, {
      method: 'POST',
      body: JSON.stringify({ questionId: q.id, cached: !force }),
    });
    state.project.explain = state.project.explain || {};
    state.project.explain[q.id] = { result: res.result, excerpt: res.excerpt, at: new Date().toISOString() };
    paintQuiz();
    wireExplainSlides($('#explainAnchor'));
    toast(res.cached ? '已载入之前的讲解' : '课件精讲已生成', 'ok');
    $('#explainAnchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, 'err');
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  } finally {
    qlState.busy = false;
  }
}

/** 把讲解面板里的截图位真正渲染出来（外部容器插入后调用） */
function wireExplainSlides(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-eslide]').forEach((el) => {
    mountSlide(el, el.dataset.pdf, Number(el.dataset.page) || 1, { width: 900 });
  });
}

async function resetAttempts(questionId) {
  try {
    const url = questionId
      ? `/api/projects/${state.project.id}/attempts?questionId=${encodeURIComponent(questionId)}`
      : `/api/projects/${state.project.id}/attempts`;
    const res = await api(url, { method: 'DELETE' });
    state.project.attempts = res.attempts || {};
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ============================ 二、做 Lab ============================ */

function labs() {
  return arr(state.project?.analysis?.lab?.labs);
}
function labProgress() {
  return state.project?.labProgress || {};
}
function currentLab() {
  return labs()[qlState.labIndex];
}

function renderLab(labData) {
  if (!labData) {
    return `<div class="card"><h3>${icon('flask', 15)}做 Lab</h3><p style="color:var(--text-2)">实验内容还没有生成成功。点右上角 <b>「重新生成本节」</b> 试试。</p></div>`;
  }
  if (!labs().length) {
    return `<div class="card"><h3>${icon('flask', 15)}做 Lab</h3><p style="color:var(--text-2)">课件里没有实验内容，也未能设计出合适的实验。</p></div>`;
  }
  return `<div id="labRoot">${labInner()}</div>`;
}

function labInner() {
  const list = labs();
  if (qlState.labIndex >= list.length || qlState.labIndex < 0) qlState.labIndex = 0;
  const lab = list[qlState.labIndex];
  const prog = labProgress()[lab.id] || {};
  const records = prog.records || {};
  const doneSteps = arr(prog.steps).map(Number);
  const steps = arr(lab.steps);
  const pct = steps.length ? Math.round((doneSteps.length / steps.length) * 100) : 0;

  const shape = state.project?.shape || {};
  const warn = shape.hasLab
    ? ''
    : `<div class="note-box" style="margin-bottom:16px">
        ${icon('alert', 12)}<b>这个项目里没有检测到实验指导文件</b>（文件名通常含 lab）。下面这个 Lab 是基于课件内容<b>补充设计</b>的，
        可能和你的实际实验器材与步骤不适配。点右上角「重新生成本节」可以重做。
      </div>`;

  return `
  ${warn}
  ${
    list.length > 1
      ? `<div class="card"><h3><span class="num">${icon('flask', 12)}</span>共 ${list.length} 个实验</h3>
          <div class="pill-row">${list
            .map((l, i) => {
              const p = labProgress()[l.id];
              const mark = p?.result ? ' ' + icon('check', 11) : '';
              return `<button class="btn sm ${i === qlState.labIndex ? 'primary' : ''}" data-labjump="${i}">${esc(l.title || `实验 ${i + 1}`)}${mark}</button>`;
            })
            .join('')}</div></div>`
      : ''
  }

  <div class="card lab-head">
    <h3>
      <span class="num">${icon('flask', 12)}</span>${esc(lab.title || `实验 ${qlState.labIndex + 1}`)}
      <span class="spacer"></span>
      ${lab.source ? `<span class="tag ${lab.source === '课件原实验' ? 'src' : ''}">${esc(lab.source)}</span>` : ''}
      ${lab.location ? `<span class="tag">${icon('pin', 11)}${esc(lab.location)}</span>` : ''}
    </h3>
    <div class="lab-progress">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <span>已完成 ${doneSteps.length}/${steps.length} 步（${pct}%）</span>
    </div>
    ${arr(lab.objective).length ? `<div class="lab-block"><h5>${icon('target', 12)}实验目标</h5>${listHtml(lab.objective, '')}</div>` : ''}
    ${lab.background ? `<div class="lab-block"><h5>${icon('book', 12)}原理</h5><p>${esc(lab.background)}</p></div>` : ''}
    ${arr(lab.equipment).length ? `<div class="lab-block"><h5>${icon('clipboard', 12)}器材</h5><div class="pill-row">${lab.equipment.map((e) => `<span class="pill">${esc(e)}</span>`).join('')}</div></div>` : ''}
    ${arr(lab.safety).length ? `<div class="note-box" style="margin-top:14px"><b>${icon('alert', 12)}注意事项</b>${listHtml(lab.safety, '')}</div>` : ''}
  </div>

  ${
    steps.length
      ? `<div class="card">
          <h3><span class="num">${icon('list', 12)}</span>实验步骤　<span style="font-weight:400;color:var(--text-3);font-size:12.5px">做完一步勾一步</span></h3>
          <div class="lab-steps">
            ${steps
              .map(
                (s) => `<div class="lab-step ${doneSteps.includes(Number(s.no)) ? 'done' : ''}">
                <label class="step-check">
                  <input type="checkbox" name="labStep" value="${esc(s.no)}" ${doneSteps.includes(Number(s.no)) ? 'checked' : ''}>
                  <span class="step-no">${esc(s.no)}</span>
                </label>
                <div class="step-body">
                  <div class="step-action">${esc(s.action)}</div>
                  ${s.expected ? `<div class="step-expected"><b>预期结果</b>${esc(s.expected)}</div>` : ''}
                  ${s.tip ? `<div class="step-tip"><b>提示</b>${esc(s.tip)}</div>` : ''}
                </div>
              </div>`,
              )
              .join('')}
          </div>
        </div>`
      : ''
  }

  <div class="card">
    <h3><span class="num">${icon('pen', 12)}</span>实验记录　<span style="font-weight:400;color:var(--text-3);font-size:12.5px">填完点「提交检查」，老师会帮你看对不对</span></h3>
    ${
      arr(lab.checkpoints).length
        ? `<div class="record-list">${lab.checkpoints
            .map(
              (c, i) => `<div class="record-row">
              <label>${esc(c)}</label>
              <textarea id="labRec${i}" rows="2" placeholder="填写实测值 / 现象 / 截图说明……">${esc(records[c] || '')}</textarea>
            </div>`,
            )
            .join('')}</div>`
        : ''
    }
    ${
      lab.recordTable?.columns?.length
        ? `<div class="lab-block" style="margin-top:14px"><h5>${icon('table', 12)}记录表参考格式</h5>
            <div style="overflow-x:auto"><table class="flow-table">
              <thead><tr>${lab.recordTable.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
              <tbody>${arr(lab.recordTable.rows)
                .map((r) => {
                  // 模型可能给出嵌套数组，也可能给出用 | 分隔的整行字符串，两种都吃
                  const cells = Array.isArray(r) ? r : String(r).split('|').map((c) => c.trim());
                  const padded = lab.recordTable.columns.map((_, i) => cells[i] ?? '');
                  return `<tr>${padded.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
                })
                .join('')}</tbody>
            </table></div></div>`
        : ''
    }
    <div class="record-row" style="margin-top:14px">
      <label>其他记录 / 遇到的问题</label>
      <textarea id="labNotes" rows="2" placeholder="例如：某一步现象和预期不一致，我怀疑是……">${esc(records['其他记录与问题'] || '')}</textarea>
    </div>
    <div class="qactions" style="margin-top:16px">
      <button class="btn primary" id="labCheck">${icon('send', 13)}提交检查</button>
      <button class="btn" id="labSave">${icon('save', 13)}保存进度</button>
      <span style="flex:1"></span>
      <button class="btn" id="labReset">${icon('trash', 13)}清空记录</button>
    </div>
  </div>

  ${arr(lab.questions).length ? `<div class="card"><h3><span class="num">${icon('help', 12)}</span>实验思考题</h3>${listHtml(lab.questions, '')}</div>` : ''}
  ${prog.result ? labResultPanel(prog.result) : ''}
  `;
}

function labResultPanel(r) {
  const sc = asScore(r.score);
  const cls = scoreClass(sc ?? 0);
  return `
  <div class="card result-card ${cls}">
    <div class="result-head">
      <span class="verdict ${cls}">${esc(r.verdict || '检查完成')}</span>
      ${sc === null ? '' : `<span class="score-big ${cls}">${sc}<i>分</i></span>`}
    </div>
    ${r.comment ? `<p class="result-comment">${esc(r.comment)}</p>` : ''}
    ${
      arr(r.stepFeedback).length
        ? `<div class="fb"><b>逐步点评</b><div class="step-feedback">${r.stepFeedback
            .map((f) => {
              const c = /正确/.test(f.status || '') ? 'ok' : /未记录/.test(f.status || '') ? '' : 'bad';
              return `<div class="sf-row ${c}">
              <span class="sf-no">第 ${esc(f.step)} 步</span>
              <span class="sf-status">${esc(f.status || '')}</span>
              <span class="sf-text">${esc(f.feedback || '')}</span>
            </div>`;
            })
            .join('')}</div></div>`
        : ''
    }
    ${arr(r.issues).length ? `<div class="fb bad"><b>${icon('alert', 12)}需要修正</b>${listHtml(r.issues, '')}</div>` : ''}
    ${r.correctResults ? `<div class="fb"><b>${icon('checkCircle', 12)}正确结果汇总</b><p>${esc(r.correctResults)}</p></div>` : ''}
    ${r.nextStep ? `<div class="fb"><b>${icon('right', 12)}下一步</b><p>${esc(r.nextStep)}</p></div>` : ''}
  </div>`;
}

/* ---------------------------- 做 Lab：交互 ---------------------------- */

function paintLab() {
  const root = $('#labRoot');
  if (!root) return;
  root.innerHTML = labInner();
  wireLab();
}

function wireLab() {
  const root = $('#labRoot');
  if (!root) return;

  $$('[data-labjump]', root).forEach((b) =>
    b.addEventListener('click', () => {
      qlState.labIndex = Number(b.dataset.labjump);
      paintLab();
    }),
  );

  // 勾选步骤：本地先更新，再静默保存
  $$('input[name="labStep"]', root).forEach((el) =>
    el.addEventListener('change', async () => {
      const steps = $$('input[name="labStep"]:checked', root).map((x) => Number(x.value));
      const wrapper = el.closest('.lab-step');
      wrapper?.classList.toggle('done', el.checked);
      await saveLab({ steps, records: readLabRecords(), check: false, silent: true });
      paintLab();
    }),
  );

  $('#labSave')?.addEventListener('click', () => saveLab({ check: false }));
  $('#labCheck')?.addEventListener('click', () => saveLab({ check: true }));

  $('#labReset')?.addEventListener('click', async () => {
    const lab = currentLab();
    if (!confirm(`确定清空「${lab.title}」的填写记录吗？`)) return;
    try {
      const res = await api(`/api/projects/${state.project.id}/lab/${encodeURIComponent(lab.id)}`, { method: 'DELETE' });
      state.project.labProgress = res.labProgress || {};
      paintLab();
      toast('已清空');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function readLabRecords() {
  const lab = currentLab();
  const records = {};
  arr(lab?.checkpoints).forEach((c, i) => {
    const el = document.getElementById(`labRec${i}`);
    if (el) records[c] = el.value;
  });
  const notes = document.getElementById('labNotes');
  if (notes) records['其他记录与问题'] = notes.value;
  return records;
}

function readLabSteps() {
  const root = $('#labRoot');
  return $$('input[name="labStep"]:checked', root || document).map((x) => Number(x.value));
}

async function saveLab({ check, silent }) {
  const lab = currentLab();
  if (!lab) return;
  const records = readLabRecords();
  const steps = readLabSteps();

  if (check) {
    const filled = Object.values(records).filter((v) => String(v || '').trim());
    if (!filled.length) {
      toast('请至少填写一项实验记录再提交检查', 'err');
      return;
    }
  }

  const btn = check ? $('#labCheck') : $('#labSave');
  const label = btn?.textContent;
  if (btn && !silent) {
    btn.disabled = true;
    btn.innerHTML = check ? SPIN_SVG + '检查中…' : SPIN_SVG + '保存中…';
  }

  try {
    const res = await api(`/api/projects/${state.project.id}/lab`, {
      method: 'POST',
      body: JSON.stringify({ labId: lab.id, records, steps, check: Boolean(check) }),
    });
    if (res.project) {
      state.project = res.project;
    } else {
      state.project.labProgress = state.project.labProgress || {};
      state.project.labProgress[lab.id] = { records, steps };
    }
    if (!silent) {
      paintLab();
      if (check) {
        const sc = asScore(res.result?.score);
        toast(`${res.result?.verdict || '检查完成'}${sc === null ? '' : `　${sc} 分`}`, (sc ?? 100) >= 60 ? 'ok' : 'err');
      } else {
        toast('进度已保存', 'ok');
      }
    }
  } catch (err) {
    if (btn && !silent) {
      btn.disabled = false;
      btn.textContent = label;
    }
    if (!silent) toast(err.message, 'err');
  }
}
