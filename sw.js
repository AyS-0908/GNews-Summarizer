/* A very small service-worker that handles the /share POST,
   directly calls an AI API, then shows the AI's summary. */

// Replace with your actual API key and endpoint
const AI_API_ENDPOINT = 'YOUR_AI_API_ENDPOINT';
const AI_API_KEY = 'YOUR_API_KEY';

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

  // Call AI API directly
  // Example for various APIs - uncomment the one you're using:
  
  // === For OpenAI/Azure OpenAI ===
  /*
  const aiResponse = await fetch(AI_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4', // or gpt-3.5-turbo
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
  const summaryText = data.choices[0].message.content;
  */

  // === For Anthropic Claude API ===
  /*
  const aiResponse = await fetch(AI_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AI_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-opus-20240229', // or claude-3-sonnet-20240229
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
  const summaryText = data.content[0].text;
  */

  // === For DeepSeek API ===
  /*
  const aiResponse = await fetch(AI_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_API_KEY}`
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
  const summaryText = data.choices[0].message.content;
  */

  // Default fallback for testing
  const summaryText = `Article URL received: ${sharedURL}\n\nTo make this work:\n1. Choose an AI API above\n2. Replace API_ENDPOINT and API_KEY\n3. Uncomment the chosen API code block`;

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
