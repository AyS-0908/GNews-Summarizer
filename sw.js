/* A service-worker that handles the /share POST,
   directly calls an AI API, then shows the AI's summary. */

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
  const formData = await request.formData();
  const sharedURL = formData.get('url');

  // Get configuration from localStorage through a client
  const clients = await self.clients.matchAll();
  let config = null;
  
  if (clients.length > 0) {
    const response = await clients[0].postMessage({ action: 'getConfig' });
    config = await new Promise(resolve => {
      self.addEventListener('message', function handler(event) {
        if (event.data.action === 'config') {
          self.removeEventListener('message', handler);
          resolve(event.data.config);
        }
      });
    });
  }

  if (!config) {
    return new Response(`
       <!doctype html><html><head><meta charset="utf-8">
       <title>Error - No Configuration</title><style>
          body{font-family:sans-serif;padding:2rem;line-height:1.4}
          a{color:#4F46E5;text-decoration:none}
          a:hover{text-decoration:underline}
       </style></head><body>
       <h2>⚠️ No AI Provider Configured</h2>
       <p>Please <a href="/landing.html">configure your AI provider</a> first.</p>
       </body></html>`,
       { headers:{'Content-Type':'text/html'} });
  }

  try {
    let summaryText = '';
    
    if (config.provider === 'openai') {
      const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: 'user',
              content: `Please summarize this article: ${sharedURL}`
            }
          ],
          max_tokens: 500
        })
      });
      const data = await aiResponse.json();
      summaryText = data.choices[0].message.content;
    }
    else if (config.provider === 'anthropic') {
      const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 500,
          messages: [
            {
              role: 'user',
              content: `Please summarize this article: ${sharedURL}`
            }
          ]
        })
      });
      const data = await aiResponse.json();
      summaryText = data.content[0].text;
    }
    else if (config.provider === 'deepseek') {
      const aiResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'user',
              content: `Please summarize this article: ${sharedURL}`
            }
          ],
          max_tokens: 500
        })
      });
      const data = await aiResponse.json();
      summaryText = data.choices[0].message.content;
    }

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
  } catch (error) {
    return new Response(`
       <!doctype html><html><head><meta charset="utf-8">
       <title>Error</title><style>
          body{font-family:sans-serif;padding:2rem;line-height:1.4}
          pre{white-space:pre-wrap;background:#f1f1f1;padding:1rem}
       </style></head><body>
       <h2>❌ Error</h2>
       <p>Failed to generate summary. Error details:</p>
       <pre>${error.message}</pre>
       <a href="javascript:history.back()">← Back</a>
       </body></html>`,
       { headers:{'Content-Type':'text/html'} });
  }
}
