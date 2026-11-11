/* ============================================================================
   离线缓存 / 可安装（Service Worker）
   ----------------------------------------------------------------------------
   目标：装到手机桌面之后能像 App 一样打开，断网也能进界面。
   三条硬性注意：
     1. 业务接口（/api/）和课件文件（/media/）绝不进缓存 —— 那些是私人内容，
        而且必须是实时的。
     2. version.json 也要绕开缓存，否则「检查更新」永远看到旧版本。
     3. **静态资源必须「先网络、后缓存」**。
        以前这里是「先缓存、后网络」：页面导航拿到的是新的 index.html，
        而 app.js / styles.css 却是缓存里的旧版本 —— 新 HTML 配旧 JS，
        整个前端就白屏了，而且那个旧缓存**永远不会被清掉**，因为缓存名
        写死成 cw-2.0.0，一直不变就等于一直不清。

        这套缓存是为了「断网也能进界面」，不是为了让用户看到旧代码。
        所以在线时永远走网络（本地服务 / 局域网，本来就快），
        只有真的连不上时才回退到缓存。
   ========================================================================== */
const VERSION = 'cw-2.3.0';
const SHELL_CACHE = `${VERSION}-shell`;

/* 离线时用来兜底的应用外壳。逐个 add，缺哪个都不影响整体 */
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './icons.js',
  './app.js',
  './quiz-lab.js',
  './slides.js',
  './i18n.js',
  './i18n-dict.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 用 reload 绕开 HTTP 缓存，保证预缓存的是真正最新的
      await Promise.all(
        SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => null)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // 清掉所有旧版本的缓存 —— 这一步是「换了新版就别再拿旧文件」的关键
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('cw-') && !n.startsWith(VERSION)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
      /**
       * 把已经开着的页面刷新一次。
       *
       * 必要性：用户可能正卡在「用旧 app.js 渲染的空白页」上 —— 那种页面自己
       * 不会重新加载，光靠 claim() 只能管下次打开。激活时主动刷新一次，
       * 才能让卡住的人立刻恢复。
       * 只在 SW 更新（激活）时发生一次，不会形成刷新循环。
       */
      try {
        const list = await self.clients.matchAll({ type: 'window' });
        for (const c of list) {
          if (c.url && c.url.startsWith(self.registration.scope)) c.navigate(c.url).catch(() => {});
        }
      } catch {
        /* 老浏览器没有 navigate，忽略 */
      }
    })(),
  );
});

/** 这些路径永远走网络，不缓存 */
function bypass(url) {
  return (
    url.pathname.includes('/api/') ||
    url.pathname.includes('/media/') ||
    url.pathname.endsWith('/version.json') ||
    url.pathname.endsWith('/sw.js')
  );
}

/** 稳的请求头，避免被中间的 HTTP 缓存回旧文件 */
function freshInit(req) {
  // navigate 请求不能带 cache 选项以外的东西，这里只对静态资源用
  return { cache: 'no-cache', credentials: 'same-origin' };
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (bypass(url)) return;

  // 页面导航：优先网络，断网时回退到缓存的外壳
  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            new Response('离线，且没有缓存到页面', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            })
          );
        }
      })(),
    );
    return;
  }

  // 静态资源：**先网络**（保证 HTML 和 JS 永远同一版本），失败才用缓存
  e.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const res = await fetch(req, freshInit(req));
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => null);
        return res;
      } catch {
        const hit = await cache.match(req);
        // 离线且没缓存过：给一个空响应而不是让页面崩在解析上
        return hit || new Response('', { status: 504 });
      }
    })(),
  );
});

// 页面里点「立即更新」时用得上
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
