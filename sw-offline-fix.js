// Updated fetch event handler in service worker with proper offline fallback
self.addEventListener('fetch', event => {
  const {request} = event;
  
  // Handle share_target POST requests
  if (request.method === 'POST' && new URL(request.url).pathname === '/share') {
    event.respondWith(handleShare(request));
    return;
  }
  
  // Handle summary status checks
  if (request.url.includes('summary-status') && request.method === 'GET') {
    const url = new URL(request.url).searchParams.get('url');
    if (url) {
      event.respondWith(checkSummaryStatus(url));
      return;
    }
  }
  
  // Handle summarize API calls
  if (request.url.includes('/api/summarize') && request.method === 'GET') {
    const url = new URL(request.url).searchParams.get('url');
    if (url) {
      event.respondWith(handleApiSummarize(url));
      return;
    }
  }
  
  // For normal page requests, use cache-first strategy
  if (request.method === 'GET') {
    event.respondWith(
      caches.match(request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request)
          .then(response => {
            // Cache successful responses for static assets
            if (response.ok && request.url.match(/\\.(html|css|js|json|svg|png|jpg|jpeg|gif|webp)$/)) {
              const responseClone = response.clone();
              caches.open(STATIC_CACHE).then(cache => {
                cache.put(request, responseClone);
              });
            }
            return response;
          })
          .catch(error => {
            // Offline fallback handling
            console.log('Fetch failed, falling back to offline page', error);
            
            // For HTML requests, try to serve offline.html
            if (request.headers.get('Accept').includes('text/html')) {
              return caches.match('./offline.html')
                .then(offlineResponse => {
                  if (offlineResponse) {
                    return offlineResponse;
                  }
                  // If offline.html is not in cache, try index.html as fallback
                  return caches.match('./index.html');
                });
            }
            
            // For other requests just throw the error
            throw error;
          });
      })
    );
  }
});