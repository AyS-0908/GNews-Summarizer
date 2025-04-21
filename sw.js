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
    
    // Notify client that processing has started
    if (event.source) {
      event.source.postMessage({
        action: 'batchProcessingStarted',
        totalArticles: articles.length
      });
    }
    
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

/**
 * Security utility functions for API key decryption
 */

/**
 * Generates a unique device signature using device and browser information
 * @returns {string} A unique string for the current device
 */
function generateDeviceSignature() {
  const domain = self.location.hostname || 'ays-0908.github.io';
  const browserInfo = self.navigator.userAgent;
  // Services workers don't have access to window.screen, so we adapt
  const timeZone = 'UTC'; // Default timezone for service worker context
  
  // Create a simplified device signature for the service worker
  return `${domain}-${browserInfo}-${timeZone}`;
}

/**
 * Creates a hash from a string
 * @param {string} str - String to hash
 * @returns {string} - Hashed value
 */
function stringToHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(16); // Convert to hex string
}

/**
 * Decrypts a previously encrypted string
 * @param {string} encryptedText - Base64 encoded encrypted string
 * @param {string} key - Decryption key
 * @returns {string} - Original string
 */
function decryptString(encryptedText, key) {
  if (!encryptedText) return '';
  try {
    const encryptedBytes = atob(encryptedText);
    let result = '';
    for (let i = 0; i < encryptedBytes.length; i++) {
      const charCode = encryptedBytes.charCodeAt(i) ^ key.charCodeAt(i % key.length);
      result += String.fromCharCode(charCode);
    }
    return result;
  } catch (e) {
    console.error('Decryption failed:', e);
    return '';
  }
}

/**
 * Decrypts an API key from an encrypted configuration
 * @param {Object} config - Configuration object with encryptedKey
 * @returns {Object} - Configuration with decrypted API key
 */
function decryptApiKey(config) {
  // If config already has a plaintext API key, return as is (legacy support)
  if (config.apiKey && !config.encryptedKey) {
    return config;
  }
  
  // If encrypted key is present, decrypt it
  if (config.encryptedKey) {
    const deviceSignature = generateDeviceSignature();
    const deviceKey = stringToHash(deviceSignature);
    const decryptedKey = decryptString(config.encryptedKey, deviceKey);
    
    // Create a new config object with the decrypted key
    return {
      ...config,
      apiKey: decryptedKey
    };
  }
  
  // Return the config unmodified if no encryption is present
  return config;
}

/**
 * Fetches the AI provider configuration from the client
 * @returns {Promise<Object|null>} Configuration object or null if not found/timeout
 */
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
    
    // Decrypt API key if configuration was received
    if (config) {
      config = decryptApiKey(config);
    }
  }
  
  return config;
}

/**
 * Checks if queue mode is enabled
 * @returns {Promise<boolean>} True if queue mode is enabled
 */
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

/**
 * Adds a URL to the processing queue
 * @param {string} url - The URL to add to the queue
 */
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

/**
 * Error types for better error classification
 */
