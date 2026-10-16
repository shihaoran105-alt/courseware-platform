/**
 * DeepSeek / OpenAI 兼容接口客户端
 * 支持：JSON 结构化输出、流式输出、自动重试、被截断 JSON 的修复
 */
export class AIError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'AIError';
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 诊断回调：出错时把「模型到底返回了什么」交给外面。
 *
 * 服务端在启动时用 setDiagnosticSink() 接到落盘日志上；浏览器版不挂，
 * 所以这个模块依然不依赖 node —— 它会被编译成 docs/engine/ai.js 给静态版用。
 */
let diagnosticSink = null;
export function setDiagnosticSink(fn) {
  diagnosticSink = typeof fn === 'function' ? fn : null;
}
function report(scope, payload) {
  if (!diagnosticSink) return;
  try {
    diagnosticSink(scope, payload);
  } catch {
    /* 记日志本身失败，绝不能影响主流程 */
  }
}

/**
 * 给别的模块（尤其是 pipeline.mjs）用的诊断出口。
 * pipeline 会把单个阶段的失败**内部消化**掉（塞进 result.errors），
 * 路由层的 catch 根本收不到 —— 批量生成里「有 1 个环节没成功」就是这么来的，
 * 以前既不落盘也不留痕。这里让阶段自己把失败报出来。
 */
export function reportDiagnostic(scope, err, extra = {}) {
  report(scope, { ...extra, error: err });
}

/**
 * 从模型输出里稳健地取出 JSON（容忍 ```json 包裹、前后废话、被截断）。
 *
 * 起点不能简单取「第一个 { 或 [」：模型偶尔会在正文里写中文方括号，
 * 例如「LED 接 5V（[内部上拉] 那条）」—— 把那个 [ 当成数组起点，
 * 就会报出莫名其妙的 `Unexpected token '内'`，完全看不出真正的问题（模型压根没写 JSON）。
 * 所以两种起点都试一遍，**对象优先**（本平台所有阶段的 JSON 根都是对象）。
 */
export function extractJson(text) {
  if (!text || !text.trim()) throw new Error('模型返回了空内容');
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const anchors = [];
  const bi = t.indexOf('{');
  const si = t.indexOf('[');

  /**
   * 正文里连一个 { 都没有 = 模型没按要求写 JSON，而是把分析/推理过程写进了正文。
   * 实测过一次：8000 token 全用在「Let me compute timer values…」上，最后被截断，
   * 正文里只有一段英文推理 + 中文方括号。这种情况报
   * 「Unexpected token '内'」毫无意义，直接把真实原因说出来。
   */
  const proseError = () =>
    t.length > 120
      ? new Error(
          `模型没有返回 JSON，而是写了一大段说明/推理过程（正文 ${t.length} 字，里面找不到 {）。` +
            `开头是：${t.slice(0, 60).replace(/\s+/g, ' ')}…`,
        )
      : new Error('模型返回中没有找到 JSON');

  if (bi >= 0) anchors.push({ start: bi, open: '{', close: '}' });
  if (si >= 0 && si !== bi) anchors.push({ start: si, open: '[', close: ']' });
  if (!anchors.length) throw proseError();

  let lastErr = null;
  for (const a of anchors) {
    try {
      return parseFrom(t, a);
    } catch (err) {
      lastErr = err;
    }
  }
  // 只找到 [ 的那种，多半也是正文里的中文方括号（例如「LED 接 5V（[内部上拉]）」）
  if (bi < 0) throw proseError();
  throw lastErr || new Error('模型返回中没有找到 JSON');
}

function parseFrom(t, { start, open, close }) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return JSON.parse(repairJson(t.slice(start, i + 1)));
        }
      }
    }
  }
  // 没闭合：说明输出被 max_tokens 截断，尽力修复
  return JSON.parse(repairJson(t.slice(start)));
}

/**
 * 读一段引号包起来的字符串，返回原文与结束位置。
 * 两种引号都认 —— 模型经常整段用单引号写成 JSON5 的样子。
 */
