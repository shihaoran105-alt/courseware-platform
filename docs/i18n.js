/* ============================================================
   中英文切换
   ------------------------------------------------------------
   做法：**不改渲染代码**，而是在渲染结果上做一层文本替换。
   理由是这个项目的界面文案大量内嵌在模板字符串里（400+ 处），
   逐处改成 t('...') 既容易漏、又容易把 `q.source === '课件原题'`
   这类**数据比较**误伤成翻译调用。

   于是：
     · 页面照旧用中文渲染
     · 渲染完之后，遍历文本节点，按词典替换成英文
     · 每个被改过的节点都记下原文，切回中文时原样还原
     · MutationObserver 兜住所有后渲染的内容（弹窗、toast、流式回答…）
     · 词典里没有的文案保持中文 —— 漏译只是显示中文，不会显示乱码

   切换语言只影响界面；模型生成内容用什么语言，靠请求头 X-Lang 告诉服务端。
   ============================================================ */

(function () {
  const LS_LANG = 'cw_lang';

  /** 词典：中文原文 → 英文。变量用 {0} {1}，配正则做运行时匹配 */
  const DICT = window.CW_EN_DICT || { exact: {}, patterns: [] };

  const state = {
    lang: 'zh',
    // 记录每个节点/属性被替换前的原文，切回中文时还原
    applying: false,
  };

  /* ------------------------------ 查表 ------------------------------ */

  /** 精确命中（O(1)） */
  function lookupExact(src) {
    return DICT.exact[src];
  }

  /** 带变量的按正则跑一遍，命中的把捕获组填进 {0} {1} */
  function lookupPattern(src) {
    for (const p of DICT.patterns || []) {
      if (!p || typeof p.re !== 'string' || typeof p.en !== 'string') continue;
      let m;
      try {
        m = src.match(new RegExp(p.re));
      } catch {
        continue; // 正则写错了也跳过，别让一条坏规则干掉整个翻译
      }
      if (!m) continue;
      return p.en.replace(/\{(\d+)\}/g, (_, i) => (m[Number(i) + 1] ?? '').trim());
    }
    return null;
  }

  function translate(src) {
    if (!src) return null;
    const t = src.trim();
    if (!t) return null;
    // 保留首尾空白，别把排版搞乱
    const lead = src.slice(0, src.indexOf(t[0]));
    const trail = src.slice(src.lastIndexOf(t[t.length - 1]) + 1);
    const hit = lookupExact(t) || lookupPattern(t);
    return hit ? lead + hit + trail : null;
  }

  /** 供新代码直接调用：t('保存', {0: n}) */
  function t(zh, vars) {
    if (state.lang !== 'en') return zh;
    const hit = lookupExact(zh) || lookupPattern(zh);
    if (!hit) return zh;
    return vars ? hit.replace(/\{(\d+)\}/g, (_, i) => vars[Number(i)] ?? vars[i] ?? '') : hit;
  }

  /* --------------------------- 文本节点 --------------------------- */

  const ATTRS = ['placeholder', 'title', 'aria-label'];

  function xlateTextNode(node, lang) {
    const cur = node.nodeValue;
    if (!cur) return;
    // 只处理含中文的，省掉大量无用比对
    if (!/[\u4e00-\u9fff]/.test(cur) && node.__cwSrc === undefined) return;

    if (lang === 'en') {
      if (node.__cwSrc === undefined) {
        node.__cwSrc = cur;
      } else if (cur !== node.__cwSrc && cur !== translate(node.__cwSrc)) {
        // 应用自己改写了这个节点（比如按钮文案切换），把新值当原文
        node.__cwSrc = cur;
      }
      const out = translate(node.__cwSrc);
      if (out && node.nodeValue !== out) node.nodeValue = out;
    } else if (node.__cwSrc !== undefined && node.nodeValue !== node.__cwSrc) {
      node.nodeValue = node.__cwSrc;
    }
  }

  function xlateElement(el, lang) {
    for (const a of ATTRS) {
      if (!el.hasAttribute?.(a)) continue;
      const key = '__cwAttr_' + a;
      const cur = el.getAttribute(a);
      if (lang === 'en') {
        if (el[key] === undefined) el[key] = cur;
        else if (cur !== el[key] && cur !== translate(el[key])) el[key] = cur;
        const out = translate(el[key]);
        if (out && cur !== out) el.setAttribute(a, out);
      } else if (el[key] !== undefined && cur !== el[key]) {
        el.setAttribute(a, el[key]);
      }
    }
  }

  function applyTo(root, lang) {
    if (!root) return;
    const doc = root.ownerDocument || document;
    if (root.nodeType === 3) {
      xlateTextNode(root, lang);
      return;
    }
    if (root.nodeType === 1) xlateElement(root, lang);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) xlateTextNode(n, lang);
      else {
        xlateElement(n, lang);
        // 下拉框选项的文案在 <option> 的文本节点里，上面的 walker 会覆盖到
      }
    }
  }

  /* --------------------------- 观察动态内容 --------------------------- */

  let observer = null;
  let scheduled = false;
  const dirty = new Set();

  function flush() {
    scheduled = false;
    if (state.lang !== 'en' || !dirty.size) {
      dirty.clear();
      return;
    }
    state.applying = true;
    for (const node of dirty) {
      if (!node.isConnected) continue;
      applyTo(node, 'en');
    }
    dirty.clear();
    state.applying = false;
    // 自己刚改过 DOM，会再触发一次 observe，这里主动清一下队列
    if (observer) observer.takeRecords();
  }

  function schedule(node) {
    if (state.lang !== 'en') return;
    dirty.add(node.nodeType === 3 ? node.parentNode || node : node);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  }

  function startObserver() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver((records) => {
      if (state.applying) return;
      for (const r of records) {
        if (r.type === 'characterData') schedule(r.target);
        else for (const n of r.addedNodes) if (n.nodeType === 1 || n.nodeType === 3) schedule(n);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /* ------------------------------ 切换 ------------------------------ */

  function setLang(lang, { persist = true } = {}) {
    state.lang = lang === 'en' ? 'en' : 'zh';
    if (persist) {
      try {
        localStorage.setItem(LS_LANG, state.lang);
      } catch {
        /* 隐私模式忽略 */
      }
    }
    const html = document.documentElement;
    if (html) html.setAttribute('lang', state.lang === 'en' ? 'en' : 'zh-CN');
    applyTo(document.body, state.lang);
    if (observer) observer.takeRecords();
    renderToggle();
    document.dispatchEvent(new CustomEvent('cw:lang', { detail: { lang: state.lang } }));
  }

  function current() {
    return state.lang;
  }

  /* ---------------------------- 切换按钮 ---------------------------- */

  function renderToggle() {
    const el = document.getElementById('langChip');
    if (!el) return;
    const en = state.lang === 'en';
    el.textContent = en ? 'EN' : '中';
    el.title = en ? 'Switch to 中文' : 'Switch to English';
    el.setAttribute('aria-label', en ? 'Switch language to Chinese' : '切换语言为英文');
    el.classList.toggle('on', en);
  }

  function init() {
    let saved = '';
    try {
      saved = localStorage.getItem(LS_LANG) || '';
    } catch {
      /* 忽略 */
    }
    // 没存过就跟随浏览器语言：中文环境用中文，其余用英文
    const guess = saved || (/^zh\b/i.test(navigator.language || '') ? 'zh' : 'en');
    state.lang = guess === 'en' ? 'en' : 'zh';
    document.documentElement.setAttribute('lang', state.lang === 'en' ? 'en' : 'zh-CN');
    startObserver();
    renderToggle();

    const chip = document.getElementById('langChip');
    if (chip) {
      chip.addEventListener('click', () => setLang(state.lang === 'en' ? 'zh' : 'en'));
    }
  }

  window.CWI18n = { t, setLang, current, applyTo, translate, get lang() { return state.lang; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
