// Bump whenever the caching policy changes — activate drops every other cache.
const CACHE_NAME = 'synapse-pharm-v5';
const STATIC_ASSETS = [
  '/',
  '/login',
  '/portal/dashboard',
  '/portal/pos',
  '/portal/inventory',
  '/portal/customers',
  '/portal/orders',
  '/portal/transactions',
  '/portal/reports',
  '/portal/settings',
  '/manifest.json',
  '/logo.png',
  '/favicon.ico',
  '/splash.html'
];

// IndexedDB Helpers (Native API for SW compatibility)
const DB_NAME = 'synapse-pharm-offline';
const STORE_NAME = 'sync_queue';
const METADATA_STORE = 'metadata';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('transactions')) {
        db.createObjectStore('transactions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getPendingMutations(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      resolve(request.result.filter(action => !action.synced));
    };
    request.onerror = () => reject(request.error);
  });
}

async function markActionSynced(db, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(id);
    getRequest.onsuccess = () => {
      const data = getRequest.result;
      if (data) {
        data.synced = true;
        const updateRequest = store.put(data);
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = () => reject(updateRequest.error);
      } else {
        resolve();
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Cache each asset on its own: addAll rejects the whole install if a single
    // URL fails, which would leave the portal with no offline support at all.
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(STATIC_ASSETS.map((asset) => cache.add(asset).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept non-GET requests — server actions, form POSTs, etc.
  if (request.method !== 'GET') return;

  // API responses carry customer PII and financial records. They are never
  // written to Cache Storage — an offline device must not hold a readable copy
  // of the customer book. Requests go straight to the network and fail closed.
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests: Network-first with cache fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
          return networkResponse;
        })
        .catch(() => {
          return caches.match(request) || caches.match('/portal/pos');
        })
    );
    return;
  }

  // Static Assets & Next.js chunks: Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const networkFetch = fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && request.method === 'GET') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => null);

      return cachedResponse || networkFetch;
    })
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-mutations') {
    event.waitUntil(replayMutations());
  }
});

async function replayMutations() {
  try {
    const db = await openDB();
    const pending = await getPendingMutations(db);

    for (const action of pending) {
      try {
        const response = await fetch(action.url, {
          method: action.method,
          headers: {
            ...action.headers,
            'Content-Type': 'application/json',
            'X-Offline-Replay': 'true'
          },
          body: JSON.stringify(action.body)
        });

        if (response.ok) {
          await markActionSynced(db, action.id);
          console.log('[SW] Replayed mutation:', action.method, action.url);
        }
      } catch (err) {
        console.error('[SW] Failed to replay mutation:', action.id, err);
      }
    }
  } catch (err) {
    console.error('[SW] Replay error:', err);
  }
}
