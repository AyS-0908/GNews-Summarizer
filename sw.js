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

/* 3) Handle messages from the main app */
self.addEventListener('message', async event => {
  if (event.data.action === 'summarizeQueue') {
    // Handle batch summarization request
    const articles = event.data.articles;
    const results = await processBatchArticles(articles);
    
    // Send results back to the client
    if (event.source) {
      event.source.postMessage({
        action: 'batchSummaryComplete',
        results: results
      });
    }
  }
});

async function getConfig() {
  const clients = await self.clients.matchAll();
  let config = null;
  
  if (clients.length > 0) {
    await clients[0].postMessage({ action: 'getConfig' });
    config = await new Promise(resolve => {
      self.addEventListener('message', function handler(event) {
        if (event.data.action === 'config') {
          self.removeEventListener('message', handler);
          resolve(event.data.config);
        }
      });
      // Timeout after 2 seconds
      setTimeout(() => resolve(null), 2000);
    });
  }
  
  return config;
}

async function getQueueMode() {
  const clients = await self.clients.matchAll();
  let queueMode = false;
  
  if (clients.length > 0) {
    await clients[0].postMessage({ action: 'getQueueMode' });
    queueMode = await new Promise(resolve => {
      self.addEventListener('message', function handler(event) {
        if (event.data.action === 'queueMode') {
          self.removeEventListener('message', handler);
          resolve(event.data.queueMode);
        }
      });
      // Timeout after 2 seconds and default to false
      setTimeout(() => resolve(false), 2000);
    });
  }
  
  return queueMode;
}

async function addToQueue(url) {
  const clients = await self.clients.matchAll();
  
  if (clients.length > 0) {
    // Notify client to add article to queue
    // The client will handle the actual localStorage update
    await clients[0].postMessage({
      action: 'addToQueue',
      url: url,
      timestamp: new Date().toISOString()
    });
  }
}

async function getSummary(url, config) {
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
            content: `Please summarize this article: ${url}`
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
            content: `Please summarize this article: ${url}`
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
            content: `Please summarize this article: ${url}`
          }
        ],
        max_tokens: 500
      })
    });
    const data = await aiResponse.json();
    summaryText = data.choices[0].message.content;
  }
  
  return summaryText;
}

async function processBatchArticles(articles) {
  const config = await getConfig();
  if (!config) return [];
  
  const results = [];
  
  for (const article of articles) {
    try {
      const summary = await getSummary(article.url, config);
      results.push({
        url: article.url,
        summary: summary,
        success: true
      });
    } catch (error) {
      results.push({
        url: article.url,
        summary: `Error: ${error.message}`,
        success: false
      });
    }
  }
  
  return results;
}

async function handleShare(request) {
  // Extract the URL provided by Android
  const formData = await request.formData();
  const sharedURL = formData.get('url');

  // Get configuration and queue mode
  const config = await getConfig();
  const queueMode = await getQueueMode();

  if (!config) {
    return new Response(`
       <!doctype html><html><head><meta charset="utf-8">
       <title>Error - No Configuration</title><style>
          body{font-family:sans-serif;padding:2rem;line-height:1.4}
          a{color:#4F46E5;text-decoration:none}
          a:hover{text-decoration:underline}
       </style></head><body>
       <h2>⚠️ No AI Provider Configured</h2>
       <p>Please <a href="./landing.html">configure your AI provider</a> first.</p>
       </body></html>`,
       { headers:{'Content-Type':'text/html'} });
  }

  // If queue mode is enabled, add to queue instead of processing immediately
  if (queueMode) {
    await addToQueue(sharedURL);
    
    // Return a simple confirmation page
    return new Response(`
       <!doctype html><html><head><meta charset="utf-8">
       <title>Added to Queue</title><style>
          body{font-family:sans-serif;padding:2rem;line-height:1.4}
          pre{white-space:pre-wrap}
          a{color:#4F46E5;text-decoration:none}
          a:hover{text-decoration:underline}
       </style></head><body>
       <h2>✅ Article Added to Queue</h2>
       <p>The article has been added to your summarization queue.</p>
       <p>URL: ${sharedURL}</p>
       <p><a href="./">View Queue</a> | <a href="javascript:window.close()">Close</a></p>
       </body></html>`,
       { headers:{'Content-Type':'text/html'} });
  }

  // Standard single summarization flow
  try {
    const summaryText = await getSummary(sharedURL, config);

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