const ErrorType = {
  NETWORK: 'NETWORK',
  API_KEY: 'API_KEY',
  RATE_LIMIT: 'RATE_LIMIT',
  INVALID_URL: 'INVALID_URL',
  TIMEOUT: 'TIMEOUT',
  SERVER: 'SERVER',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Custom error class with error type classification
 */
class SummarizerError extends Error {
  constructor(message, type = ErrorType.UNKNOWN, originalError = null) {
    super(message);
    this.name = 'SummarizerError';
    this.type = type;
    this.originalError = originalError;
  }
}

/**
 * Gets a user-friendly error message based on error type
 * @param {SummarizerError} error - The error object
 * @returns {string} User-friendly error message
 */
function getUserFriendlyErrorMessage(error) {
  switch (error.type) {
    case ErrorType.NETWORK:
      return 'Network connection error. Please check your internet connection and try again.';
    case ErrorType.API_KEY:
      return 'Invalid API key. Please update your API key in the configuration.';
    case ErrorType.RATE_LIMIT:
      return 'API rate limit exceeded. Please try again later.';
    case ErrorType.INVALID_URL:
      return 'Invalid article URL. Please make sure you\'re sharing a valid news article.';
    case ErrorType.TIMEOUT:
      return 'Request timed out. The AI service might be experiencing high load. Please try again later.';
    case ErrorType.SERVER:
      return 'The AI service is experiencing issues. Please try again later.';
    default:
      return `Unexpected error: ${error.message}`;
  }
}

/**
 * Classifies error based on response and error details
 * @param {Error} error - Original error
 * @param {Response|null} response - Fetch response if available
 * @returns {SummarizerError} Classified error
 */
function classifyError(error, response = null) {
  // Network errors (no response)
  if (!response) {
    if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
      return new SummarizerError('Network connection error', ErrorType.NETWORK, error);
    }
    if (error.message.includes('timeout') || error.message.includes('Timed out')) {
      return new SummarizerError('Request timed out', ErrorType.TIMEOUT, error);
    }
    return new SummarizerError(error.message, ErrorType.UNKNOWN, error);
  }
  
  // HTTP status based errors
  switch (response.status) {
    case 401:
    case 403:
      return new SummarizerError('Invalid API key', ErrorType.API_KEY, error);
    case 429:
      return new SummarizerError('Rate limit exceeded', ErrorType.RATE_LIMIT, error);
    case 400:
      return new SummarizerError('Invalid request format', ErrorType.INVALID_URL, error);
    case 500:
    case 502:
    case 503:
    case 504:
      return new SummarizerError('Server error', ErrorType.SERVER, error);
    default:
      return new SummarizerError(`Error (${response.status})`, ErrorType.UNKNOWN, error);
  }
}

/**
 * Fetches with retry logic for transient errors
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} retries - Number of retries (default: 2)
 * @param {number} retryDelay - Delay between retries in ms (default: 1000)
 * @returns {Promise<Response>} Fetch response
 */
async function fetchWithRetry(url, options, retries = 2, retryDelay = 1000) {
  try {
    const response = await fetch(url, options);
    
    // Success, or non-retriable error
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || retries === 0) {
      return response;
    }
    
    // Prepare for retry with exponential backoff
    const delay = retryDelay * (1 + Math.random());
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Retry
    return fetchWithRetry(url, options, retries - 1, retryDelay * 2);
  } catch (error) {
    // Don't retry network errors on last attempt
    if (retries === 0) {
      throw error;
    }
    
    // Retry network errors
    const delay = retryDelay * (1 + Math.random());
    await new Promise(resolve => setTimeout(resolve, delay));
    return fetchWithRetry(url, options, retries - 1, retryDelay * 2);
  }
}

/**
 * Validates a URL
 * @param {string} url - URL to validate
 * @returns {boolean} True if URL is valid
 */
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Gets an article summary from the configured AI provider
 * @param {string} url - Article URL to summarize
 * @param {Object} config - AI provider configuration
 * @returns {Promise<string>} Summary text
 * @throws {SummarizerError} If summarization fails
 */
