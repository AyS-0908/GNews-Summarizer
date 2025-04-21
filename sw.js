/* A service-worker that handles the /share POST,
   directly calls an AI API, then shows the AI's summary. */

/* Cache configuration */
const CACHE_VERSION = 'v1';
const SUMMARY_CACHE = `summary-cache-${CACHE_VERSION}`;
const STATIC_CACHE = `static-cache-${CACHE_VERSION}`;
// Default cache expiration time (24 hours)
const CACHE_EXPIRATION = 24 * 60 * 60 * 1000;

/* Rate limiting configuration */
const RATE_LIMITS = {
  // Maximum number of API calls per provider in the time window
  openai: {
    maxRequests: 10,       // 10 requests per window
    windowMs: 60 * 1000,   // 1 minute window
  },
  anthropic: {
    maxRequests: 15,       // 15 requests per window
    windowMs: 60 * 1000,   // 1 minute window
  },
  deepseek: {
    maxRequests: 20,       // 20 requests per window
    windowMs: 60 * 1000,   // 1 minute window
  },
  // Default limit for any provider not explicitly listed
  default: {
    maxRequests: 10,
    windowMs: 60 * 1000,
  }
};

// Storage for rate limiting
let apiCallHistory = {};
let lastCleanup = Date.now();

/* 1) Standard install / activate with cache management */
self.addEventListener('install', evt => {
  evt.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then(cache => {
        // Cache static assets
        return cache.addAll([
          './',
          './index.html',
          './landing.html',
          './settings.html',
          './manifest.json',
          './icon.svg',
          './icon.png'
        ]);
      }),
      self.skipWaiting()
    ])
  );
});

self.addEventListener('activate', evt => {
  // Clean up old cache versions
  evt.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // Delete old caches that don't match current version
          if (
            cacheName.startsWith('summary-cache-') && cacheName !== SUMMARY_CACHE ||
            cacheName.startsWith('static-cache-') && cacheName !== STATIC_CACHE
          ) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

/* 2) Intercept fetches */
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
        return fetch(request).then(response => {
          // Cache successful responses for static assets
          if (response.ok && request.url.match(/\.(html|css|js|json|svg|png|jpg|jpeg|gif|webp)$/)) {
            const responseClone = response.clone();
            caches.open(STATIC_CACHE).then(cache => {
              cache.put(request, responseClone);
            });
          }
          return response;
        });
      })
    );
  }
});

/* 3) Handle messages from the main app */
self.addEventListener('message', async event => {
  const messageAction = event.data.action;
  
  if (messageAction === 'summarizeQueue') {
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
  } else if (messageAction === 'clearCache') {
    // Clear summary cache when requested
    clearSummaryCache().then(result => {
      if (event.source) {
        event.source.postMessage({
          action: 'cacheClearedResult',
          success: result
        });
      }
    });
  } else if (messageAction === 'getRateLimitStatus') {
    // Return current rate limit status for each provider
    const status = getRateLimitStatus();
    if (event.source) {
      event.source.postMessage({
        action: 'rateLimitStatus',
        status: status
      });
    }
  } else if (messageAction === 'ping') {
    // Respond to ping check from main app
    if (event.source && event.ports && event.ports[0]) {
      event.ports[0].postMessage({
        action: 'pong',
        timestamp: Date.now()
      });
    }
  }
});

/**
 * Cache management functions
 */

/**
 * Generates a cache key for an article URL
 * @param {string} url - Article URL
 * @returns {string} Cache key
 */
function generateCacheKey(url) {
  // Use a simple hash function for the URL
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return `summary-${hash}`;
}

/**
 * Stores a summary in the cache with timestamp
 * @param {string} url - Article URL
 * @param {string} summary - Summary text
 * @returns {Promise<boolean>} Success status
 */
async function cacheSummary(url, summary) {
  try {
    const cache = await caches.open(SUMMARY_CACHE);
    const cacheKey = generateCacheKey(url);
    
    // Create a response object with the summary and metadata
    const data = {
      summary: summary,
      url: url,
      timestamp: Date.now(),
      version: CACHE_VERSION
    };
    
    const response = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'X-Cache-Date': new Date().toISOString()
      }
    });
    
    await cache.put(cacheKey, response);
    return true;
  } catch (error) {
    console.error('Cache storage failed:', error);
    return false;
  }
}

/**
 * Retrieves a summary from cache if available and not expired
 * @param {string} url - Article URL
 * @param {number} maxAge - Maximum age in milliseconds (default: CACHE_EXPIRATION)
 * @returns {Promise<string|null>} Summary text or null if not found/expired
 */
