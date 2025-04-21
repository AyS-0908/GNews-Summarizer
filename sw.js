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

/* Progress tracking for single article summarization */
let activeSummarizations = {};

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
  } else if (messageAction === 'getSummaryProgress') {
    // Return progress info for a specific summarization
    const url = event.data.url;
    if (event.source && url) {
      const progress = activeSummarizations[url] || null;
      event.source.postMessage({
        action: 'summaryProgress',
        url: url,
        progress: progress
      });
    }
  } else if (messageAction === 'updateCacheSettings') {
    // Handle cache settings update from the settings page
    if (event.data.settings) {
      try {
        // Store the settings in a local variable for immediate use
        // (future requests will use these settings)
        handleCacheSettingsUpdate(event.data.settings);
        
        // Respond with success
        if (event.source) {
          event.source.postMessage({
            action: 'cacheSettingsUpdated',
            success: true
          });
        }
      } catch (error) {
        console.error('Failed to update cache settings:', error);
        if (event.source) {
          event.source.postMessage({
            action: 'cacheSettingsUpdated',
            success: false,
            error: error.message
          });
        }
      }
    }
  } else if (messageAction === 'retryFailedSummary') {
    // Handle retry requests for failed summaries
    const url = event.data.url;
    if (url) {
      try {
        // Clean up any existing progress tracking
        cleanupProgressTracking(url);
        
        // Setup progress tracking for the retry
        setupProgressTracking(url);
        
        // Get the configuration
        const config = await getConfig();
        if (!config) {
          throw new SummarizerError('No AI provider configured', ErrorType.CONFIG_ERROR);
        }
        
        // Attempt to get summary again
        const summary = await getSummary(url, config);
        
        // Cache the result
        await cacheSummary(url, summary);
        
        // Clean up progress tracking
        cleanupProgressTracking(url);
        
        // Notify the client of success
        if (event.source) {
          event.source.postMessage({
            action: 'retrySuccess',
            url: url,
            summary: summary
          });
        }
      } catch (error) {
        // Clean up progress tracking
        cleanupProgressTracking(url);
        
        // Get detailed error information
        const errorInfo = error instanceof SummarizerError 
          ? getDetailedErrorInfo(error)
          : {
              message: `Error: ${error.message}`,
              type: ErrorType.UNKNOWN,
              severity: ErrorSeverity.CRITICAL,
              troubleshooting: getTroubleshooting(ErrorType.UNKNOWN)
            };
        
        // Notify the client of failure
        if (event.source) {
          event.source.postMessage({
            action: 'retryFailure',
            url: url,
            error: errorInfo
          });
        }
      }
    }
  }
});

/**
 * Cache management functions
 */

/**
 * Get the current cache settings
 * @returns {Object} Cache settings
 */
function getCacheSettings() {
  try {
    // Try to get settings from localStorage (through client)
    const settings = self._cacheSettings; // Use in-memory settings if available
    
    if (settings) {
      return settings;
    }
    
    // Otherwise use defaults
    return {
      cacheDuration: CACHE_EXPIRATION, // Default to 24 hours
      priorityMode: 'recency' // Default to recency-based prioritization
    };
  } catch (error) {
    console.error('Error getting cache settings:', error);
    return {
      cacheDuration: CACHE_EXPIRATION,
      priorityMode: 'recency'
    };
  }
}

/**
 * Handle cache settings update
 * @param {Object} settings - New cache settings
 */
function handleCacheSettingsUpdate(settings) {
  // Validate settings
  if (!settings || typeof settings !== 'object') {
    throw new Error('Invalid cache settings');
  }
  
  // Validate cacheDuration (must be a number)
  if (settings.cacheDuration !== undefined && 
      (typeof settings.cacheDuration !== 'number' || settings.cacheDuration < 0)) {
    throw new Error('Invalid cache duration');
  }
  
  // Validate priorityMode (must be one of the supported modes)
  if (settings.priorityMode !== undefined && 
      !['recency', 'frequency', 'size'].includes(settings.priorityMode)) {
    throw new Error('Invalid priority mode');
  }
  
  // Store settings in memory for service worker use
  self._cacheSettings = {
    cacheDuration: settings.cacheDuration !== undefined ? settings.cacheDuration : CACHE_EXPIRATION,
    priorityMode: settings.priorityMode || 'recency'
  };
  
  console.log('Cache settings updated:', self._cacheSettings);
  
  // Return success
  return true;
}

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
      version: CACHE_VERSION,
      accessCount: 1, // Track access frequency for prioritization
      size: summary.length // Track size for size-based prioritization
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
 * @param {number} maxAge - Maximum age in milliseconds (default: dynamic from settings)
 * @returns {Promise<string|null>} Summary text or null if not found/expired
 */
