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

/** 从模型输出里稳健地取出 JSON（容忍 ```json 包裹、前后废话、被截断） */
export function extractJson(text) {
  if (!text || !text.trim()) throw new Error('模型返回了空内容');
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error('模型返回中没有找到 JSON');
  const open = t[start];
  const close = open === '{' ? '}' : ']';

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

function repairJson(s) {
  let out = s.replace(/,\s*$/, '');
  // 去掉尾部不完整的 `,"key":` 或 `"key":`
  out = out.replace(/,\s*"[^"]*"\s*:\s*$/, '').replace(/"[^"]*"\s*:\s*$/, '');
  out = out.replace(/,\s*$/, '');

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

/** 一次性拿到完整回复 */
/** 把「一段文字 + 若干张图」拼成 OpenAI 兼容的多模态 content */
export function buildContent(user, images) {
  const imgs = (images || []).filter(Boolean);
  if (!imgs.length) return user;
  return [
    { type: 'text', text: user },
    ...imgs.map((im) => ({
      type: 'image_url',
      image_url: { url: typeof im === 'string' ? im : im.dataUrl || im.url || '' },
    })),
  ];
}

export async function complete(
  cfg,
  { system, user, images = null, maxTokens = 4096, temperature = 0.3, json = false, signal },
) {
  const hasImages = Array.isArray(images) && images.length > 0;
  // 带图时必须换成视觉模型 —— 配置的那个（比如 deepseek-v4-pro）根本不认图片
  const model = hasImages ? cfg.visionModel || 'deepseek-flash' : cfg.model;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: buildContent(user, images) });

  const body = { messages, max_tokens: maxTokens, temperature, stream: false };
  if (json) body.response_format = { type: 'json_object' };

  const read = async (b) => {
    const res = await request(cfg, b, { signal, model });
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { content, usage: data?.usage || null };
  };

  try {
    return await read(body);
  } catch (err) {
    // 有些第三方 OpenAI 兼容接口不支持 response_format，降级重试一次（提示词里已经要求输出 JSON）
    const unsupported = err?.status === 400 || err?.status === 404 || err?.status === 422;
    if (json && unsupported) {
      const fallback = { ...body };
      delete fallback.response_format;
      return await read(fallback);
    }
    throw err;
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
 * 改一处所有阶段（分析 / 事例 / 讲稿 / 出题 / Lab / 精讲 / 问答）一起生效。
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
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { content, usage } = await complete(cfg, {
      system,
      user,
      images,
      maxTokens,
      temperature,
      json: true,
      signal,
    });
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
  throw new AIError(`模型返回的 JSON 无法解析（${lastErr?.message || '未知原因'}）。可以点「重新生成本节」再试一次。`);
}

/** 流式输出，逐段回调 */
export async function stream(
  cfg,
  { system, messages = [], user, images = null, maxTokens = 4096, temperature = 0.3, signal, onDelta },
) {
  system = withLang(system, cfg?.lang || 'zh');
  const hasImages = Array.isArray(images) && images.length > 0;
  const payload = [];
  if (system) payload.push({ role: 'system', content: system });
  payload.push(...messages);
  if (user) payload.push({ role: 'user', content: buildContent(user, images) });

  const res = await request(
    cfg,
    { messages: payload, max_tokens: maxTokens, temperature, stream: true },
    { signal, model: hasImages ? cfg.visionModel || 'deepseek-flash' : cfg.model },
  );

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