async function getSummary(url, config) {
  // URL validation
  if (!url || !isValidUrl(url)) {
    throw new SummarizerError('Invalid article URL', ErrorType.INVALID_URL);
  }
  
  // Validate API key
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new SummarizerError('API key is missing or invalid', ErrorType.API_KEY);
  }
  
  let summaryText = '';
  let aiResponse = null;
  
  try {
    // Format the AI prompt based on article URL
    const promptText = `Please provide a concise summary of this news article: ${url}. Focus on the key facts, main points, and important context.`;
    
    // Call the appropriate AI provider
    if (config.provider === 'openai') {
      aiResponse = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
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
              content: promptText
            }
          ],
          max_tokens: 500
        })
      });
      
      // Handle HTTP errors
      if (!aiResponse.ok) {
        const errorText = await aiResponse.text().catch(() => 'Unknown error');
        throw new Error(errorText);
      }
      
      const data = await aiResponse.json();
      
      // Validate response structure
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('Invalid API response format');
      }
      
      summaryText = data.choices[0].message.content;
    }
    else if (config.provider === 'anthropic') {
      aiResponse = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
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
              content: promptText
            }
          ]
        })
      });
      
      // Handle HTTP errors
      if (!aiResponse.ok) {
        const errorText = await aiResponse.text().catch(() => 'Unknown error');
        throw new Error(errorText);
      }
      
      const data = await aiResponse.json();
      
      // Validate response structure
      if (!data.content || !data.content[0] || !data.content[0].text) {
        throw new Error('Invalid API response format');
      }
      
      summaryText = data.content[0].text;
    }
    else if (config.provider === 'deepseek') {
      aiResponse = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
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
              content: promptText
            }
          ],
          max_tokens: 500
        })
      });
      
      // Handle HTTP errors
      if (!aiResponse.ok) {
        const errorText = await aiResponse.text().catch(() => 'Unknown error');
        throw new Error(errorText);
      }
      
      const data = await aiResponse.json();
      
      // Validate response structure
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('Invalid API response format');
      }
      
      summaryText = data.choices[0].message.content;
    }
    else {
      throw new SummarizerError(`Unsupported AI provider: ${config.provider}`, ErrorType.UNKNOWN);
    }
    
    // Validate summary
    if (!summaryText || summaryText.trim() === '') {
      throw new SummarizerError('Empty summary returned', ErrorType.UNKNOWN);
    }
    
    return summaryText;
  } catch (error) {
    // Classify and rethrow the error
    throw classifyError(error, aiResponse);
  }
}

/**
 * Process a batch of articles
 * @param {Array} articles - Array of article objects
 * @returns {Promise<Array>} Results array
 */
async function processBatchArticles(articles) {
  const config = await getConfig();
  if (!config) return [];
  
  const results = [];
  let currentArticle = 0;
  const clients = await self.clients.matchAll();
  
  for (const article of articles) {
    try {
      // Update progress
      currentArticle++;
      if (clients.length > 0) {
        clients[0].postMessage({
          action: 'batchProgress',
          current: currentArticle,
          total: articles.length,
          url: article.url
        });
      }
      
      const summary = await getSummary(article.url, config);
      results.push({
        url: article.url,
        summary: summary,
        success: true
      });
    } catch (error) {
      // Use friendly error messages
      const errorMessage = error instanceof SummarizerError 
        ? getUserFriendlyErrorMessage(error)
        : `Error: ${error.message}`;
        
      results.push({
        url: article.url,
        summary: errorMessage,
        success: false,
        errorType: error instanceof SummarizerError ? error.type : ErrorType.UNKNOWN
      });
    }
  }
  
  return results;
}

/**
 * Handle article share request
 * @param {Request} request - The share request
 * @returns {Promise<Response>} HTML response
 */
