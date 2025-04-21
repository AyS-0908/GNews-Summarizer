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
- 100% static, serverless architecture
- No middleware required (direct API API calls)

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

## Note
Make sure to keep your API keys secure. For best security, configure your API key with domain restrictions to only work from your app's domain.
