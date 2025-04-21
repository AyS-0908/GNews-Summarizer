# GNews Summarizer

A Progressive Web App that integrates with Android's Share sheet to forward shared news articles to an AI API for summarization.

## Setup Instructions

1. Choose your AI API provider (OpenAI, Claude, DeepSeek, etc.)
2. Configure your API key and model via the setup page
3. Install on Android via Chrome's "Add to Home screen" option
4. Start sharing articles from Google News!

## Supported AI APIs

The app includes ready-to-use code for:
- OpenAI GPT-4 or GPT-3.5-turbo
- Anthropic Claude API
- DeepSeek Chat

## Features

- Appears in Android's share sheet
- Directly calls AI APIs for summarization
- Displays AI-generated summaries with loading indicators
- Smart caching system for instant loading of previously summarized articles
- Batch processing mode for multiple articles
- Visual progress tracking for batch summarization
- Comprehensive error handling with retry capabilities
- Device-binding encryption for API key security
- Intelligent error classification and user-friendly messages
- 100% static, serverless architecture
- No middleware required (direct API calls)

## Using It

### Single Article Mode
1. In Google News / Discover, share any article
2. Pick "Summarise with AI" from your share options
3. The progress spinner appears while summarization is in progress
4. View the summary when processing completes
5. Future shares of the same article will load instantly from cache!

### Batch Mode
1. Enable "Queue Mode" in the main interface
2. Share multiple articles from Google News / Discover
3. Articles will be added to your queue instead of processed immediately
4. Click "Summarize Queue" to process all queued articles
5. Track progress with the visual progress bar
6. View all summaries when processing completes
7. Cached articles will show a "From Cache" indicator

### Cache Management
- Summaries are automatically cached for 24 hours
- Cached summaries load instantly without using API credits
- Look for the "From Cache" badge on summaries loaded from cache
- Use the "Clear Cached Summaries" button to remove all cached content
- Cache is used automatically for both single and batch modes

### Error Handling
- Network issues: The app will automatically retry temporary network failures
- API rate limits: Clearly identifies rate limit errors with helpful guidance
- Authentication issues: Provides clear instructions when API keys are invalid
- Retry capability: Failed summaries can be re-queued with a single click

## API Key Security

The app implements multiple layers of security to protect your API keys:

### Device-Binding Encryption
- API keys are encrypted with a device-specific signature
- The encryption key is derived from your device's unique characteristics including:
  - Browser fingerprint
  - Screen resolution
  - Language settings
  - Domain information
  - Hardware details
- The key can only be decrypted on the same device where it was configured
- Even if your browser data is somehow accessed, the encrypted key is useless on other devices

### Security Benefits
- Zero server dependency: No backend server needed
- Persistent security: API key remains available after browser restarts
- Device-locked: API key can't be used on other devices even if copied
- No re-entry needed: You don't need to re-enter your API key for each session

The security settings page shows the current encryption status and information about your configuration.

## Performance Optimization

The app uses several strategies to optimize performance:

### Smart Caching
- Summaries are cached locally using the Cache API
- Reduces API usage and costs by avoiding duplicate requests
- Dramatically improves load times for previously visited articles
- Cache is automatically managed with version control
- 24-hour expiration to ensure fresh content when needed

### Resource Optimization
- Static assets are cached for offline use
- Service worker provides offline capabilities
- Minimal network requests through cache-first strategy
- Efficient error handling with exponential backoff retry

## Troubleshooting

Common issues and solutions:

- **"API Key Invalid"**: Verify your API key is correct and active in your provider's dashboard
- **"Rate Limit Exceeded"**: Wait a few minutes and try again, or switch to a different AI provider
- **"Network Error"**: Check your internet connection and try again
- **"Invalid URL"**: Ensure you're sharing from a supported news source
- **Cache Issues**: Try clearing the cache using the "Clear Cached Summaries" button

## Future Plans

Features planned for upcoming versions:

- Freemium model (50 free summaries, then one-time fee)
- Google Sheets integration for saving summaries
- Customizable summary length options
- Configuration for user-provided AI providers
- Adjustable cache duration settings
