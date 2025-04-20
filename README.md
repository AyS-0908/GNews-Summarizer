# GNews Summarizer

A Progressive Web App that integrates with Android's Share sheet to forward shared news articles to an AI API for summarization.

## Setup Instructions

1. Choose your AI API provider (OpenAI, Claude, DeepSeek, etc.)
2. Update the `AI_API_ENDPOINT` and `AI_API_KEY` in `sw.js` with your credentials
3. Uncomment the corresponding code block for your chosen API provider
4. Deploy to GitHub Pages
5. Install on Android via Chrome's "Add to Home screen" option

## Supported AI APIs

The service worker includes ready-to-use code for:
- OpenAI GPT-4 or GPT-3.5-turbo
- Anthropic Claude API
- DeepSeek Chat

## Features

- Appears in Android's share sheet
- Directly calls AI APIs for summarization
- Displays AI-generated summaries
- 100% static, serverless architecture
- No middleware required (direct AI API calls)

## Using It

1. In Google News / Discover, share any article
2. Pick "Summarise with AI" from your share options
3. The service worker sends the URL to your chosen AI API
4. View the summary instantly in the mini-page

## Note
Make sure to keep your API keys secure. For production use, consider implementing additional security measures like rate limiting or using a backend service to protect your API keys.