async function getCachedSummary(url, maxAge = CACHE_EXPIRATION) {
  try {
    const cache = await caches.open(SUMMARY_CACHE);
    const cacheKey = generateCacheKey(url);
    const cached = await cache.match(cacheKey);
    
    if (!cached) return null;
    
    const data = await cached.json();
    
    // Check if cache is expired
    const now = Date.now();
    if (now - data.timestamp > maxAge) {
      // Cache expired, delete it
      await cache.delete(cacheKey);
      return null;
    }
    
    return data.summary;
  } catch (error) {
    console.error('Cache retrieval failed:', error);
    return null;
  }
}

/**
 * Checks if a summary exists in cache and is valid
 * @param {string} url - Article URL
 * @returns {Promise<Response>} Response indicating if summary is ready
 */
async function checkSummaryStatus(url) {
  const summary = await getCachedSummary(url);
  
  if (summary) {
    return new Response(JSON.stringify({ ready: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({ ready: false }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Handles API summarize requests, using cache when available
 * @param {string} url - Article URL
 * @returns {Promise<Response>} JSON response with summary
 */
async function handleApiSummarize(url) {
  try {
    // Try to get from cache first
    const cachedSummary = await getCachedSummary(url);
    
    if (cachedSummary) {
      return new Response(JSON.stringify({ 
        summary: cachedSummary, 
        cached: true 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Not in cache, generate summary
    const config = await getConfig();
    if (!config) {
      return new Response(JSON.stringify({ 
        error: 'No AI provider configured' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check rate limits before making API call
    const rateLimitCheck = checkRateLimit(config.provider);
    if (!rateLimitCheck.allowed) {
      return new Response(JSON.stringify({ 
        error: `Rate limit exceeded. Please try again after ${rateLimitCheck.retryAfterSeconds} seconds.`,
        errorType: ErrorType.RATE_LIMIT,
        retryAfter: rateLimitCheck.retryAfterSeconds
      }), {
        status: 429,
        headers: { 
          'Content-Type': 'application/json',
          'Retry-After': String(rateLimitCheck.retryAfterSeconds)
        }
      });
    }
    
    const summary = await getSummary(url, config);
    
    // Cache the result
    await cacheSummary(url, summary);
    
    return new Response(JSON.stringify({ 
      summary: summary, 
      cached: false 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const errorMessage = error instanceof SummarizerError 
      ? getUserFriendlyErrorMessage(error)
      : `Error: ${error.message}`;
      
    return new Response(JSON.stringify({ 
      error: errorMessage,
      errorType: error instanceof SummarizerError ? error.type : ErrorType.UNKNOWN
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Clears the summary cache
 * @returns {Promise<boolean>} Success status
 */
async function clearSummaryCache() {
  try {
    await caches.delete(SUMMARY_CACHE);
    // Re-create the cache
    await caches.open(SUMMARY_CACHE);
    return true;
  } catch (error) {
    console.error('Failed to clear cache:', error);
    return false;
  }
}

/**
 * Rate limiting functions
 */

/**
 * Record an API call for rate limiting
 * @param {string} provider - AI provider name
 */
function recordApiCall(provider) {
  const now = Date.now();
  
  // Create provider entry if it doesn't exist
  if (!apiCallHistory[provider]) {
    apiCallHistory[provider] = [];
  }
  
  // Add this call to history
  apiCallHistory[provider].push(now);
  
  // Clean up old entries periodically (every minute)
  if (now - lastCleanup > 60000) {
    cleanupApiCallHistory();
    lastCleanup = now;
  }
}

/**
 * Clean up expired API call history entries
 */
function cleanupApiCallHistory() {
  const now = Date.now();
  
  Object.keys(apiCallHistory).forEach(provider => {
    const limit = RATE_LIMITS[provider] || RATE_LIMITS.default;
    // Keep only calls within the current window
    apiCallHistory[provider] = apiCallHistory[provider].filter(
      timestamp => now - timestamp < limit.windowMs
    );
    
    // If array is empty, delete the provider entry
    if (apiCallHistory[provider].length === 0) {
      delete apiCallHistory[provider];
    }
  });
}

/**
 * Check if an API call is allowed under rate limits
 * @param {string} provider - AI provider name
 * @returns {Object} Result with allowed status and retry info
 */
function checkRateLimit(provider) {
  const now = Date.now();
  const limit = RATE_LIMITS[provider] || RATE_LIMITS.default;
  
  // Clean up expired calls
  if (!apiCallHistory[provider]) {
    apiCallHistory[provider] = [];
  } else {
    apiCallHistory[provider] = apiCallHistory[provider].filter(
      timestamp => now - timestamp < limit.windowMs
    );
  }
  
  // Check if we're over the limit
  if (apiCallHistory[provider].length >= limit.maxRequests) {
    // Calculate time until oldest call expires
    const oldestCall = Math.min(...apiCallHistory[provider]);
    const resetTime = oldestCall + limit.windowMs;
    const waitMs = resetTime - now;
    
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(waitMs / 1000) || 1
    };
  }
  
  // If we get here, the call is allowed
  return { allowed: true };
}

/**
 * Get the current rate limit status for all providers
 * @returns {Object} Status object with usage info for each provider
 */
function getRateLimitStatus() {
  const now = Date.now();
  const status = {};
  
  // Ensure we have clean data
  cleanupApiCallHistory();
  
  // Generate status for each provider
  Object.keys(RATE_LIMITS).forEach(provider => {
    if (provider === 'default') return;
    
    const limit = RATE_LIMITS[provider];
    const calls = apiCallHistory[provider] || [];
    
    status[provider] = {
      used: calls.length,
      limit: limit.maxRequests,
      remaining: limit.maxRequests - calls.length,
      resetInSeconds: calls.length > 0 
        ? Math.ceil((Math.min(...calls) + limit.windowMs - now) / 1000)
        : 0,
      windowSeconds: limit.windowMs / 1000
    };
  });
  
  return status;
}

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
 * Try to decrypt an API key using recovery PIN if device decryption fails
 * @param {Object} config - Configuration with recovery info
 * @param {string} pin - Recovery PIN to try
 * @returns {string|null} - Decrypted API key or null if recovery fails
 */
function tryRecoveryDecryption(config, pin) {
  if (!config || !config.recovery || !config.recovery.enabled || !pin) {
    return null;
  }
  
  try {
    // Decrypt API key using recovery PIN
    const decryptedKey = decryptString(config.recovery.encryptedKey, pin);
    
    // Verify the PIN is correct by checking the validation hash
    // This helps prevent brute force attempts and validates the PIN worked correctly
    if (decryptedKey) {
      const validationHash = createValidationHash(decryptedKey, pin);
      if (validationHash === config.recovery.validationHash) {
        return decryptedKey;
      }
    }
  } catch (error) {
    console.error('Recovery decryption failed:', error);
  }
  
  return null;
}

/**
 * Creates a validation hash for recovery verification
 * Same implementation as in landing.html
 * @param {string} apiKey - The API key 
 * @param {string} pin - Recovery PIN
 * @returns {string} - Validation hash
 */
function createValidationHash(apiKey, pin) {
  // Create a hash that can verify the PIN is correct for this API key
  // but doesn't expose the API key itself
  const combined = apiKey.substring(0, 4) + pin + apiKey.substring(apiKey.length - 4);
  return stringToHash(combined);
}

/**
 * Decrypts an API key from an encrypted configuration
 * @param {Object} config - Configuration object with encryptedKey
 * @param {string|null} recoveryPin - Optional recovery PIN if device decryption fails
 * @returns {Object} - Configuration with decrypted API key
 */
function decryptApiKey(config, recoveryPin = null) {
  // If config already has a plaintext API key, return as is (legacy support)
  if (config.apiKey && !config.encryptedKey) {
    return config;
  }
  
  // If encrypted key is present, decrypt it with device signature
  if (config.encryptedKey) {
    const deviceSignature = generateDeviceSignature();
    const deviceKey = stringToHash(deviceSignature);
    let decryptedKey = decryptString(config.encryptedKey, deviceKey);
    
    // If device decryption failed and recovery PIN is provided, try recovery
    if ((!decryptedKey || decryptedKey.length < 10) && recoveryPin && 
        config.recovery && config.recovery.enabled) {
      decryptedKey = tryRecoveryDecryption(config, recoveryPin);
    }
    
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
      let handled = false;
      
      function handler(event) {
        if (event.data.action === 'config' && !handled) {
          handled = true;
          self.removeEventListener('message', handler);
          resolve(event.data.config);
        }
      }
      
      self.addEventListener('message', handler);
      
      // Timeout after 2 seconds
      setTimeout(() => {
        if (!handled) {
          handled = true;
          self.removeEventListener('message', handler);
          resolve(null);
        }
      }, 2000);
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
      let handled = false;
      
      function handler(event) {
        if (event.data.action === 'queueMode' && !handled) {
          handled = true;
          self.removeEventListener('message', handler);
          resolve(event.data.queueMode);
        }
      }
      
      self.addEventListener('message', handler);
      
      // Timeout after 2 seconds and default to false
      setTimeout(() => {
        if (!handled) {
          handled = true;
          self.removeEventListener('message', handler);
          resolve(false);
        }
      }, 2000);
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
      return 'API rate limit exceeded. Please try again later or switch to a different AI provider.';
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
    
    // Special handling for rate limit (429) responses
    if (response.status === 429) {
      // Get retry-after header if available
      let retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        // Convert to milliseconds (it's in seconds)
        retryAfter = parseInt(retryAfter, 10) * 1000;
        if (!isNaN(retryAfter) && retryAfter > 0) {
          // Use the server's retry suggestion
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          return fetchWithRetry(url, options, retries - 1, retryDelay);
        }
      }
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
  
  // Check cache first
  const cachedSummary = await getCachedSummary(url);
  if (cachedSummary) {
    return cachedSummary;
  }
  
  // Validate API key
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new SummarizerError('API key is missing or invalid', ErrorType.API_KEY);
  }
  
  // Check rate limit before making the API call
  const rateLimit = checkRateLimit(config.provider);
  if (!rateLimit.allowed) {
    throw new SummarizerError(
      `API rate limit exceeded. Please try again after ${rateLimit.retryAfterSeconds} seconds.`, 
      ErrorType.RATE_LIMIT
    );
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
      
      // Record the API call for rate limiting
      recordApiCall('openai');
      
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
      
      // Record the API call for rate limiting
      recordApiCall('anthropic');
      
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
      
      // Record the API call for rate limiting
      recordApiCall('deepseek');
      
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
    
    // Cache the successful result
    await cacheSummary(url, summaryText);
    
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
      
      // Check cache first, then fallback to API call
      let summary = await getCachedSummary(article.url);
      let fromCache = !!summary;
      
      if (!summary) {
        // Check if we're hitting rate limits before making API call
        const rateLimit = checkRateLimit(config.provider);
        if (!rateLimit.allowed) {
          throw new SummarizerError(
            `API rate limit exceeded. Please try again after ${rateLimit.retryAfterSeconds} seconds.`,
            ErrorType.RATE_LIMIT
          );
        }
        
        summary = await getSummary(article.url, config);
        
        // Add a small delay between API calls to avoid overwhelming the provider
        if (currentArticle < articles.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      results.push({
        url: article.url,
        summary: summary,
        success: true,
        fromCache: fromCache
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
      
      // If rate limited, stop processing and return what we have so far
      if (error instanceof SummarizerError && error.type === ErrorType.RATE_LIMIT) {
        // Tell the client about the remaining articles that weren't processed
        const remainingArticles = articles.slice(currentArticle);
        if (clients.length > 0 && remainingArticles.length > 0) {
          clients[0].postMessage({
            action: 'rateLimitReached',
            remainingArticles: remainingArticles
          });
        }
        break;
      }
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
       <p><a href="./index.html">View Queue</a> | <a href="javascript:window.close()">Close</a></p>
       </body></html>`,
       { headers:{'Content-Type':'text/html'} });
  }

  // Check if a cached summary is available
  const cachedSummary = await getCachedSummary(sharedURL);
  if (cachedSummary) {
    // Return cached summary immediately
    return new Response(`
       <!doctype html><html><head><meta charset="utf-8">
       <title>AI Summary (Cached)</title><style>
          body{font-family:sans-serif;padding:2rem;line-height:1.4}
          pre{white-space:pre-wrap}
          .cache-notice{color:#6b7280;font-size:0.9rem;margin-bottom:1rem}
          .refresh-btn{background:#4F46E5;color:white;border:none;border-radius:4px;padding:0.5rem 1rem;cursor:pointer;margin-top:1rem}
          .refresh-btn:hover{background:#4338ca}
       </style></head><body>
       <h2>✅ Summary ready</h2>
       <div class="cache-notice">This summary was retrieved from cache. <button class="refresh-btn" onclick="location.href='./api/summarize?url=${encodeURIComponent(sharedURL)}&refresh=true'">Generate Fresh Summary</button></div>
       <pre>${cachedSummary}</pre>
       <a href="javascript:history.back()">← Back</a>
       </body></html>`,
       { headers:{'Content-Type':'text/html'} });
  }

  // Check rate limit before processing
  const rateLimit = checkRateLimit(config.provider);
  if (!rateLimit.allowed) {
    return createErrorResponse(
      new SummarizerError(
        `API rate limit exceeded. Please try again after ${rateLimit.retryAfterSeconds} seconds.`,
        ErrorType.RATE_LIMIT
      )
    );
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
  
  // Special handling for rate limit errors
  let retrySection = '';
  if (error instanceof SummarizerError && error.type === ErrorType.RATE_LIMIT) {
    retrySection = `
      <div style="margin-top: 1.5rem; padding: 1rem; background: #eff6ff; border-radius: 4px; color: #1e40af;">
        <h3 style="margin-top: 0; color: #1e3a8a;">Rate Limit Information</h3>
        <p>You've reached the usage limit for your current AI provider. You can:</p>
        <ul>
          <li>Wait a few minutes before trying again</li>
          <li><a href="./landing.html" style="color: #2563eb;">Configure a different AI provider</a></li>
          <li>Add this article to your queue for later processing</li>
        </ul>
        <button onclick="window.location.reload()" style="background: #3b82f6; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; margin-top: 0.5rem; cursor: pointer;">Try Again</button>
      </div>
    `;
  }
  
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
    
    ${retrySection}
    
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