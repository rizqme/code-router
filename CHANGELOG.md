# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.3] - 2026-03-15

### Fixed
- Preserved explicit Claude model IDs instead of remapping them to fallback models
- Fixed streamed tool-call translation for ChatGPT Codex and Anthropic responses
- Fixed Anthropic tool-call request translation for assistant tool use and tool results

### Added
- Added image-aware request translation for OpenAI, Anthropic, and Codex `/responses` paths
- Added verbose logging for normalized image blocks and provider request details

## [0.1.2] - 2026-03-15

### Added
- Initial public release
- Interactive Ink TUI
- Installable `code-router` CLI
- Non-interactive command mode with TTY fallback
- Local router server with Anthropic, OpenAI, and OpenRouter-style support
- Claude MAX OAuth flow
- ChatGPT OAuth flow
- Cached model listing and subscription verification commands