function readQuoted(text, i, quote) {
  let j = i + 1;
  let esc = false;
  while (j < text.length) {
    const d = text[j];
    if (esc) esc = false;
    else if (d === '\\') esc = true;
    else if (d === quote) {
      j++;
      break;
    }
    j++;
  }
  return { raw: text.slice(i, j), end: j, closed: j <= text.length && text[j - 1] === quote && j - 1 > i };
}

/** 把单引号字符串转成合法的双引号 JSON 字符串（内部的 " 要转义，\' 要还原） */
function singleToDouble(raw) {
  const inner = raw.slice(1, raw.endsWith("'") && raw.length > 1 ? -1 : undefined);
  let body = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && inner[i + 1] !== undefined) {
      const n = inner[i + 1];
      if (n === "'") {
        body += "'";
        i++;
        continue;
      }
      if (n === '"') {
        body += '\\"';
        i++;
        continue;
      }
      body += c + n; // \n \t \\ \uXXXX 之类原样保留
      i++;
      continue;
    }
    if (c === '"') {
      body += '\\"';
      continue;
    }
    body += c;
  }
  return `"${body}"`;
}

/**
 * 把 JSON 里的字符串逐个切出来，只对**字符串外**的骨架跑 fn，字符串原样保留。
 *
 * 为什么必须这么切：Lab 的 code 字段里全是 `void f(void) {` 这种花括号、
 * 还有 `a ? b : c` 这种冒号。修补 JSON 的规则一旦作用到字符串里面，
 * 就会把学生要用的代码改坏 —— 而这段代码恰恰是这个功能最值钱的东西。
 *
 * 顺带把单引号字符串统一换成双引号（JSON5 → JSON），这步也必须逐段做，
 * 否则整段替换会连字符串里的内容一起动。
 */
function rebuildJsonTokens(text, fn) {
  let out = '';
  let buf = '';
  const flush = () => {
    if (buf) out += fn(buf);
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== '"' && c !== "'") {
      buf += c;
      i++;
      continue;
    }
    flush();
    const q = readQuoted(text, i, c);
    out += c === '"' ? q.raw : singleToDouble(q.raw);
    i = q.end;
  }
  flush();
  return out;
}

function repairJson(s) {
  let out = s.replace(/,\s*$/, '');
  // 去掉尾部不完整的 `,"key":` 或 `"key":`
  out = out.replace(/,\s*"[^"]*"\s*:\s*$/, '').replace(/"[^"]*"\s*:\s*$/, '');
  out = out.replace(/,\s*$/, '');

  // 模型时不时写成 JavaScript / JSON5 字面量的样子而不是严格 JSON。最常见的是
  // **键名不加引号**，报错长这样：
  //   Expected property name or '}' in JSON at position 6 (line 2 column 5)
  //   ← 对应的内容就是 {\n    no: 1\n}
  // 这些修补全在字符串外做，见 rebuildJsonTokens 的说明。
  out = rebuildJsonTokens(out, (chunk) =>
    chunk
      // 1) 没加引号的键：紧跟 { 或 , 的标识符，后面接冒号
      .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3')
      // 2) 尾随逗号：逗号后面直接就是 } 或 ]
      .replace(/,(\s*[}\]])/g, '$1'),
  );

  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  while (stack.length) {
    const o = stack.pop();
    out += o === '{' ? '}' : ']';
  }
  return out;
}

function endpoint(cfg) {
  return `${cfg.baseUrl}/chat/completions`;
}

function assertKey(cfg) {
  if (!cfg.apiKey) {
    throw new AIError('尚未配置 API Key。请点击右上角「设置」填入 DeepSeek API Key（或设置环境变量 DEEPSEEK_API_KEY）。', {
      status: 401,
    });
  }
}

async function request(cfg, body, { signal, retries = 3, model } = {}) {
  assertKey(cfg);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(endpoint(cfg), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ model: model || cfg.model, ...body }),
        signal,
      });
      if (res.ok) return res;
      const detail = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new AIError(`模型接口返回 ${res.status}：${detail.slice(0, 300)}`, {
        status: res.status,
        retryable,
      });
      if (!retryable || attempt === retries) throw lastErr;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err instanceof AIError && !err.retryable) throw err;
      lastErr = err instanceof AIError ? err : new AIError(`请求模型接口失败：${err.message}`, { retryable: true });
      if (attempt === retries) throw lastErr;
    }
    await sleep(800 * 2 ** attempt);
  }
  throw lastErr;
}

