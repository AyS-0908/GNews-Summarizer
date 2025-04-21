# Changelog

All notable changes to the GNews-Summarizer project will be documented in this file.

## [Unreleased]

## [0.2.0] - 2025-04-21

### Added

#### Core Stability Improvements
- **API Key Recovery Mechanism**: Added recovery PIN system that allows users to recover their API keys when changing devices or browsers
- **Service Worker Initialization Check**: Added visual status indicator showing service worker state
- **Rate Limiting Protection**: Implemented client-side throttling for API requests to avoid rate limits

#### User Feedback Enhancements
- **Enhanced Error Handling**:
  - Added comprehensive error classification system with 14 specific error types
  - Implemented severity levels (temporary, fixable, critical) for better user guidance
  - Added detailed troubleshooting steps for each error type
  - Created visual distinction between different error severities
  - Improved error recovery options based on error type
- **Progress Indicators for Single Summaries**: 
  - Added real-time progress tracking during summarization
  - Implemented estimated time remaining calculation
  - Created progress phase indicators (connecting, sending request, processing, etc.)
  - Added visual animations (progress bar, pulsing dot) for better feedback

### Changed
- Improved error messages with more specific information and actionable steps
- Enhanced batch processing to handle rate limits more gracefully
- Upgraded service worker communication for better progress tracking

### Fixed
- Fixed potential race conditions in service worker communication
- Improved handling of network errors with better retry logic
- Enhanced error recovery for API request failures

## [0.1.0] - Initial Release

- Basic PWA functionality
- Article summarization with OpenAI, Anthropic, and DeepSeek
- Queue mode for batch processing
- Basic caching system
- Device-specific API key encryption