async function handleShare(request) {
  // Extract the URL provided by Android
  let sharedURL = '';
  
  try {
    const formData = await request.formData();
    sharedURL = formData.get('url');
    
    // Validate URL format
    if (!sharedURL || !isValidUrl(sharedURL)) {
      throw new SummarizerError(
        'Invalid article URL. Please make sure you\'re sharing a valid web article.',
        ErrorType.INVALID_URL
      );
    }
  } catch (error) {
    if (error instanceof SummarizerError) {
      return createErrorResponse(error);
    }
    
    return createErrorResponse(
      new SummarizerError('Could not process the shared content.', ErrorType.UNKNOWN, error)
    );
  }

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

  // Standard single summarization flow with loading indicator
  try {
    // Return loading state first
    return new Response(`
       <!doctype html><html><head><meta charset="utf-8">
       <title>Generating Summary...</title><style>
          body{font-family:sans-serif;padding:2rem;line-height:1.4;text-align:center}
          pre{white-space:pre-wrap}
          .spinner{width:40px;height:40px;margin:20px auto;border:4px solid rgba(0,0,0,.1);border-radius:50%;border-top-color:#4F46E5;animation:spin 1s ease-in-out infinite}
          @keyframes spin{to{transform:rotate(360deg)}}
          .message{margin-top:20px;color:#6b7280}
       </style>
       <script>
         // Auto-refresh to check summary status
         async function checkSummary() {
           const url = '${sharedURL}';
           try {
             const response = await fetch('./summary-status?url=' + encodeURIComponent(url));
             if (response.ok) {
               window.location.reload();
             } else {
               setTimeout(checkSummary, 2000);
             }
           } catch (e) {
             setTimeout(checkSummary, 2000);
           }
         }
         // Start polling after page loads
         setTimeout(() => {
           const summaryText = document.getElementById('summaryText');
           if (!summaryText) {
             fetch('./api/summarize?url=${encodeURIComponent(sharedURL)}')
               .then(response => window.location.reload())
               .catch(err => setTimeout(() => window.location.reload(), 3000));
           }
         }, 3000);
       </script>
       </head><body>
       <h2>Generating Summary...</h2>
       <div class="spinner"></div>
       <p class="message">Analyzing article using AI, please wait...</p>
       </body></html>`,
       { headers:{'Content-Type':'text/html'} });

    const summaryText = await getSummary(sharedURL, config);

    // Simple HTML response shown to the user
    return new Response(`
       <!doctype html><html><head><meta charset="utf-8">
       <title>AI Summary</title><style>
          body{font-family:sans-serif;padding:2rem;line-height:1.4}
          pre{white-space:pre-wrap}
       </style></head><body>
       <h2>✅ Summary ready</h2>
       <pre id="summaryText">${summaryText}</pre>
       <a href="javascript:history.back()">← Back</a>
       </body></html>`,
       { headers:{'Content-Type':'text/html'} });
  } catch (error) {
    return createErrorResponse(error);
  }
}

/**
 * Creates an error response
 * @param {Error} error - Error object
 * @returns {Response} HTML error response
 */
function createErrorResponse(error) {
  // Get user-friendly error message
  const errorMessage = error instanceof SummarizerError 
    ? getUserFriendlyErrorMessage(error)
    : `Error: ${error.message}`;
  
  // Create helpful error page
  return new Response(`
    <!doctype html><html><head><meta charset="utf-8">
    <title>Error</title><style>
       body{font-family:sans-serif;padding:2rem;line-height:1.4}
       .error-container{background:#fef2f2;border-left:4px solid #ef4444;padding:1rem;border-radius:4px}
       .error-title{color:#991b1b;margin-top:0}
       .error-message{color:#1f2937}
       .error-help{margin-top:1.5rem;color:#4b5563}
       .error-help ul{padding-left:1.5rem}
       .error-help li{margin-bottom:0.5rem}
       .back-link{display:inline-block;margin-top:1.5rem;color:#4F46E5;text-decoration:none}
       .back-link:hover{text-decoration:underline}
    </style></head><body>
    <h2>❌ Error occurred</h2>
    
    <div class="error-container">
      <h3 class="error-title">Failed to generate summary</h3>
      <p class="error-message">${errorMessage}</p>
    </div>
    
    <div class="error-help">
      <h3>Troubleshooting tips:</h3>
      <ul>
        <li>Make sure your internet connection is working</li>
        <li>Verify that your API key is valid and correctly configured</li>
        <li>Check that the shared URL is from a valid news article</li>
        <li>Try again later if the AI service might be experiencing high load</li>
      </ul>
    </div>
    
    <a class="back-link" href="javascript:history.back()">← Back</a>
    </body></html>`,
    { headers:{'Content-Type':'text/html'} });
}