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
- Batch processing mode for multiple articles
- Visual progress tracking for batch summarization
- Comprehensive error handling with retry capabilities
- Intelligent error classification and user-friendly messages
- 100% static, serverless architecture
- No middleware required (direct API calls)

## Using It

### Single Article Mode
1. In Google News / Discover, share any article
2. Pick "Summarise with AI" from your share options
3. The progress spinner appears while summarization is in progress
4. View the summary when processing completes

### Batch Mode
1. Enable "Queue Mode" in the main interface
2. Share multiple articles from Google News / Discover
3. Articles will be added to your queue instead of processed immediately
4. Click "Summarize Queue" to process all queued articles
5. Track progress with the visual progress bar
6. View all summaries when processing completes

### Error Handling
- Network issues: The app will automatically retry temporary network failures
- API rate limits: Clearly identifies rate limit errors with helpful guidance
- Authentication issues: Provides clear instructions when API keys are invalid
- Retry capability: Failed summaries can be re-queued with a single click

## API Key Security

To protect your API keys while using this client-side application:

1. **Domain Restriction (Recommended)**: Configure your API keys to only work from this app's domain
   - For OpenAI: Add domain restriction in the API key settings
   - For Anthropic: Set "Restrict to one website" when creating the key
   - For DeepSeek: Add domain restriction during key creation

2. **Security Benefits**:
   - Even if your API key is somehow exposed, it can't be used from other domains
   - No backend server needed - zero maintenance cost while maintaining security
   - Direct API communication for maximum performance

The setup page includes detailed instructions for configuring domain restrictions for each supported AI provider.

## Troubleshooting

Common issues and solutions:

- **"API Key Invalid"**: Verify your API key is correct and active in your provider's dashboard
- **"Rate Limit Exceeded"**: Wait a few minutes and try again, or switch to a different AI provider
- **"Network Error"**: Check your internet connection and try again
- **"Invalid URL"**: Ensure you're sharing from a supported news source

## Future Plans

Features planned for upcoming versions:

- Freemium model (50 free summaries, then one-time fee)
- Google Sheets integration for saving summaries
- Customizable summary length options
- Configuration for user-provided AI providers
