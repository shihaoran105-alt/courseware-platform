/** 把分析结果导出成 Markdown（老师可以直接拿去改教案） */

const list = (arr) => (Array.isArray(arr) && arr.length ? arr.map((x) => `- ${x}`).join('\n') : '_课件未提供_');

export function toMarkdown(project) {
  const a = project.analysis || {};
  const L = [];
  const push = (...s) => L.push(...s);

  push(`# ${a.analysis?.title || project.name} — 课件分析与讲解方案`, '');
  push(`> 由「课件讲解平台」自动生成于 ${new Date(project.analysis?.generatedAt || Date.now()).toLocaleString('zh-CN')}`);
  push(`> 源文件：${project.files.map((f) => f.originalName).join('、')}`, '');

  const an = a.analysis;
  if (an) {
    push('## 一、课件内容分析', '');
    push(`| 项目 | 内容 |`, `| --- | --- |`);
    push(`| 学科/课程 | ${an.subject || '—'} |`);
    push(`| 适用对象 | ${an.audience || '—'} |`);
    push(`| 难度 | ${an.difficulty || '—'} |`);
    push(`| 建议课时 | ${an.durationMinutes ?? '—'} 分钟 |`, '');
    push('### 内容概述', '', an.summary || '—', '');
    push('### 教学目标', '', list(an.objectives), '');
    push('### 前置知识', '', list(an.prerequisites), '');
    if (an.structure?.length) {
      push('### 内容结构', '');
      for (const s of an.structure) {
        push(`**${s.section}**（${s.location || '位置未标注'}${s.minutes ? `，约 ${s.minutes} 分钟` : ''}）`, '');
        push(list(s.points), '');
      }
    }
    if (an.concepts?.length) {
      push('### 核心概念', '');
      for (const c of an.concepts) {
        push(`- **${c.term}**：${c.definition}`, `  - 为什么重要：${c.why || '—'}`);
      }
      push('');
    }
    push('### 必须记住的要点', '', list(an.keyTakeaways), '');
    if (an.gaps?.length) push('### 课件缺口与改进建议', '', list(an.gaps), '');
  }

  const ex = a.examples;
  if (ex) {
    push('## 二、事例讲解', '');
    if (ex.examples?.length) {
      for (const e of ex.examples) {
        push(`### ${e.id ? `${e.id}. ` : ''}${e.title}`, '');
        push(`- 位置：${e.location || '未标注'}　类型：${e.type || '—'}`, '');
        if (e.context) push(`**背景**：${e.context}`, '');
        if (e.stem) push('**题目/情境**', '', `> ${String(e.stem).replace(/\n/g, '\n> ')}`, '');
        if (e.steps?.length) {
          push('**讲解步骤**', '');
          e.steps.forEach((s, i) => push(`${i + 1}. **${s.title}**`, `   ${s.detail}`));
          push('');
        }
        if (e.method) push(`**通用方法**：${e.method}`, '');
        if (e.answer) push(`**答案/结论**：${e.answer}`, '');
        if (e.keyPoints?.length) push('**关键点**', '', list(e.keyPoints), '');
        if (e.pitfalls?.length) push('**易错点**', '', list(e.pitfalls), '');
        if (e.board) push('**板书**', '', '```', e.board, '```', '');
      }
    } else {
      push(ex.noExampleNote || '_课件中未发现例题或案例。_', '');
    }
  }

  const g = a.guide;
  if (g) {
    push('## 三、如何利用这份课件', '');
    if (g.positioning) push('### 课件定位', '', g.positioning, '');
    if (g.lessonFlow?.length) {
      push('### 课堂流程', '');
      push('| 环节 | 用时 | 课件位置 | 教师活动 | 学生活动 | 课件用法 |', '| --- | --- | --- | --- | --- | --- |');
      for (const f of g.lessonFlow) {
        const clean = (s) => String(s || '—').replace(/\|/g, '/').replace(/\n/g, ' ');
        push(`| ${clean(f.phase)} | ${f.minutes ?? '—'} 分钟 | ${clean(f.location)} | ${clean(f.teacherAction)} | ${clean(f.studentAction)} | ${clean(f.howToUseCourseware)} |`);
      }
      push('');
      push('### 教师口播讲稿', '');
      for (const f of g.lessonFlow) {
        if (f.script) push(`- **${f.phase}**（${f.location || ''}）：${f.script}`);
      }
      push('');
    }
    if (g.questions?.length) {
      push('### 课堂提问设计', '');
      g.questions.forEach((q, i) => {
        push(`${i + 1}. **${q.question}**`);
        push(`   - 参考回答：${q.answer || '—'}`);
        push(`   - 提问目的：${q.purpose || '—'}${q.location ? `（${q.location}）` : ''}`);
      });
      push('');
    }
    if (g.activities?.length) {
      push('### 课堂活动', '');
      for (const act of g.activities) {
        push(`**${act.name}**（${act.duration || '时长未定'}）`, '');
        push(list(act.steps), '');
        if (act.materials) push(`材料：${act.materials}`, '');
      }
    }
    if (g.homework) {
      push('### 作业布置', '', '**必做**', '', list(g.homework.basic), '', '**选做/拓展**', '', list(g.homework.advanced), '');
    }
    if (g.differentiation) {
      push('### 分层教学', '');
      push(`- **基础薄弱**：${g.differentiation.struggling || '—'}`);
      push(`- **中等水平**：${g.differentiation.average || '—'}`);
      push(`- **学有余力**：${g.differentiation.advanced || '—'}`, '');
    }
    if (g.pitfalls?.length) push('### 使用这份课件的注意事项', '', list(g.pitfalls), '');
    if (g.tips?.length) push('### 提效技巧', '', list(g.tips), '');
    if (g.assessment?.length) push('### 学习效果检验', '', list(g.assessment), '');
  }

  const n = a.narration;
  if (n?.segments?.length) {
    push('## 四、逐页讲解稿', '');
    for (const s of n.segments) {
      push(`### ${s.location}　${s.title || ''}`, '');
      push(s.script || '', '');
      if (s.keyPoints?.length) push('**要点**', '', list(s.keyPoints), '');
      if (s.askClass) push(`**提问**：${s.askClass}`, '');
      if (s.board) push('**板书**', '', '```', s.board, '```', '');
      if (s.transition) push(`**过渡**：${s.transition}`, '');
    }
  }

  const q = a.quiz;
  if (q) {
    push('## 五、练习题（做题）', '');
    if (q.coverage) push(`> 覆盖范围：${q.coverage}`, '');
    const qs = q.questions || [];
    push(`共 ${qs.length} 道题。${qs.filter((x) => x.source === '课件原题').length} 道来自课件原题，其余为补充生成。`, '');
    qs.forEach((item, i) => {
      push(`### ${item.id ?? i + 1}. ${item.stem}`, '');
      push(`- 题型：${item.type || '—'}　难度：${item.difficulty || '—'}　来源：${item.source || '—'}　位置：${item.location || '—'}`, '');
      if (item.options?.length) push(item.options.map((o) => `  ${o}`).join('\n'), '');
      push('', `**参考答案**：${item.answer || '—'}`, '');
      if (item.explanation) push(`**解析**：${item.explanation}`, '');
      if (item.keyPoints?.length) push('**评分要点**', '', list(item.keyPoints), '');
      if (item.pitfalls?.length) push('**易错点**', '', list(item.pitfalls), '');
    });
  }

  const lab = a.lab;
  if (lab) {
    push('## 六、实验（Lab）', '');
    const labs = lab.labs || [];
    if (!labs.length) {
      push('_课件中没有实验内容，也未能设计出合适的实验。_', '');
    }
    for (const l of labs) {
      push(`### ${l.id ? `${l.id}. ` : ''}${l.title}`, '');
      push(`- 来源：${l.source || '—'}　位置：${l.location || '—'}`, '');
      push('**实验目标**', '', list(l.objective), '');
      if (l.background) push('**原理**', '', l.background, '');
      if (l.equipment?.length) push('**器材**', '', list(l.equipment), '');
      if (l.steps?.length) {
        push('**实验步骤**', '');
        for (const s of l.steps) {
          push(`${s.no}. **${s.action}**`);
          if (s.expected) push(`   - 预期结果：${s.expected}`);
          if (s.tip) push(`   - 提示：${s.tip}`);
        }
        push('');
      }
      if (l.checkpoints?.length) push('**需要提交的检查项**', '', list(l.checkpoints), '');
      if (l.recordTable?.columns?.length) {
        push('**记录表**', '');
        push(`| ${l.recordTable.columns.join(' | ')} |`);
        push(`| ${l.recordTable.columns.map(() => '---').join(' | ')} |`);
        for (const r of l.recordTable.rows || []) {
          const cells = Array.isArray(r) ? r : String(r).split('|').map((c) => c.trim());
          const padded = l.recordTable.columns.map((_, i) => cells[i] ?? '');
          push(`| ${padded.join(' | ')} |`);
        }
        push('');
      }
      if (l.questions?.length) push('**思考题**', '', list(l.questions), '');
      if (l.safety?.length) push('**注意事项**', '', list(l.safety), '');
    }
  }

  if (a.errors?.length) {
    push('## 附：生成过程中出现的问题', '');
    for (const e of a.errors) push(`- ${e.label}：${e.message}`);
    push('');
  }

  push('---', '', `生成模型：${a.model || '—'}　耗时：${((a.elapsedMs || 0) / 1000).toFixed(1)} 秒`, '');
  return L.join('\n');
}
