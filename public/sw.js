/* ============================================================================
   离线缓存 / 可安装（Service Worker）
   ----------------------------------------------------------------------------
   目标：装到手机桌面之后能像 App 一样打开，断网也能进界面。
   两条硬性注意：
     1. 业务接口（/api/）和课件文件（/media/）绝不进缓存 —— 那些是私人内容，
        而且必须是实时的。
     2. version.json 也要绕开缓存，否则「检查更新」永远看到旧版本。
   ========================================================================== */
const VERSION = 'cw-2.0.0';
const SHELL_CACHE = `${VERSION}-shell`;

/* 首次安装时预缓存的应用外壳。逐个 add，缺哪个都不影响整体 */
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
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));
      await self.clients.claim();
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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (bypass(url)) return;

  // 页面导航：优先网络（这样更新能立刻拿到），断网时回退到缓存的外壳
  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone()).catch(() => null);
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            new Response('离线，且没有缓存到页面', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
          );
        }
      })(),
    );
    return;
  }

  // 静态资源：先用缓存立刻返回，同时后台悄悄更新（下次打开就是新的）
  e.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => null);
          return res;
        })
        .catch(() => null);
      return hit || (await network) || new Response('', { status: 504 });
    })(),
  );
});

// 页面里点「立即更新」时用得上
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