/**
 * 单次请求最多带多少张页面截图 / 多少字节的 base64。
 *
 * 实测 api.deepseek.com 的网关在请求体约 50 MB 处返回 413（41.7 MB 通过、52.1 MB 被拒）。
 * 之前是「有几页就发几页」，一本 224 页的扫描教材渲染出来 60–70 MB，必然 413，
 * 而且整节直接失败。
 *
 * 所以主约束是**体积**（16 MB，留三倍安全余量），张数上限只是兜底。
 * 张数没卡死，是因为一页约 400–1300 tokens 本来就在模型上下文里，
 * 而 95 页这种规模之前是跑得通的，不能因为修 413 把它一起砍掉。
 */
/** 读一个数字型环境变量；浏览器里没有 process，静态版会用到这个模块 */
function envNum(name, fallback) {
  try {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export const MAX_IMAGES_PER_REQUEST = envNum('AI_MAX_IMAGES', 80);
export const IMAGE_BUDGET_BYTES = envNum('AI_IMAGE_BUDGET_MB', 16) * 1024 * 1024;

/** 取图片的 base64 字符串（图片既可能是字符串，也可能是带 dataUrl 的页面对象） */
const urlOf = (im) => (typeof im === 'string' ? im : im?.dataUrl || im?.url || '');

/** 从 list 里均匀取 n 个（保留首尾），n >= list.length 时原样返回 */
export function sampleEven(list, n) {
  const src = Array.isArray(list) ? list : [];
  if (n >= src.length) return src.slice();
  if (n <= 1) return src.length ? [src[0]] : [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (src.length - 1)) / (n - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(src[idx]);
  }
  return out;
}

/**
 * 把图片列表裁到「单次请求放得下」的规模。
 *
 * 超出时**按整份材料均匀取样**，而不是只留前 N 页 —— 一本 224 页的书只送前 24 页，
 * 分析出来的结论会严重偏向前言和目录。
 */
export function packImages(images = [], opts = {}) {
  const list = (images || []).filter(Boolean);
  const max = Number(opts.max) > 0 ? Number(opts.max) : MAX_IMAGES_PER_REQUEST;
  const budget = Number(opts.budget) > 0 ? Number(opts.budget) : IMAGE_BUDGET_BYTES;
  if (!list.length) return { used: [], dropped: 0, bytes: 0 };

  let used = sampleEven(list, Math.min(max, list.length));
  let bytes = used.reduce((n, im) => n + urlOf(im).length, 0);
  // 张数够了但体积还超预算（整页扫描件单页就很大）→ 再降一档重新均匀取样
  while (used.length > 1 && bytes > budget) {
    used = sampleEven(list, Math.max(1, Math.floor(used.length * 0.7)));
    bytes = used.reduce((n, im) => n + urlOf(im).length, 0);
  }
  return { used, dropped: list.length - used.length, bytes };
}

/** 网关因为请求体太大拒掉（413 / Request Entity Too Large） */
export function isPayloadTooLarge(err) {
  if (err?.status === 413) return true;
  return /413|entity too large|payload too large|request body too large/i.test(String(err?.message || ''));
}

/**
 * 上下文塞不下（图太多把 token 撑爆了）。
 * 不同家措辞不一样，所以按关键词认。
 */
export function isContextOverflow(err) {
  const s = String(err?.message || '');
  return /maximum context length|context length|context_length_exceeded|too many tokens|reduce the length|exceeds the maximum|token limit/i.test(
    s,
  );
}

/** 请求体太大 或者 上下文塞不下 —— 两种情况都靠「少发几张图」自救 */
const shouldShrinkImages = (err) => isPayloadTooLarge(err) || isContextOverflow(err);

/** 把「一段文字 + 若干张图」拼成 OpenAI 兼容的多模态 content */
export function buildContent(user, images, { budget } = {}) {
  // 这里是所有请求的唯一出口，在这里兜底裁一次，任何调用点都不可能发出超限的请求
  const { used } = packImages(images, budget ? { budget } : undefined);
  if (!used.length) return user;
  return [
    { type: 'text', text: user },
    ...used.map((im) => ({ type: 'image_url', image_url: { url: urlOf(im) } })),
  ];
}

/**
 * 记住「这家服务商的请求体上限大概是多少」。
 *
 * 不同网关差得很远：api.deepseek.com 实测在 50 MB 处才 413，
 * 而不少中转/自建网关只有几 MB 甚至几百 KB。与其每次发出去撞一次墙，
 * 不如撞过之后把上限记下来，后面的请求直接从更小的预算开始。
 * key 用 baseUrl，所以换服务商不会互相污染。
 */
const tooBigByBase = new Map();

/** 这家服务商据我们所知不能超过多少字节（没记录就返回 null） */
export function knownBodyLimit(baseUrl = '') {
  const v = tooBigByBase.get(String(baseUrl));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function rememberTooBig(baseUrl, bytes) {
  const k = String(baseUrl || '');
  const prev = tooBigByBase.get(k);
  if (!Number.isFinite(prev) || bytes < prev) tooBigByBase.set(k, bytes);
}

/** 请求体的实际字节数（用来记账，也用来在报错里说清楚到底发了多大） */
function bodyBytes(spec) {
  try {
    return Buffer.byteLength(JSON.stringify(spec.body));
  } catch {
    return 0;
  }
}

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

export async function complete(
  cfg,
  { system, user, images = null, maxTokens = 4096, temperature = 0.3, json = false, signal },
) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });

  let prompt = user;
  // 撞过 413 就按已知上限折半留余量，别再从头撞一遍
  const known = knownBodyLimit(cfg.baseUrl);
  const budget = known ? Math.max(64 * 1024, Math.floor(known / 2)) : IMAGE_BUDGET_BYTES;

  const spec = (imgs) => {
    const hasImages = Array.isArray(imgs) && imgs.length > 0;
    const body = {
      messages: [...messages, { role: 'user', content: buildContent(prompt, imgs, { budget }) }],
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };
    if (json) body.response_format = { type: 'json_object' };
    // 带图时必须换成视觉模型 —— 配置的那个（比如 deepseek-v4-pro）根本不认图片
    return { body, model: hasImages ? cfg.visionModel || 'deepseek-flash' : cfg.model };
  };

  const read = async ({ body, model }) => {
    const res = await request(cfg, body, { signal, model });
    const data = await res.json();
    const choice = data?.choices?.[0] || {};
    const msg = choice.message || {};
    let content = msg.content ?? '';
    // 有些模型（视觉模型尤其）会把整个输出预算烧在内部推理上，正文留空、
    // 全在 reasoning_content 里。**只有推理里确实写出了 JSON 才捞**：
    // 纯推理（没有花括号）捞回来只会喂给 JSON 解析器一堆废话，
    // 还会把「正文为空」这个信号盖掉，让下面的补救逻辑没机会跑。
    const reasoning = msg.reasoning_content ?? msg.reasoning ?? '';
    if (!String(content).trim() && /[[{]/.test(reasoning)) content = reasoning;
    return {
      content,
      usage: data?.usage || null,
      finish: choice.finish_reason || '',
      hasReasoning: Boolean(reasoning),
      // 给日志用：原始返回。没有正文时至少把推理留下 —— 不然只看到「空内容」，
      // 根本不知道模型当时在干什么。
      rawForLog: String(content || '').trim() ? content : reasoning,
      model,
    };
  };

  let imgs = images;
  // 图要一路退到 0 张，文字还要能继续折半，所以步子给够
  const MAX_SHRINK = 10;
  // 输出被截断时的补救：一步步抬高 max_tokens（8000→16000→32000），最多两级。
  // 日志里实测过：示例讲解那种（25 张图 + 长输出）抬到 16000 还是不够，
  // 只给一次机会就等于没救。
  const MAX_BUMPS = 2;
  let bumpsDone = 0;
  let prevTokens = null;
  let imagesDropped = false;
  const emptyError = (out, imgCount, tokens) =>
    new AIError(
      `模型返回了空内容（有 finish_reason 但没有正文）。这次带了 ${imgCount} 张图、max_tokens=${tokens}` +
        `${out?.finish ? `、finish_reason=${out.finish}` : ''}` +
        `${out?.hasReasoning ? '，看上去输出全用在内部推理上了' : ''}。` +
        `已经试过抬高 max_tokens 和去掉图片两条路。可以点「重新生成本节」再试一次；` +
        `如果总是这一节失败，可以在生成时把「读图」改成「纯文字」。`,
      { retryable: true },
    );

  for (let attempt = 0; ; attempt++) {
    const cur = spec(imgs);
    const bytes = bodyBytes(cur);
    try {
      const out = await read(cur);

      // finish_reason=length = 输出被 max_tokens 截断了。分两种情况，都要处理：
      //   · 正文为空 → 模型把预算全烧在内部推理上，什么都没吐出来
      //   · 正文非空 → 写到一半断了。extractJson 会把残缺 JSON「尽力修复」成能解析的，
      //     于是变成**静默少内容**（Lab 少几个实验、讲解稿少几页），比报错还难发现。
      // 两种都先试着多给点预算重来；这条不改图片，质量损失最小。
      if (out.finish === 'length' && bumpsDone < MAX_BUMPS && maxTokens < 32000) {
        bumpsDone += 1;
        prevTokens = maxTokens;
        maxTokens = Math.min(32000, maxTokens * 2);
        console.warn(
          `[truncated] 输出被 max_tokens=${prevTokens} 截断（正文 ${String(out.content || '').length} 字），` +
            `抬到 ${maxTokens} 重试（第 ${bumpsDone}/${MAX_BUMPS} 级）` +
            `${String(out.content || '').trim() ? '，避免只拿到残缺内容' : ''}`,
        );
        continue;
      }
      if (String(out.content || '').trim() && out.finish === 'length') {
        // 预算已经给到顶还是被截断：只能收下这份残缺内容，但必须留痕
        console.warn(
          `[truncated] max_tokens=${maxTokens} 仍然截断，JSON 可能不完整（已被修复逻辑兜住，内容可能缺）`,
        );
        report('ai.truncated', {
          error: `输出被 max_tokens=${maxTokens} 截断`,
          model: out.model || cfg.model,
          finish_reason: out.finish,
          raw: out.rawForLog,
        });
      }
      if (String(out.content || '').trim()) return out;

      // ---------- 正文为空：视觉模型带图 + 要求 JSON 时最容易发生 ----------
      // 注意：finish_reason=length 的那种，上面「截断」分支已经抬过预算了
      // （bumpsDone 已经用满），走到这里说明抬预算也没救回来。
      const count = Array.isArray(imgs) ? imgs.length : 0;

      // 把模型这次的真实状态交给日志，别只留一句「空内容」
      report('ai.empty', {
        error: out.finish ? `finish_reason=${out.finish}` : '空正文',
        model: out.model || cfg.model,
        visionModel: imgs && imgs.length ? cfg.visionModel || 'deepseek-flash' : '',
        images: Array.isArray(imgs) ? imgs.length : 0,
        maxTokens,
        hasReasoning: out.hasReasoning ? 'yes' : 'no',
        raw: out.rawForLog || '（模型连 reasoning 都没给）',
      });
      // 去掉图片：思维导图那次就是这个结论 —— 只发文字立刻正常
      if (count > 0 && !imagesDropped) {
        imagesDropped = true;
        console.warn(`[empty] 正文为空，去掉 ${count} 张图只发文字重试`);
        imgs = [];
        continue;
      }
      throw emptyError(out, count, maxTokens);
    } catch (err) {
      if (err instanceof AIError && err.retryable) throw err;
      // 抬高 max_tokens 之后被接口拒了（有些服务商的输出上限比 32000 低得多）：
      // 退回原来的值，改走去掉图片那条路，别让整节就此失败
      const badParam = err?.status === 400 || err?.status === 422;
      if (badParam && bumpsDone > 0 && prevTokens !== null && maxTokens !== prevTokens) {
        console.warn(`[empty] 抬高后的 max_tokens=${maxTokens} 被接口拒绝，退回 ${prevTokens}，改试去掉图片`);
        maxTokens = prevTokens;
        bumpsDone = MAX_BUMPS; // 别再往上试了，接口不认
        if (!imagesDropped && Array.isArray(imgs) && imgs.length) {
          imagesDropped = true;
          imgs = [];
          continue;
        }
      }
      if (!shouldShrinkImages(err)) {
        // 有些第三方 OpenAI 兼容接口不支持 response_format，降级重试一次（提示词里已经要求输出 JSON）
        const unsupported = err?.status === 400 || err?.status === 404 || err?.status === 422;
        if (json && unsupported && cur.body.response_format) {
          const fallback = { ...cur, body: { ...cur.body } };
          delete fallback.body.response_format;
          return await read(fallback);
        }
        throw err;
      }

      rememberTooBig(cfg.baseUrl, bytes);
      if (attempt >= MAX_SHRINK) {
        throw new AIError(
          `请求体 ${mb(bytes)} 被模型网关拒绝了（${isPayloadTooLarge(err) ? '413' : '上下文超限'}）。` +
            `已经退到最小仍然不行：这次带了 ${Array.isArray(imgs) ? imgs.length : 0} 张图、文字 ${prompt.length} 字。` +
            `请检查所配置的接口地址（${cfg.baseUrl}）的请求体上限。`,
          { status: err?.status || 413 },
        );
      }

      const count = Array.isArray(imgs) ? imgs.length : 0;
      if (count > 0) {
        // 一直退到 0 张 —— 只发文字。文字通常只有几百 KB，任何网关都过得去。
        // 之前只退 3 次（40→20→10→5）就放弃，遇到上限很紧的中转网关照样 413。
        const next = Math.floor(count / 2);
        console.warn(
          `[vision] ${isPayloadTooLarge(err) ? '请求体过大' : '上下文超限'}（${mb(bytes)}, ${count} 张图），` +
            `降到 ${next} 张重试`,
        );
        imgs = next > 0 ? sampleEven(imgs, next) : [];
      } else {
        // 一张图都没有还超限，那只能是文字太长 —— 砍掉后半段再试
        const keep = Math.max(2000, Math.floor(prompt.length / 2));
        console.warn(`[vision] 纯文字请求也被拒（${mb(bytes)}），把上下文从 ${prompt.length} 字砍到 ${keep} 字重试`);
        prompt = `${prompt.slice(0, keep)}\n\n……（因接口请求体限制，后半部分已省略）`;
      }
    }
  }
}

/**
 * 要求模型输出 JSON 并解析。
 * 模型偶尔会吐出语法不合法的 JSON（少个冒号、多个逗号），括号配平修复救不了这种，
 * 所以解析失败会自动重试一次——重试一次基本都能拿到合法 JSON，比整节失败划算。
 */
/**
 * 让模型按用户选的界面语言产出内容。
 *
 * 挂在这里而不是逐个改提示词：completeJSON / stream 是唯一的出口，
 * 改一处所有阶段（分析 / 示例 / 讲稿 / 出题 / Lab / 精讲 / 问答）一起生效。
 */
export function withLang(system = '', lang = 'zh') {
  if (lang !== 'en') return system;
  return `${system}

【Output language: English】
Write every natural-language field in **English**. This includes titles, descriptions,
explanations, steps, hints, summaries, feedback and chat replies.
Do NOT translate:
- quoted courseware text (the coursewareSays field, excerpts) — keep the original wording,
  it is the evidence the answer is based on;
- proper nouns, register names, code identifiers, file names and page labels
  (the page label 第 3 页 may stay as-is inside a citation).
It is fine for an English sentence to contain a quoted Chinese fragment.`;
}

export async function completeJSON(
  cfg,
  { system, user, images = null, maxTokens = 8000, temperature = 0.25, signal, retries = 1 },
) {
  system = withLang(system, cfg?.lang || 'zh');
  let lastErr = null;
  let lastRaw = '';
  let lastFinish = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { content, usage, finish } = await complete(cfg, {
      system,
      user,
      images,
      maxTokens,
      temperature,
      json: true,
      signal,
    });
    lastRaw = content;
    lastFinish = finish || '';
    try {
      return { data: extractJson(content), usage };
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      if (attempt < retries) {
        console.warn(`[json] 解析失败，重试一次：${err.message}`);
      }
    }
  }
  // 把模型**原始返回**交给日志。只报「JSON 无法解析」，用户和我们都不知道模型写了什么；
  // 而同一个报错坐标能对应七八种畸形（没引号的键、省略号占位、注释、代码围栏…），
  // 不给原文就只能一轮轮猜。落盘之后打开日志文件就一眼看到。
  report('ai.json', {
    error: lastErr,
    model: cfg?.model,
    visionModel: images && images.length ? cfg?.visionModel || 'deepseek-flash' : '',
    images: Array.isArray(images) ? images.length : 0,
    finish_reason: lastFinish || '（未返回）',
    attempt: retries + 1,
    raw: lastRaw,
  });
  throw new AIError(
    `模型返回的 JSON 无法解析（${lastErr?.message || '未知原因'}）。可以点「重新生成本节」再试一次。` +
      `（模型原始返回已写入日志：设置 → 查看日志，或看 data/logs/ 下的文件）`,
  );
}

/** 流式输出，逐段回调 */
export async function stream(
  cfg,
  { system, messages = [], user, images = null, maxTokens = 4096, temperature = 0.3, signal, onDelta },
) {
  system = withLang(system, cfg?.lang || 'zh');
  const known = knownBodyLimit(cfg.baseUrl);
  const budget = known ? Math.max(64 * 1024, Math.floor(known / 2)) : IMAGE_BUDGET_BYTES;

  // 问答一般不带图，但整份课件的上下文可能有几十万字。413 发生在读到响应体之前，
  // 所以还没吐出任何增量时可以安全重试 —— 砍一半上下文再发。
  let prompt = user;
  let imgs = images;
  let res = null;
  for (let attempt = 0; ; attempt++) {
    const hasImages = Array.isArray(imgs) && imgs.length > 0;
    const payload = [];
    if (system) payload.push({ role: 'system', content: system });
    payload.push(...messages);
    if (prompt) payload.push({ role: 'user', content: buildContent(prompt, imgs, { budget }) });

    try {
      res = await request(
        cfg,
        { messages: payload, max_tokens: maxTokens, temperature, stream: true },
        { signal, model: hasImages ? cfg.visionModel || 'deepseek-flash' : cfg.model },
      );
      break;
    } catch (err) {
      const bytes = (() => {
        try {
          return Buffer.byteLength(JSON.stringify(payload));
        } catch {
          return 0;
        }
      })();
      if (!shouldShrinkImages(err) || attempt >= 10) throw err;
      rememberTooBig(cfg.baseUrl, bytes);
      if (Array.isArray(imgs) && imgs.length) {
        const next = Math.floor(imgs.length / 2);
        console.warn(`[vision] 流式请求体过大（${mb(bytes)}），图降到 ${next} 张重试`);
        imgs = next > 0 ? sampleEven(imgs, next) : [];
      } else {
        const keep = Math.max(2000, Math.floor((prompt || '').length / 2));
        console.warn(`[vision] 流式请求体过大（${mb(bytes)}），上下文从 ${(prompt || '').length} 字砍到 ${keep} 字重试`);
        prompt = `${(prompt || '').slice(0, keep)}\n\n……（因接口请求体限制，后半部分已省略）`;
      }
    }
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payloadStr = trimmed.slice(5).trim();
      if (payloadStr === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payloadStr);
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      } catch {
        /* 忽略心跳等非 JSON 行 */
      }
    }
  }
  return full;
}