async function getCachedSummary(url, maxAge = null) {
  try {
    // Get current cache settings
    const settings = getCacheSettings();
    
    // Use provided maxAge or get from settings
    const cacheExpiration = maxAge !== null ? maxAge : settings.cacheDuration;
    
    const cache = await caches.open(SUMMARY_CACHE);
    const cacheKey = generateCacheKey(url);
    const cached = await cache.match(cacheKey);
    
    if (!cached) return null;
    
    const data = await cached.json();
    
    // Check if cache is expired (unless expiration is set to 0 = never expire)
    const now = Date.now();
    if (cacheExpiration !== 0 && now - data.timestamp > cacheExpiration) {
      // Cache expired, delete it
      await cache.delete(cacheKey);
      return null;
    }
    
    // Update access count and timestamp if using frequency-based prioritization
    if (settings.priorityMode === 'frequency') {
      data.accessCount = (data.accessCount || 0) + 1;
      data.lastAccessed = now;
      
      // Store updated metadata
      const updatedResponse = new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache-Date': new Date().toISOString()
        }
      });
      
      await cache.put(cacheKey, updatedResponse);
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
  // Check if there's an active summarization in progress for this URL
  const progress = activeSummarizations[url];
  if (progress) {
    return new Response(JSON.stringify({ 
      ready: false, 
      inProgress: true,
      progress: progress 
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Check if the summary is cached
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
    // Check if the refresh parameter is set to force a fresh summary
    const urlObj = new URL(self.location.origin + '/api/summarize');
    const params = new URL(url, self.location.origin).searchParams;
    const refreshParam = params.get('refresh');
    const forceRefresh = refreshParam === 'true';
    
    // Try to get from cache first if not forcing refresh
    if (!forceRefresh) {
      const cachedSummary = await getCachedSummary(url);
      
      if (cachedSummary) {
        return new Response(JSON.stringify({ 
          summary: cachedSummary, 
          cached: true 
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
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
        retryAfter: rateLimitCheck.retryAfterSeconds,
        severity: ErrorSeverity.TEMPORARY,
        troubleshooting: getTroubleshooting(ErrorType.RATE_LIMIT)
      }), {
        status: 429,
        headers: { 
          'Content-Type': 'application/json',
          'Retry-After': String(rateLimitCheck.retryAfterSeconds)
        }
      });
    }
    
    // Setup progress tracking
    setupProgressTracking(url);
    
    try {
      // Get the summary (this function updates progress internally)
      const summary = await getSummary(url, config);
      
      // Cache the result
      await cacheSummary(url, summary);
      
      // Complete progress
      updateProgress(url, 'complete', 100);
      
      // Clean up progress tracking after a short delay to allow clients to receive the final progress update
      setTimeout(() => {
        cleanupProgressTracking(url);
      }, 1000);
      
      return new Response(JSON.stringify({ 
        summary: summary, 
        cached: false 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Ensure progress tracking is cleaned up in case of error
      cleanupProgressTracking(url);
      
      // Re-throw the error to be caught by the outer try/catch
      throw error;
    }
  } catch (error) {
    // Ensure progress tracking is cleaned up
    cleanupProgressTracking(url);
    
    // Get detailed error information
    const errorInfo = error instanceof SummarizerError 
      ? getDetailedErrorInfo(error)
      : {
          message: `Error: ${error.message}`,
          type: ErrorType.UNKNOWN,
          severity: ErrorSeverity.CRITICAL,
          troubleshooting: getTroubleshooting(ErrorType.UNKNOWN)
        };
      
    return new Response(JSON.stringify({
      error: errorInfo.message,
      errorType: errorInfo.type,
      severity: errorInfo.severity,
      troubleshooting: errorInfo.troubleshooting
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
 * Progress tracking functions for single article summarization
 */

/**
 * Set up progress tracking for a URL summarization
 * @param {string} url - The URL being summarized
 */
function setupProgressTracking(url) {
  // Make sure we don't have existing tracking for this URL
  cleanupProgressTracking(url);
  
  activeSummarizations[url] = {
    startTime: Date.now(),
    phase: 'initializing',
    percent: 0,
    estimatedTimeRemaining: estimateSummarizationTime(),
  };
  
  // Broadcast initial progress
  broadcastProgress(url);
}

/**
 * Clean up progress tracking when summarization is complete
 * @param {string} url - The URL that was summarized
 */
function cleanupProgressTracking(url) {
  if (activeSummarizations[url]) {
    delete activeSummarizations[url];
  }
}

/**
 * Update progress for a summarization
 * @param {string} url - The URL being summarized
 * @param {string} phase - Current phase of summarization
 * @param {number} percent - Percentage complete (0-100)
 */
function updateProgress(url, phase, percent) {
  if (!activeSummarizations[url]) return;
  
  const progress = activeSummarizations[url];
  progress.phase = phase;
  progress.percent = percent;
  
  // Recalculate estimated time remaining
  const elapsed = Date.now() - progress.startTime;
  if (percent > 0) {
    const totalEstimate = (elapsed / percent) * 100;
    progress.estimatedTimeRemaining = Math.max(0, totalEstimate - elapsed);
  }
  
  // Broadcast progress update
  broadcastProgress(url);
}

/**
 * Broadcast progress to all connected clients
 * @param {string} url - The URL being summarized
 */
async function broadcastProgress(url) {
  const clients = await self.clients.matchAll();
  const progress = activeSummarizations[url];
  
  if (progress && clients.length > 0) {
    clients.forEach(client => {
      client.postMessage({
        action: 'summaryProgress',
        url: url,
        progress: progress
      });
    });
  }
}

/**
 * Estimate total time needed for summarization based on provider
 * @param {string} provider - AI provider name
 * @returns {number} Estimated time in milliseconds
 */
function estimateSummarizationTime(provider = 'default') {
  // Average times based on provider
  const estimates = {
    'openai': 10000,      // 10 seconds
    'anthropic': 12000,   // 12 seconds
    'deepseek': 8000,     // 8 seconds
    'default': 10000      // 10 seconds default
  };
  
  return estimates[provider] || estimates.default;
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
    // Implement adaptive timeout based on previous response times
    const timeoutDuration = self._configFetchTimeoutMs || 2000; // Default: 2 seconds
    const startTime = Date.now();
    
    try {
      await clients[0].postMessage({ action: 'getConfig' });
      config = await new Promise((resolve, reject) => {
        let handled = false;
        
        function handler(event) {
          if (event.data.action === 'config' && !handled) {
            handled = true;
            self.removeEventListener('message', handler);
            resolve(event.data.config);
          }
        }
        
        self.addEventListener('message', handler);
        
        // Implement adaptive timeout
        setTimeout(() => {
          if (!handled) {
            handled = true;
            self.removeEventListener('message', handler);
            reject(new Error('Config request timed out'));
          }
        }, timeoutDuration);
      });
      
      // Update timeout duration for next call based on this call's performance
      // Use a moving average to smooth out variations
      const elapsed = Date.now() - startTime;
      self._configFetchTimeoutMs = Math.min(
        5000, // Cap at 5 seconds max
        Math.max(
          1000, // Minimum 1 second
          Math.round((self._configFetchTimeoutMs || 2000) * 0.7 + elapsed * 1.5) // Weighted average
        )
      );
      
      // Decrypt API key if configuration was received
      if (config) {
        config = decryptApiKey(config);
      }
      
      return config;
    } catch (error) {
      console.error('Error getting configuration:', error);
      // Increase timeout slightly if we timed out
      if (error.message === 'Config request timed out') {
        self._configFetchTimeoutMs = Math.min(5000, (self._configFetchTimeoutMs || 2000) * 1.5);
      }
      return null;
    }
  }
  
  return null;
}

/**
 * Checks if queue mode is enabled
 * @returns {Promise<boolean>} True if queue mode is enabled
 */
async function getQueueMode() {
  const clients = await self.clients.matchAll();
  let queueMode = false;
  
  if (clients.length > 0) {
    // Use adaptive timeout similar to getConfig
    const timeoutDuration = self._queueModeFetchTimeoutMs || 2000;
    const startTime = Date.now();
    
    try {
      await clients[0].postMessage({ action: 'getQueueMode' });
      queueMode = await new Promise((resolve, reject) => {
        let handled = false;
        
        function handler(event) {
          if (event.data.action === 'queueMode' && !handled) {
            handled = true;
            self.removeEventListener('message', handler);
            resolve(event.data.queueMode);
          }
        }
        
        self.addEventListener('message', handler);
        
        // Adaptive timeout
        setTimeout(() => {
          if (!handled) {
            handled = true;
            self.removeEventListener('message', handler);
            reject(new Error('Queue mode request timed out'));
          }
        }, timeoutDuration);
      });
      
      // Update timeout for next call
      const elapsed = Date.now() - startTime;
      self._queueModeFetchTimeoutMs = Math.min(
        5000,
        Math.max(
          1000,
          Math.round((self._queueModeFetchTimeoutMs || 2000) * 0.7 + elapsed * 1.5)
        )
      );
      
      return queueMode;
    } catch (error) {
      console.error('Error getting queue mode:', error);
      // Increase timeout slightly if we timed out
      if (error.message === 'Queue mode request timed out') {
        self._queueModeFetchTimeoutMs = Math.min(5000, (self._queueModeFetchTimeoutMs || 2000) * 1.5);
      }
      return false;
    }
  }
  
  return false;
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
  // Network and connectivity issues
  NETWORK: 'NETWORK',
  CORS: 'CORS',
  TIMEOUT: 'TIMEOUT',
  
  // Authorization and authentication
  API_KEY: 'API_KEY',
  AUTHORIZATION: 'AUTHORIZATION',
  
  // Rate limiting and quotas
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  
  // Input validation
  INVALID_URL: 'INVALID_URL',
  INVALID_CONTENT: 'INVALID_CONTENT',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
  
  // AI provider issues
  SERVER: 'SERVER',
  MODEL_ERROR: 'MODEL_ERROR',
  CONTENT_FILTER: 'CONTENT_FILTER',
  
  // Application errors
  CONFIG_ERROR: 'CONFIG_ERROR',
  CACHE_ERROR: 'CACHE_ERROR',
  
  // Generic fallback
  UNKNOWN: 'UNKNOWN'
};

/**
 * Error severity levels
 */
const ErrorSeverity = {
  // Temporary issues that might resolve on retry
  TEMPORARY: 'temporary',
  
  // Issues that require user action to fix
  FIXABLE: 'fixable',
  
  // Serious issues that may require technical support
  CRITICAL: 'critical'
};

/**
 * Custom error class with error type classification
 */
class SummarizerError extends Error {
  constructor(message, type = ErrorType.UNKNOWN, originalError = null, severity = null) {
    super(message);
    this.name = 'SummarizerError';
    this.type = type;
    this.originalError = originalError;
    
    // Auto-assign severity based on error type if not specified
    this.severity = severity || this.determineSeverity(type);
  }
  
  /**
   * Determine error severity based on type
   * @param {string} type - Error type
   * @returns {string} Severity level
   */
  determineSeverity(type) {
    // Temporary errors that might resolve on retry
    if ([
      ErrorType.NETWORK, 
      ErrorType.TIMEOUT,
      ErrorType.RATE_LIMIT, 
      ErrorType.SERVER
    ].includes(type)) {
      return ErrorSeverity.TEMPORARY;
    }
    
    // Errors that require user action to fix
    if ([
      ErrorType.API_KEY,
      ErrorType.INVALID_URL,
      ErrorType.INVALID_CONTENT,
      ErrorType.AUTHORIZATION
    ].includes(type)) {
      return ErrorSeverity.FIXABLE;
    }
    
    // Critical errors that may need technical support
    if ([
      ErrorType.QUOTA_EXCEEDED,
      ErrorType.CONFIG_ERROR,
      ErrorType.CACHE_ERROR,
      ErrorType.CONTENT_FILTER,
      ErrorType.CORS
    ].includes(type)) {
      return ErrorSeverity.CRITICAL;
    }
    
    // Default
    return ErrorSeverity.CRITICAL;
  }
}

/**
 * Gets troubleshooting steps for a specific error type
 * @param {string} errorType - The error type
 * @returns {Object} Troubleshooting information
 */
function getTroubleshooting(errorType) {
  const troubleshooting = {
    [ErrorType.NETWORK]: {
      title: 'Network Connection Issues',
      steps: [
        'Check that your device has a stable internet connection',
        'Try switching between Wi-Fi and mobile data if available',
        'Disable any VPN or proxy services that might be interfering',
        'If on public Wi-Fi, try connecting to a different network'
      ]
    },
    [ErrorType.CORS]: {
      title: 'Content Access Restricted',
      steps: [
        'The article may be behind a paywall or subscription',
        'Try sharing a different article from a more accessible source',
        'Some news sites block AI services from accessing their content'
      ]
    },
    [ErrorType.TIMEOUT]: {
      title: 'Request Timed Out',
      steps: [
        'Try again when your internet connection is stronger',
        'The AI service might be experiencing high traffic',
        'Wait a few minutes and try your request again',
        'Try a different AI provider in the settings'
      ]
    },
    [ErrorType.API_KEY]: {
      title: 'API Key Issues',
      steps: [
        'Your API key may be invalid or expired',
        'Go to "Configure AI Provider" to update your API key',
        'Check your account status on the AI provider\'s website',
        'Try configuring a different AI provider'
      ]
    },
    [ErrorType.AUTHORIZATION]: {
      title: 'Authorization Failed',
      steps: [
        'Your API key may not have permission for this request',
        'Check if your subscription is still active',
        'Verify your account status on the provider\'s website',
        'You may need to upgrade your plan with the AI provider'
      ]
    },
    [ErrorType.RATE_LIMIT]: {
      title: 'Rate Limit Exceeded',
      steps: [
        'You\'ve made too many requests in a short period',
        'Wait a few minutes before trying again',
        'Try a different AI provider with higher rate limits',
        'Consider upgrading your API plan for higher limits'
      ]
    },
    [ErrorType.QUOTA_EXCEEDED]: {
      title: 'Usage Quota Exceeded',
      steps: [
        'You\'ve exceeded your monthly/daily quota with this AI provider',
        'Check your usage on the provider\'s dashboard',
        'Try configuring a different AI provider',
        'Consider upgrading your plan for higher usage limits'
      ]
    },
    [ErrorType.INVALID_URL]: {
      title: 'Invalid Article URL',
      steps: [
        'Make sure you\'re sharing a news article link',
        'The URL format may be incorrect or incomplete',
        'Try sharing the article from the site\'s main page',
        'Some social media preview links may not work correctly'
      ]
    },
    [ErrorType.INVALID_CONTENT]: {
      title: 'Content Issues',
      steps: [
        'The shared link may not contain an actual article',
        'Try sharing a regular news article instead',
        'Some dynamic or JavaScript-heavy pages may not work',
        'The content might be in a format the AI can\'t process'
      ]
    },
    [ErrorType.CONTENT_BLOCKED]: {
      title: 'Content Access Denied',
      steps: [
        'The article may require login or subscription',
        'The site may be blocking automated access',
        'Try with a different article from a more open source',
        'Some news sites actively block AI systems'
      ]
    },
    [ErrorType.SERVER]: {
      title: 'AI Service Issues',
      steps: [
        'The AI provider\'s servers may be experiencing problems',
        'This is usually temporary - try again later',
        'Check the provider\'s status page for outages',
        'Try configuring a different AI provider'
      ]
    },
    [ErrorType.MODEL_ERROR]: {
      title: 'AI Model Error',
      steps: [
        'The AI model encountered an internal error',
        'Try again - these errors are often temporary',
        'The article may contain content that confused the AI',
        'Try with a different model or provider'
      ]
    },
    [ErrorType.CONTENT_FILTER]: {
      title: 'Content Filter Triggered',
      steps: [
        'The article may contain content that violated AI policies',
        'Some topics may be restricted by the AI provider',
        'Try summarizing a different article',
        'Consider using a different AI provider'
      ]
    },
    [ErrorType.CONFIG_ERROR]: {
      title: 'Configuration Error',
      steps: [
        'There may be an issue with your app configuration',
        'Try reconfiguring your AI provider',
        'Clear your browser data and try again',
        'Reinstall the app if the problem persists'
      ]
    },
    [ErrorType.CACHE_ERROR]: {
      title: 'Cache Error',
      steps: [
        'There was an issue accessing the app\'s cache',
        'Try clearing the cache from the settings',
        'Restart your browser or device',
        'Reinstall the app if the problem persists'
      ]
    },
    [ErrorType.UNKNOWN]: {
      title: 'Unexpected Error',
      steps: [
        'An unexpected error occurred during processing',
        'Try your request again',
        'Restart the app or refresh the page',
        'Try with a different article or AI provider',
        'If the problem persists, please report the issue'
      ]
    }
  };
  
  return troubleshooting[errorType] || troubleshooting[ErrorType.UNKNOWN];
}

/**
 * Gets detailed error information with user-friendly message and troubleshooting
 * @param {SummarizerError} error - The error object
 * @returns {Object} Detailed error information
 */
function getDetailedErrorInfo(error) {
  // Get the basic user-friendly message
  const baseMessage = getUserFriendlyErrorMessage(error);
  
  // Get troubleshooting steps
  const troubleshooting = getTroubleshooting(error.type);
  
  return {
    message: baseMessage,
    type: error.type,
    severity: error.severity,
    troubleshooting: troubleshooting
  };
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
    
    case ErrorType.CORS:
      return 'Cannot access the article content. The website might be blocking access or require a subscription.';
    
    case ErrorType.API_KEY:
      return 'Invalid API key. Please update your API key in the configuration settings.';
    
    case ErrorType.AUTHORIZATION:
      return 'Your API key doesn\'t have permission for this request. Please check your subscription status.';
    
    case ErrorType.RATE_LIMIT:
      return 'API rate limit exceeded. Please try again later or switch to a different AI provider.';
    
    case ErrorType.QUOTA_EXCEEDED:
      return 'You\'ve exceeded your usage quota with this AI provider. Consider switching providers or upgrading your plan.';
    
    case ErrorType.INVALID_URL:
      return 'Invalid article URL. Please make sure you\'re sharing a valid news article from Google News.';
    
    case ErrorType.INVALID_CONTENT:
      return 'The shared content doesn\'t appear to be a standard article. Try sharing a regular news article.';
    
    case ErrorType.CONTENT_BLOCKED:
      return 'The article content is restricted. It may require a subscription or login to access.';
    
    case ErrorType.TIMEOUT:
      return 'Request timed out. The AI service might be experiencing high load. Please try again later.';
    
    case ErrorType.SERVER:
      return 'The AI service is experiencing issues. Please try again later or switch providers.';
    
    case ErrorType.MODEL_ERROR:
      return 'The AI model encountered an error processing this article. Try a different model or provider.';
    
    case ErrorType.CONTENT_FILTER:
      return 'The article contains content that triggered the AI\'s content filter. Try a different article.';
    
    case ErrorType.CONFIG_ERROR:
      return 'There\'s an issue with your app configuration. Try reconfiguring your AI provider.';
    
    case ErrorType.CACHE_ERROR:
      return 'Error accessing the app cache. Try clearing the cache from the settings.';
    
    default:
      return `Unexpected error: ${error.message || 'Unknown error'}`;
  }
}

/**
 * Classifies error based on response and error details
 * @param {Error} error - Original error
 * @param {Response|null} response - Fetch response if available
 * @returns {SummarizerError} Classified error
 */
function classifyError(error, response = null) {
  const errorMessage = error.message || 'Unknown error';
  
  // Network errors (no response)
  if (!response) {
    if (errorMessage.includes('NetworkError') || errorMessage.includes('Failed to fetch')) {
      return new SummarizerError('Network connection error', ErrorType.NETWORK, error);
    }
    if (errorMessage.includes('timeout') || errorMessage.includes('Timed out')) {
      return new SummarizerError('Request timed out', ErrorType.TIMEOUT, error);
    }
    if (errorMessage.includes('CORS') || errorMessage.includes('cross-origin')) {
      return new SummarizerError('Cross-origin access blocked', ErrorType.CORS, error);
    }
    return new SummarizerError(errorMessage, ErrorType.UNKNOWN, error);
  }
  
  // Look for specific error messages in the response
  let responseBody = '';
  try {
    if (typeof response.clone === 'function') {
      // Try to get response body for more context if available
      const clonedResponse = response.clone();
      if (clonedResponse.text) {
        responseBody = clonedResponse.text();
      }
    }
  } catch (e) {
    // Ignore errors when trying to get response body
  }
  
  // Check for content filtering or policy violations in error response
  if (responseBody) {
    const lowerBody = responseBody.toLowerCase();
    if (lowerBody.includes('content filter') || 
        lowerBody.includes('policy violation') || 
        lowerBody.includes('content policy')) {
      return new SummarizerError('Content filter triggered', ErrorType.CONTENT_FILTER, error);
    }
    
    if (lowerBody.includes('quota') || lowerBody.includes('limit exceeded')) {
      return new SummarizerError('Usage quota exceeded', ErrorType.QUOTA_EXCEEDED, error);
    }
  }
  
  // HTTP status based errors
  switch (response.status) {
    case 401:
      return new SummarizerError('Invalid API key', ErrorType.API_KEY, error);
      
    case 403:
      return new SummarizerError('Access denied', ErrorType.AUTHORIZATION, error);
      
    case 429:
      return new SummarizerError('Rate limit exceeded', ErrorType.RATE_LIMIT, error);
      
    case 400:
      // Try to distinguish between different 400 errors
      if (errorMessage.includes('url') || errorMessage.includes('URL')) {
        return new SummarizerError('Invalid article URL', ErrorType.INVALID_URL, error);
      } else if (errorMessage.includes('content')) {
        return new SummarizerError('Invalid content format', ErrorType.INVALID_CONTENT, error);
      } else {
        return new SummarizerError('Invalid request format', ErrorType.INVALID_URL, error);
      }
      
    case 402:
      return new SummarizerError('Payment required', ErrorType.QUOTA_EXCEEDED, error);
      
    case 404:
      return new SummarizerError('Resource not found', ErrorType.INVALID_URL, error);
      
    case 500:
    case 502:
    case 503:
    case 504:
      return new SummarizerError('AI service error', ErrorType.SERVER, error);
      
    default:
      return new SummarizerError(`Error (${response.status}): ${errorMessage}`, ErrorType.UNKNOWN, error);
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
  
  // Update progress - starting API call
  updateProgress(url, 'connecting', 10);
  
  let summaryText = '';
  let aiResponse = null;
  
  try {
    // Format the AI prompt based on article URL
    const promptText = `Please provide a concise summary of this news article: ${url}. Focus on the key facts, main points, and important context.`;
    
    updateProgress(url, 'sending-request', 25);
    
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
      
      updateProgress(url, 'processing', 50);
      
      // Handle HTTP errors
      if (!aiResponse.ok) {
        const errorText = await aiResponse.text().catch(() => 'Unknown error');
        throw new Error(errorText);
      }
      
      updateProgress(url, 'receiving-response', 75);
      
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
      
      updateProgress(url, 'processing', 50);
      
      // Handle HTTP errors
      if (!aiResponse.ok) {
        const errorText = await aiResponse.text().catch(() => 'Unknown error');
        throw new Error(errorText);
      }
      
      updateProgress(url, 'receiving-response', 75);
      
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
      
      updateProgress(url, 'processing', 50);
      
      // Handle HTTP errors
      if (!aiResponse.ok) {
        const errorText = await aiResponse.text().catch(() => 'Unknown error');
        throw new Error(errorText);
      }
      
      updateProgress(url, 'receiving-response', 75);
      
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
    
    // Final progress update
    updateProgress(url, 'finalizing', 90);
    
    // Cache the successful result
    await cacheSummary(url, summaryText);
    
    // Complete progress
    updateProgress(url, 'complete', 100);
    
    return summaryText;
  } catch (error) {
    // Ensure progress tracking is cleaned up in case of error
    updateProgress(url, 'error', 0);
    
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
        
        // Set up progress tracking for this URL
        setupProgressTracking(article.url);
        
        try {
          summary = await getSummary(article.url, config);
          
          // Clean up progress tracking after successful summarization
          cleanupProgressTracking(article.url);
          
          // Add a small delay between API calls to avoid overwhelming the provider
          if (currentArticle < articles.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (error) {
          // Ensure progress tracking is cleaned up if summarization fails
          cleanupProgressTracking(article.url);
          throw error;
        }
      }
      
      results.push({
        url: article.url,
        summary: summary,
        success: true,
        fromCache: fromCache
      });
    } catch (error) {
      // Get detailed error info
      const errorInfo = error instanceof SummarizerError 
        ? getDetailedErrorInfo(error)
        : {
            message: `Error: ${error.message || 'Unknown error'}`,
            type: ErrorType.UNKNOWN,
            severity: ErrorSeverity.CRITICAL,
            troubleshooting: getTroubleshooting(ErrorType.UNKNOWN)
          };
      
      results.push({
        url: article.url,
        summary: errorInfo.message,
        success: false,
        errorType: errorInfo.type,
        severity: errorInfo.severity,
        troubleshooting: errorInfo.troubleshooting,
        retryable: errorInfo.severity === ErrorSeverity.TEMPORARY
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
    // Return cached summary immediately with sharing options
    return new Response(`
       <!doctype html><html><head><meta charset="utf-8">
       <title>AI Summary (Cached)</title><style>
          body{font-family:sans-serif;padding:2rem;line-height:1.4}
          pre{white-space:pre-wrap}
          .cache-notice{color:#6b7280;font-size:0.9rem;margin-bottom:1rem}
          .refresh-btn{background:#4F46E5;color:white;border:none;border-radius:4px;padding:0.5rem 1rem;cursor:pointer;margin-top:1rem}
          .refresh-btn:hover{background:#4338ca}
          .action-bar{display:flex;gap:0.5rem;margin-top:1.5rem;flex-wrap:wrap}
          .action-button{display:inline-flex;align-items:center;gap:0.5rem;background:#f1f5f9;color:#475569;border:none;padding:0.5rem 1rem;border-radius:6px;font-size:0.9rem;cursor:pointer;text-decoration:none}
          .action-button:hover{background:#e2e8f0;color:#1e293b}
          .action-button svg{width:16px;height:16px}
          @media (max-width: 600px) {
            .action-bar{flex-direction:column}
            .action-button{width:100%;justify-content:center}
          }
       </style>
       <script>
         // Copy to clipboard function
         function copyToClipboard() {
           const summaryText = document.getElementById('summaryText').innerText;
           const url = "${sharedURL}";
           const textToCopy = "Summary of: " + url + "\\n\\n" + summaryText;
           
           navigator.clipboard.writeText(textToCopy)
             .then(() => {
               const button = document.getElementById('copyButton');
               const originalText = button.innerText;
               button.innerText = 'Copied!';
               setTimeout(() => {
                 button.innerText = originalText;
               }, 2000);
             })
             .catch(err => {
               alert('Failed to copy: ' + err);
             });
         }
         
         // Share function
         function shareSummary() {
           const summaryText = document.getElementById('summaryText').innerText;
           const url = "${sharedURL}";
           
           if (navigator.share) {
             navigator.share({
               title: 'AI Summary',
               text: summaryText,
               url: url
             })
             .catch(err => {
               console.error('Share failed:', err);
               copyToClipboard();
               alert('Sharing failed. Summary copied to clipboard instead!');
             });
           } else {
             copyToClipboard();
             alert('Web Share not supported. Summary copied to clipboard instead!');
           }
         }
       </script>
       </head><body>
       <h2>✅ Summary ready</h2>
       <div class="cache-notice">This summary was retrieved from cache. <button class="refresh-btn" onclick="location.href='./api/summarize?url=${encodeURIComponent(sharedURL)}&refresh=true'">Generate Fresh Summary</button></div>
       <pre id="summaryText">${cachedSummary}</pre>
       
       <div class="action-bar">
         <button onclick="shareSummary()" class="action-button">
           <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <circle cx="18" cy="5" r="3"></circle>
             <circle cx="6" cy="12" r="3"></circle>
             <circle cx="18" cy="19" r="3"></circle>
             <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
             <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
           </svg>
           Share Summary
         </button>
         
         <button id="copyButton" onclick="copyToClipboard()" class="action-button">
           <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
             <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
           </svg>
           Copy to Clipboard
         </button>
         
         <a href="${sharedURL}" target="_blank" class="action-button">
           <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
             <polyline points="15 3 21 3 21 9"></polyline>
             <line x1="10" y1="14" x2="21" y2="3"></line>
           </svg>
           Open Original Article
         </a>
       </div>
       
       <p style="margin-top:2rem">
         <a href="javascript:history.back()">← Back</a>
       </p>
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

  // Standard single summarization flow with loading indicator and progress tracking
  try {
    // Setup progress tracking
    setupProgressTracking(sharedURL);
    
    // Return loading state with progress indicators
    return new Response(`
       <!doctype html><html><head><meta charset="utf-8">
       <title>Generating Summary...</title><style>
          body{font-family:sans-serif;padding:2rem;line-height:1.4;text-align:center}
          pre{white-space:pre-wrap}
          .spinner{width:40px;height:40px;margin:20px auto;border:4px solid rgba(0,0,0,.1);border-radius:50%;border-top-color:#4F46E5;animation:spin 1s ease-in-out infinite}
          @keyframes spin{to{transform:rotate(360deg)}}
          @keyframes pulse{0%{opacity:0.6}50%{opacity:1}100%{opacity:0.6}}
          .message{margin-top:20px;color:#6b7280}
          .progress-container{width:100%;max-width:300px;height:6px;background:#e2e8f0;border-radius:3px;margin:20px auto;overflow:hidden}
          .progress-bar{height:100%;background:#4F46E5;width:0%;transition:width 0.5s ease}
          .pulse{animation:pulse 2s infinite ease-in-out}
          .progress-info{font-size:0.8rem;color:#6b7280;margin-top:10px}
          .progress-phase{font-weight:bold;margin-right:5px}
          .progress-time{font-style:italic}
          .error-container{background:#fef2f2;border-radius:8px;padding:1rem;margin-top:2rem;text-align:left;display:none}
          .error-title{color:#991b1b;margin-top:0}
          .retry-button{background:#4F46E5;color:white;border:none;padding:0.5rem 1rem;border-radius:4px;margin-top:1rem;cursor:pointer}
          .retry-button:hover{background:#4338ca}
       </style>
       <script>
         // Advanced progress tracking
         let progressBar = null;
         let progressPhase = null;
         let progressTime = null;
         let errorContainer = null;
         
         // Format time remaining
         function formatTimeRemaining(ms) {
           if (ms <= 0) return 'almost done';
           if (ms < 5000) return 'just a few seconds';
           const seconds = Math.floor(ms / 1000);
           return seconds > 60 
             ? \`about \${Math.floor(seconds / 60)} minute\${Math.floor(seconds / 60) > 1 ? 's' : ''}\` 
             : \`about \${seconds} seconds\`;
         }
         
         // Format current phase
         function formatPhase(phase) {
           const phases = {
             'initializing': 'Preparing',
             'connecting': 'Connecting to AI',
             'sending-request': 'Sending request',
             'processing': 'AI is analyzing',
             'receiving-response': 'Receiving summary',
             'finalizing': 'Finalizing',
             'complete': 'Completed',
             'error': 'Error occurred'
           };
           return phases[phase] || phase;
         }
         
         // Update progress display
         function updateProgressDisplay(progress) {
           if (!progressBar) {
             progressBar = document.getElementById('progressBar');
             progressPhase = document.getElementById('progressPhase');
             progressTime = document.getElementById('progressTime');
           }
           
           if (progressBar && progress) {
             progressBar.style.width = \`\${progress.percent}%\`;
             progressPhase.textContent = formatPhase(progress.phase);
             
             if (progress.phase === 'error') {
               progressPhase.style.color = '#dc2626';
               document.getElementById('progressSection').style.opacity = '0.5';
             }
             
             if (progress.estimatedTimeRemaining > 0) {
               progressTime.textContent = \`\${formatTimeRemaining(progress.estimatedTimeRemaining)}\`;
               progressTime.parentElement.style.display = 'block';
             } else {
               progressTime.parentElement.style.display = 'none';
             }
           }
         }
         
         // Show error
         function showError(error) {
           if (!errorContainer) {
             errorContainer = document.getElementById('errorContainer');
           }
           
           if (errorContainer) {
             const title = document.getElementById('errorTitle');
             const message = document.getElementById('errorMessage');
             
             title.textContent = error.title || 'Error occurred';
             message.textContent = error.message || 'Something went wrong during summarization';
             
             // Handle retry button setup
             if (error.retryable) {
               document.getElementById('retryButton').style.display = 'inline-block';
             } else {
               document.getElementById('retryButton').style.display = 'none';
             }
             
             errorContainer.style.display = 'block';
             
             // Fade progress elements
             document.getElementById('progressSection').style.opacity = '0.5';
           }
         }
         
         // Retry request
         function retryRequest() {
           if (navigator.serviceWorker && navigator.serviceWorker.controller) {
             // Update UI to show we're retrying
             const retryButton = document.getElementById('retryButton');
             retryButton.textContent = 'Retrying...';
             retryButton.disabled = true;
             
             // Ask service worker to retry the summarization
             navigator.serviceWorker.controller.postMessage({
               action: 'retryFailedSummary',
               url: '${sharedURL}'
             });
             
             // Reset progress section
             document.getElementById('progressSection').style.opacity = '1';
             document.getElementById('progressBar').style.width = '5%';
             document.getElementById('progressPhase').textContent = 'Initializing';
             document.getElementById('progressPhase').style.color = '#6b7280';
             
             // Hide error container
             document.getElementById('errorContainer').style.display = 'none';
             
             // Listen for retry outcome
             navigator.serviceWorker.addEventListener('message', function retryHandler(event) {
               if (event.data.action === 'retrySuccess') {
                 // On success, reload the page to show the summary
                 window.location.reload();
               } else if (event.data.action === 'retryFailure') {
                 // On failure, show error and reenable button
                 showError({
                   title: event.data.error.troubleshooting?.title || 'Retry Failed',
                   message: event.data.error.message,
                   retryable: event.data.error.severity === 'temporary'
                 });
                 
                 retryButton.textContent = 'Retry';
                 retryButton.disabled = false;
                 
                 // Remove this listener
                 navigator.serviceWorker.removeEventListener('message', retryHandler);
               }
             });
           }
         }
         
         // Check summary status with progress
         async function checkSummaryProgress() {
           const url = '${sharedURL}';
           try {
             const response = await fetch('./summary-status?url=' + encodeURIComponent(url));
             const data = await response.json();
             
             if (data.ready) {
               // Summary is ready, reload page
               window.location.reload();
             } else if (data.inProgress && data.progress) {
               // Update progress display
               updateProgressDisplay(data.progress);
               setTimeout(checkSummaryProgress, 1000);
             } else {
               // No progress info yet, start normal processing
               setTimeout(startProcessing, 500);
             }
           } catch (e) {
             console.error('Error checking status:', e);
             setTimeout(checkSummaryProgress, 2000);
           }
         }
         
         // Start summary processing
         async function startProcessing() {
           try {
             const response = await fetch('./api/summarize?url=${encodeURIComponent(sharedURL)}');
             if (response.ok) {
               window.location.reload();
             } else {
               const errorData = await response.json();
               if (errorData.error) {
                 showError({
                   title: errorData.troubleshooting?.title || 'Error',
                   message: errorData.error,
                   retryable: errorData.severity === 'temporary'
                 });
               } else {
                 setTimeout(() => window.location.reload(), 3000);
               }
             }
           } catch (err) {
             console.error('Error starting summarization:', err);
             setTimeout(() => window.location.reload(), 3000);
           }
         }
         
         // Start checking progress when page loads
         document.addEventListener('DOMContentLoaded', () => {
           checkSummaryProgress();
         });
       </script>
       </head><body>
       <h2>Generating Summary</h2>
       
       <div id="progressSection">
         <div class="spinner"></div>
         <div class="progress-container">
           <div class="progress-bar" id="progressBar" style="width:5%"></div>
         </div>
         <p class="progress-info">
           <span class="progress-phase" id="progressPhase">Initializing</span>
           <span class="pulse">•</span>
         </p>
         <p class="progress-info" style="display:none">
           Estimated time: <span class="progress-time" id="progressTime">calculating...</span>
         </p>
         <p class="message">Analyzing article using AI, please wait...</p>
       </div>
       
       <div id="errorContainer" class="error-container">
         <h3 class="error-title" id="errorTitle">Error</h3>
         <p id="errorMessage">An error occurred while generating the summary.</p>
         <button id="retryButton" onclick="retryRequest()" class="retry-button">Retry</button>
         <button onclick="window.location.reload()" style="background:#6b7280;color:white;border:none;padding:0.5rem 1rem;border-radius:4px;margin-top:1rem;margin-left:0.5rem;cursor:pointer">Go Back</button>
       </div>
       </body></html>`,
       { headers:{'Content-Type':'text/html'} });
  } catch (error) {
    // Clean up progress tracking
    cleanupProgressTracking(sharedURL);
    
    // Create error response
    return createErrorResponse(error);
  }
}

/**
 * Creates an error response with a user-friendly error page
 * @param {Error} error - The error that occurred
 * @returns {Response} HTML error response
 */
function createErrorResponse(error) {
  // Get error details
  const errorInfo = error instanceof SummarizerError 
    ? getDetailedErrorInfo(error)
    : {
        message: `Error: ${error.message || 'Unknown error'}`,
        type: ErrorType.UNKNOWN,
        severity: ErrorSeverity.CRITICAL,
        troubleshooting: getTroubleshooting(ErrorType.UNKNOWN)
      };
  
  // Get error title and generate steps list
  const errorTitle = errorInfo.troubleshooting ? errorInfo.troubleshooting.title : 'Error';
  const steps = errorInfo.troubleshooting && errorInfo.troubleshooting.steps || [];
  const stepsList = steps.map(step => `<li>${step}</li>`).join('');
  
  // Check if error is retryable
  const isRetryable = errorInfo.severity === ErrorSeverity.TEMPORARY;
  
  // Create simplified HTML response
  return new Response(`
    <!doctype html><html><head><meta charset="utf-8">
    <title>Error</title>
    <style>
      body{font-family:sans-serif;padding:2rem;max-width:600px;margin:0 auto}
      .error-box{border-radius:8px;padding:1.5rem;margin-bottom:1rem;background:#fef2f2;border-left:4px solid #ef4444}
      .error-title{margin-top:0;font-size:1.3rem}
      .error-message{color:#1f2937}
      .help{background:#f8fafc;border-radius:8px;padding:1rem;margin-bottom:1rem}
      .help h3{margin-top:0}
      .help ul{padding-left:1.5rem}
      .help li{margin-bottom:0.5rem}
      .back{display:inline-block;margin-top:1rem;color:#4F46E5;text-decoration:none}
      .back:hover{text-decoration:underline}
      .retry{background:#4F46E5;color:white;border:none;padding:0.5rem 1rem;border-radius:4px;cursor:pointer;margin-right:0.5rem}
      .retry:hover{background:#4338ca}
      .back-button{background:#6b7280;color:white;border:none;padding:0.5rem 1rem;border-radius:4px;cursor:pointer;margin-top:1rem}
      .button-container{margin-top:1.5rem}
    </style>
    <script>
      function retryRequest() {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          // Get the URL from the current page (it's in our query parameters)
          const urlParams = new URLSearchParams(window.location.search);
          const url = urlParams.get('url');
          
          if (!url) {
            alert('Could not find URL to retry');
            return;
          }
          
          // Update button
          const retryButton = document.getElementById('retryButton');
          retryButton.textContent = 'Retrying...';
          retryButton.disabled = true;
          
          // Send retry message to service worker
          navigator.serviceWorker.controller.postMessage({
            action: 'retryFailedSummary',
            url: url
          });
          
          // Listen for result
          navigator.serviceWorker.addEventListener('message', function retryHandler(event) {
            if (event.data.action === 'retrySuccess') {
              // On success, show the summary
              location.reload();
            } else if (event.data.action === 'retryFailure') {
              // On failure, show error and reenable button
              alert('Retry failed: ' + event.data.error.message);
              retryButton.textContent = 'Retry';
              retryButton.disabled = false;
              
              // Remove this listener
              navigator.serviceWorker.removeEventListener('message', retryHandler);
            }
          });
        }
      }
    </script>
    </head>
    <body>
      <h2>❌ Error occurred</h2>
      <div class="error-box">
        <h3 class="error-title">${errorTitle}</h3>
        <p class="error-message">${errorInfo.message}</p>
      </div>
      <div class="help">
        <h3>How to fix this:</h3>
        <ul>${stepsList}</ul>
      </div>
      <div class="button-container">
        ${isRetryable ? '<button id="retryButton" onclick="retryRequest()" class="retry">Retry Now</button>' : ''}
        <a href="javascript:history.back()" class="back-button">Go Back</a>
      </div>
    </body>
    </html>`,
    { headers:{'Content-Type':'text/html'} }
  );
}