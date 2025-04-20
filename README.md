# GNews Summarizer

A Progressive Web App that integrates with Android's Share sheet to forward shared news articles to an n8n + GPT webhook for AI-powered summarization.

## Setup Instructions

1. Update the `N8N_ENDPOINT` in `sw.js` with your actual n8n webhook URL
2. Deploy to GitHub Pages
3. Install on Android via Chrome's "Add to Home screen" option

## Features

- Appears in Android's share sheet
- Forwards shared URLs to n8n webhook
- Displays AI-generated summaries
- 100% static, serverless architecture
