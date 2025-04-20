/* A very small service-worker that handles the /share POST,
   forwards the URL to n8n, then shows the AI's summary. */

const N8N_ENDPOINT = 'https://YOUR-N8N-HOST/webhook/summarise';

/* 1) Standard install / activate (boilerplate) */
self.addEventListener('install',  evt => self.skipWaiting());
self.addEventListener('activate', evt => self.clients.claim());

/* 2) Intercept fetches */
self.addEventListener('fetch', event => {
  const {request} = event;
  // Only catch our share_target POST
  if (request.method === 'POST' && new URL(request.url).pathname === '/share') {
    event.respondWith(handleShare(request));
  }
});

async function handleShare(request) {
  // Extract the URL provided by Android
  const formData     = await request.formData();
  const sharedURL    = formData.get('url');

  // Forward to n8n
  const aiResponse = await fetch(N8N_ENDPOINT, {
    method : 'POST',
    headers: {'Content-Type':'application/json'},
    body   : JSON.stringify({ urls:[sharedURL] })
  });
  const summaryText = await aiResponse.text(); // n8n returns plain text

  // Simple HTML response shown to the user
  return new Response(`
     <!doctype html><html><head><meta charset="utf-8">
     <title>AI Summary</title><style>
        body{font-family:sans-serif;padding:2rem;line-height:1.4}
        pre{white-space:pre-wrap}
     </style></head><body>
     <h2>✅  Summary ready</h2>
     <pre>${summaryText}</pre>
     <a href="javascript:history.back()">← Back</a>
     </body></html>`,
     { headers:{'Content-Type':'text/html'} });
}