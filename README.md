# code-router


```text
 ██████╗ ██████╗
██╔════╝ ██╔══██╗
██║      ██████╔╝  CODE
██║      ██╔══██╗  ROUTER
╚██████╗ ██║  ██║
 ╚═════╝ ╚═╝  ╚═╝
```

`code-router` lets you use Claude MAX and ChatGPT subscription auth behind local API endpoints that speak Anthropic, OpenAI, and OpenRouter-style model naming.

It has two modes:
- interactive terminal UI
- direct CLI commands like `serve`, `verify`, and `models`

> Personal and research use only.
> Do not use this project in ways that violate the Terms of Service or Terms and Conditions of Anthropic or OpenAI.
> You are responsible for how you authenticate, route, and use subscription-backed services.

## Install

Global install:

```bash
npm install -g @rizqme/code-router
```

Run without installing:

```bash
npx @rizqme/code-router
```

## Quick start

Open the interactive CLI:

```bash
code-router
```

Start the local router server:

```bash
code-router serve
```

Verify saved subscriptions:

```bash
code-router verify
```

List models:

```bash
code-router models
```

## Command overview

```bash
code-router
code-router serve [router flags]
code-router verify [--provider claude|openai|all] [--json]
code-router models [--provider claude|openai|openrouter|all] [--json]
code-router auth <claude|openai|status>
code-router logout <claude|openai|all>
code-router status [--json]
```

Examples:

```bash
code-router
code-router serve --port 3344 --verbose
code-router verify
code-router models --provider openrouter
code-router auth claude
code-router auth openai
code-router logout all
```

## Interactive vs non-interactive

Default behavior:
- if the terminal supports Ink, `code-router` opens the interactive TUI
- if the terminal does not support interactive mode, `code-router` falls back to text output

Force behavior:

```bash
code-router --interactive
code-router --no-interactive
```

If you force interactive mode in a non-interactive terminal, the command exits with an error.

## Authentication

Supported auth:
- Claude MAX OAuth
- ChatGPT OAuth

Ways to authenticate:
- use the interactive UI: `code-router`
- use direct commands:

```bash
code-router auth claude
code-router auth openai
code-router auth status
```

Stored credentials:
- Claude: `.oauth-tokens.json`
- ChatGPT: `.chatgpt-api-key.json`

Clear saved credentials:

```bash
code-router logout claude
code-router logout openai
code-router logout all
```

## Serving the local router

Start the server:

```bash
code-router serve
```

Pass router flags through directly:

```bash
code-router serve --port 8080
code-router serve --verbose
code-router serve --minimal
code-router serve --quiet
code-router serve --disable-bearer-passthrough
```

The local server exposes:
- `POST /v1/messages`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /health`

Default base URL:

```text
http://localhost:3344
```

OpenAI-compatible base URL:

```text
http://localhost:3344/v1
```

## Model listing

List all models:

```bash
code-router models
```

Filter by provider:

```bash
code-router models --provider claude
code-router models --provider openai
code-router models --provider openrouter
```

JSON output:

```bash
code-router models --json
```

`openrouter` output uses OpenRouter-style model ids such as:
- `openai/gpt-5.4`
- `anthropic/claude-sonnet-4-6`

## Subscription verification

Verify both subscriptions:

```bash
code-router verify
```

Verify one side only:

```bash
code-router verify --provider claude
code-router verify --provider openai
```

JSON output:

```bash
code-router verify --json
```

## Router behavior

The router supports both request formats:
- Anthropic-style requests
- OpenAI-style requests

It also supports OpenRouter-style model names on OpenAI-format paths.

Examples:
- `gpt-5.4`
- `claude-sonnet-4-6`
- `openai/gpt-5.4`
- `anthropic/claude-sonnet-4-6`

When only one subscription is available:
- Claude-family requests can be mapped to the latest GPT model
- GPT-family requests can be mapped to the latest Sonnet model

The `/v1/models` endpoint is served from in-memory cached model data when available.

## API examples

Anthropic-style request:

```bash
curl -X POST http://localhost:3344/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [
      {"role": "user", "content": "Reply with exactly: ok"}
    ]
  }'
```

OpenAI-style request:

```bash
curl -X POST http://localhost:3344/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      {"role": "user", "content": "Reply with exactly: ok"}
    ]
  }'
```

OpenRouter-style model name:

```bash
curl -X POST http://localhost:3344/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-6",
    "messages": [
      {"role": "user", "content": "Reply with exactly: ok"}
    ]
  }'
```

## Common commands

Show current status:

```bash
code-router status
```

Show JSON status:

```bash
code-router status --json
```

Start with `npx`:

```bash
npx code-router
npx code-router serve
npx code-router verify
```

## Notes

- `code-router` is designed for local use
- subscription-backed endpoints and auth flows can change over time
- if auth breaks, re-run:

```bash
code-router auth claude
code-router auth openai
```

## License

MIT

## Author

Ahmad Rizqi Meydiarso
