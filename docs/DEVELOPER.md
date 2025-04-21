# Developer Documentation

This document provides technical details for developers working on or maintaining the GNews-Summarizer project.

## Project Architecture

GNews-Summarizer is a Progressive Web App (PWA) with a service worker architecture that enables:

1. Direct API calls to AI providers (OpenAI, Anthropic, DeepSeek)
2. Offline capabilities through caching
3. Background processing of article queues
4. Integration with the Android share system

The application is 100% client-side with no backend requirements, making it easy to deploy and maintain.

## Key Components

### Service Worker (`sw.js`)
- Handles intercept of the Web Share API
- Manages caching of articles and summaries
- Performs API calls to AI providers
- Handles error classification and recovery
- Tracks processing progress and communicates with the UI

### Main UI (`index.html`)
- Manages article queue
- Displays summaries and error messages
- Communicates with service worker
- Provides user controls for configuration

### Landing Page (`landing.html`)
- Handles initial setup and API key configuration
- Manages device-specific encryption
- Provides installation instructions

### Settings (`settings.html`)
- Shows configuration status
- Provides API key management
- Displays security information

## Error Handling System

The application includes a comprehensive error handling system that classifies errors, provides detailed troubleshooting information, and enables graceful recovery.

### Error Classification

Errors are categorized by type and severity:

#### Error Types
```javascript
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
```

#### Error Severities
```javascript
const ErrorSeverity = {
  // Temporary issues that might resolve on retry
  TEMPORARY: 'temporary',
  
  // Issues that require user action to fix
  FIXABLE: 'fixable',
  
  // Serious issues that may require technical support
  CRITICAL: 'critical'
};
```

### Creating Custom Errors

When you need to throw a custom error, use the `SummarizerError` class:

```javascript
throw new SummarizerError(
  'The article content appears to be behind a paywall.',
  ErrorType.CONTENT_BLOCKED,
  originalError // optional
);
```

The error type will automatically determine the severity, but you can override it:

```javascript
throw new SummarizerError(
  'Custom error message',
  ErrorType.NETWORK,
  originalError,
  ErrorSeverity.CRITICAL // override default severity
);
```

### Error Response Format

When an error occurs, the response should include:

1. A user-friendly error message
2. The error type for programmatic handling
3. The error severity for UI display
4. Troubleshooting steps when applicable

Example:
```javascript
return new Response(JSON.stringify({
  error: errorInfo.message,
  errorType: errorInfo.type,
  severity: errorInfo.severity,
  troubleshooting: errorInfo.troubleshooting
}), {
  status: 500,
  headers: { 'Content-Type': 'application/json' }
});
```

## Progress Tracking System

The application includes a real-time progress tracking system for summarization tasks.

### Progress Structure

Progress information is structured as:

```javascript
const progress = {
  startTime: Date.now(),       // When processing began
  phase: 'initializing',       // Current processing phase
  percent: 0,                  // Completion percentage (0-100)
  estimatedTimeRemaining: 10000 // Milliseconds remaining (estimated)
};
```

### Progress Phases

Standard phases for tracking progress:

- `initializing`: Initial setup, preparing to process
- `connecting`: Connecting to the AI provider
- `sending-request`: Sending the API request
- `processing`: AI is processing the content
- `receiving-response`: Getting results from the API
- `finalizing`: Preparing the final response
- `complete`: Processing is complete

### Tracking Progress

To track progress during a long-running operation:

1. Set up tracking at the start of the process:
```javascript
setupProgressTracking(url);
```

2. Update the progress at key points in your code:
```javascript
updateProgress(url, 'processing', 50);
```

3. Clean up when finished:
```javascript
cleanupProgressTracking(url);
```

### Broadcasting Progress

Progress updates are automatically broadcast to all connected clients. The front-end can listen for these events:

```javascript
navigator.serviceWorker.addEventListener('message', event => {
  if (event.data.action === 'summaryProgress') {
    // Handle progress update
    updateProgressDisplay(event.data.progress);
  }
});
```

## Adding Support for New AI Providers

To add support for a new AI provider:

1. Add rate limit configuration:
```javascript
const RATE_LIMITS = {
  // Existing providers...
  newProvider: {
    maxRequests: 10,
    windowMs: 60 * 1000,
  }
};
```

2. Add the API call implementation in the `getSummary` function:
```javascript
else if (config.provider === 'newProvider') {
  // Update progress
  updateProgress(url, 'connecting', 10);
  
  // Make API call
  aiResponse = await fetchWithRetry('https://api.newprovider.com/v1/completion', {
    // Custom request configuration...
  });
  
  // Record the API call for rate limiting
  recordApiCall('newProvider');
  
  updateProgress(url, 'processing', 50);
  
  // Process response...
  
  updateProgress(url, 'receiving-response', 75);
  
  // Extract summary text...
}
```

3. Update the landing page to include the new provider option.

## Testing Changes

When making changes, test the following scenarios:

1. **Single article summarization**: Test progress tracking and error handling
2. **Batch processing**: Verify the queue system works correctly
3. **Error scenarios**: Test different error types (network errors, API issues)
4. **Cache behavior**: Verify caching and cache clearing
5. **Offline mode**: Test functionality when offline

## Code Style Guidelines

- Use clear and descriptive variable and function names
- Comment complex code sections
- Use ES6+ features when appropriate
- Follow functional programming principles when possible
- Maintain backward compatibility with existing browser storage

## Maintainability Best Practices

1. Keep the application serverless to minimize maintenance
2. Use progressive enhancement for new features
3. Maintain comprehensive error handling
4. Update documentation when adding features
5. Minimize external dependencies
