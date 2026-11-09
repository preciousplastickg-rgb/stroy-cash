// Cache-first service worker. The cache name follows the app version: bump VERSION
// together with js/version.js on every release, tests/pwa.test.js checks both.
const VERSION = '1.5.0';
const CACHE = `stroy-cash-${VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/app.js',
  'js/backup.js',
  'js/barter.js',
  'js/install.js',
  'js/db.js',
  'js/ledger.js',
  'js/money.js',
  'js/nav.js',
  'js/recurring.js',
  'js/reports.js',
  'js/security.js',
  'js/seed.js',
  'js/version.js',
  'js/screens/analytics.js',
  'js/screens/barter-screen.js',
  'js/screens/close-month.js',
  'js/screens/expense.js',
  'js/screens/home.js',
  'js/screens/income.js',
  'js/screens/issue.js',
  'js/screens/journal.js',
  'js/screens/lender.js',
  'js/screens/more.js',
  'js/screens/objects.js',
  'js/screens/person.js',
  'js/screens/pin.js',
  'js/screens/recurring-screen.js',
  'js/screens/refs.js',
  'js/screens/reports-screen.js',
  'js/screens/restore.js',
  'js/screens/transaction.js',
  'js/screens/transfer.js',
  'js/screens/welcome.js',
  'js/ui/amount-input.js',
  'js/ui/combo.js',
  'js/ui/confirm.js',
  'js/ui/bars.js',
  'js/ui/debt-row.js',
  'js/ui/dom.js',
  'js/ui/edit-sheet.js',
  'js/ui/form.js',
  'js/ui/icons.js',
  'js/ui/operation-row.js',
  'js/ui/photo-viewer.js',
  'js/ui/photo.js',
  'js/ui/picker.js',
  'js/ui/share.js',
  'js/ui/sheet.js',
  'js/ui/swipe.js',
  'js/ui/toast.js',
  'js/ui/transition.js',
  'vendor/dexie.mjs',
  'vendor/jszip.min.js',
  'vendor/xlsx.full.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
    // Prototype versions have no update bar: a page on one of them could wait for
    // this worker forever, so it takes over at once.
    const names = await caches.keys();
    if (names.some((name) => name.startsWith('stroy-cash-0.'))) await self.skipWaiting();
  })());
});

// The new version waits until the user taps "Обновить".
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    // Only this version's cache: caches.match() would also find files of the old one.
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    return cached ?? fetch(event.request);
  })());
});
