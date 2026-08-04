/* Sports Club Scheduler service worker — complete installed-app updates. */
const CACHE_NAME = 'scs-app-build-548-balanced-mode';
const APP_SHELL = './index.html?v=548';

const ASSETS = [
  APP_SHELL,
  './ui.css?v=546', './rounds.css?v=528',
  './snapshot.js?v=259', './supabase.js?v=389', './auth.js?v=409',
  './authUI.js?v=511', './subscription.js?v=509', './HomeScreen.js?v=528',
  './engjap.js?v=508', './main.js?v=537', './games.js?v=548',
  './rounds.js?v=548', './mbm.js?v=259', './players.js?v=259',
  './importPlayers.js?v=512', './settings.js?v=329', './summary.js?v=259',
  './help.js?v=259', './profile.js?v=301', './dashboard.js?v=259',
  './slots.js?v=508', './notifications.js?v=261', './viewer.js?v=259',
  './report.js?v=259', './manifest.json?v=416',
  './male.png?v=259', './female.png?v=259', './win-cup.png?v=259',
  './lock.png?v=259', './unlock.png?v=259', './icon-192.png?v=259',
  './icon-512.png?v=312', './clubs-brand.png?v=481', './google-g.svg?v=354', './help_en.json?v=259', './help_jp.json?v=259',
  './help_kr.json?v=259', './help_zh.json?v=259', './help_vi.json?v=259'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.all(ASSETS.map(function(url) {
        return fetch(new Request(url, { cache: 'reload' })).then(function(response) {
          if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status));
          return cache.put(url, response);
        }).catch(function(error) {
          console.warn('SW: failed to cache', url, error);
        });
      }));
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(key) { return key !== CACHE_NAME; })
        .map(function(key) { return caches.delete(key); }));
    }).then(function() { return self.clients.claim(); })
  );
});

function isApiRequest(url) {
  return url.includes('supabase.co') || url.includes('workers.dev') ||
    url.includes('/db/') || url.includes('/auth/') || url.includes('/sub/') ||
    url.includes('/generate-round');
}

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET' || isApiRequest(event.request.url)) return;
  const isNavigation = event.request.mode === 'navigate';

  event.respondWith((async function() {
    try {
      const response = await fetch(event.request, { cache: 'no-store' });
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(isNavigation ? APP_SHELL : event.request, response.clone());
      }
      return response;
    } catch (error) {
      if (isNavigation) return (await caches.match(APP_SHELL)) || Response.error();
      return (await caches.match(event.request)) || Response.error();
    }
  })());
});
