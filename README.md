# deepseek-web-api

**Language: English · [中文](README.zh.md)**

[![CI](https://github.com/kittors/deepseek-web-api/actions/workflows/ci.yml/badge.svg)](https://github.com/kittors/deepseek-web-api/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Wraps an authenticated `chat.deepseek.com` web session into a local **OpenAI-compatible API**, with Responses API, Chat Completions, streaming reasoning/output, multi-turn sessions, Chrome/CDP login state, and prompt-based tool calling.

> An unofficial local OpenAI-compatible API for authenticated DeepSeek Web sessions. Text-only, GitHub-first, and designed for Pi and other OpenAI-compatible clients.

> [!WARNING]
> **Unofficial project.** This project calls DeepSeek Web's private endpoints and is not affiliated with DeepSeek or OpenAI. The Web API, login, PoW, risk control, and frontend workers may change at any time and may lead to account restrictions. By default it only listens on `127.0.0.1`; do not expose the service directly to the public internet. Before using it, review the terms of service, applicable law, and account risk yourself.

## Features

- `POST /v1/responses`: streaming/non-streaming Responses compatibility layer
- `POST /v1/chat/completions`: streaming/non-streaming Chat Completions compatibility layer
- `GET /v1/models`, `GET /health`
- Auto-connects to CDP or launches a dedicated Chrome/Chromium profile
- Reuses and refreshes `userToken` + cookies; persists owner-only `auth.json`
- Solves the DeepSeek Web PoW challenge/worker
- `THINK` → Responses reasoning / Chat `reasoning_content`
- `RESPONSE` → Responses output text / Chat content
- API key protects all `/v1/*` routes
- DeepSeek session and `parent_message_id` persistence; switching flash/pro or thinking does not force a branch
- Prompt compatibility for system/developer/AGENTS/skills, tool schemas, and assistant/tool history
- Text tool protocol → Chat `tool_calls` / Responses `function_call`
- Pi `openai-completions` and `openai-responses` config examples
- **Built-in No-Ban Bouncer** anti-ban middleware with a runtime admin API (see [Anti-Ban Configuration](#anti-ban-configuration))

## Prerequisites

- Node.js 20 or higher
- pnpm 10
- Google Chrome or Chromium
- Access to and a login for `https://chat.deepseek.com`

## Quick start

```bash
git clone https://github.com/kittors/deepseek-web-api.git
cd deepseek-web-api
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Default address:

```text
http://127.0.0.1:8787
```

First-start flow:

1. Try validating `data/auth.json`; if valid, no browser is opened.
2. Otherwise connect to `DS_CDP` (default `http://127.0.0.1:9333`).
3. If the default local CDP is unavailable, launch a dedicated Chrome at `data/chrome-profile/`.
4. If not logged in, a visible window opens and waits for you to complete the DeepSeek login.
5. After successful login verification, `data/auth.json` is written atomically, then the HTTP service starts.
6. Daily PoW/browser work is headless by default; `DS_SHOW_BROWSER=1` shows the window.

You can also complete login explicitly first:

```bash
pnpm login
```

Read or generate the local API key for the first time:

```bash
cat data/.api-key
```

## API examples

```bash
API_KEY="$(cat data/.api-key)"
```

### Responses API

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer ***" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "input": "Explain TypeScript in three sentences",
    "reasoning": {"effort": "medium"}
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer ***" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-v4-pro",
    "input": "Prove that the square root of 2 is irrational",
    "stream": true
  }'
```

Responses `output` can contain `reasoning`, assistant `message`, and `function_call`. See [docs/responses-api.md](docs/responses-api.md) for event ordering, `previous_response_id`, and support boundaries.

### Chat Completions

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "x-api-key: *** \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [
      {"role": "system", "content": "Keep answers brief."},
      {"role": "user", "content": "Hello"}
    ]
  }'
```

Normal answers are in `choices[0].message.content`; thinking is in the compatibility field `reasoning_content`. See [docs/api.md](docs/api.md) for the full field set and limits.

## Anti-Ban Configuration

This fork bundles a **No-Ban Bouncer** middleware (`src/anti-ban/`) in front of the completion endpoints. It paces early traffic, caps daily volume, trips a circuit breaker on repeated auth failures, and holds requests while the upstream status page reports degradation. It does not modify your credentials or session.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `DS_ANTIBAN_WARMUP_REQUESTS` | `10` | Number of early completions to pace |
| `DS_ANTIBAN_WARMUP_MIN_DELAY` | `90` | Minimum seconds between warm-up completions |
| `DS_ANTIBAN_WARMUP_MAX_DELAY` | `180` | Maximum seconds between warm-up completions (linear ramp from min to max) |
| `DS_ANTIBAN_AUTH_FAIL_LIMIT` | `3` | Consecutive auth-level failures that open the circuit breaker |
| `DS_ANTIBAN_CIRCUIT_COOLDOWN` | `3600` | Seconds the breaker stays open |
| `DS_ANTIBAN_DAILY_CAP` | `150` | Max completions per UTC day |
| `DS_ANTIBAN_OUTAGE_POLL_INTERVAL` | `300` | Seconds between upstream status checks |
| `DS_ANTIBAN_STATUS_URL` | `https://status.deepseek.com/api/v2/status.json` | Upstream status endpoint |
| `DS_ANTIBAN_SESSION_REUSE` | `true` | Continue one conversation thread for sequential requests |

### Admin API

Inspect and change settings at runtime without restarting:

```bash
# Current config + live status (circuit state, completions today, warm-up remaining, provider status)
curl http://127.0.0.1:8787/admin/antiban

# Partial update; only the fields you send change
curl -X POST http://127.0.0.1:8787/admin/antiban \
  -H 'Content-Type: application/json' \
  -d '{"dailyCap": 200, "warmupRequests": 5}'
```

When a gate trips, completion endpoints return:

| Status | Meaning |
| --- | --- |
| `503` | Circuit breaker open or upstream hold active (includes `retry_after` seconds) |
| `429` | Daily cap reached (resets at UTC midnight) |

`GET /v1/models` and `GET /health` are never gated.

## Model & feature mapping

| Public model ID | DeepSeek Web `model_type` | Search |
| --- | --- | --- |
| `deepseek-v4-flash` | `default` | Supported |
| `deepseek-v4-pro` | `expert` | Not supported on the web side; server forces it off |

Compatibility aliases:

- flash: `flash`, `default`, `deepseek-chat`
- pro: `pro`, `expert`, `deepseek-reasoner`

DeepSeek Web only provides `thinking_enabled: boolean`. `none`/`off`/`0`/`false`/`disabled` map to off; any other `reasoning.effort` or thinking level maps to on.

Web search can be enabled with `search_enabled: true`, `web_search: true`, or a tool of type `web`/`search`; it only works on flash.

## Pi integration

Prefer Pi's `api: "openai-completions"` first:

```json
{
  "providers": {
    "deepseek-web": {
      "baseUrl": "http://127.0.0.1:8787/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_WEB_API_KEY",
      "compat": {
        "supportsDeveloperRole": true,
        "supportsReasoningEffort": true,
        "supportsUsageInStreaming": false,
        "supportsStore": false
      },
      "models": [
        {"id": "deepseek-v4-flash", "reasoning": true, "input": ["text"]},
        {"id": "deepseek-v4-pro", "reasoning": true, "input": ["text"]}
      ]
    }
  }
}
```

For the Responses path, thinking levels, AGENTS.md/skills, MCP-backed tools, tool-call history, and multi-turn behavior, see **[docs/pi.md](docs/pi.md)**. That document provides two complete copy-paste `models.json` configurations.

## Multi-turn sessions

Three ways to continue the same conversation:

1. Return the `previous_response_id` this service returned;
2. Return `conversation` / `chat_session_id`;
3. Send the full stable history (like Pi does) and let the `SessionStore` match it.

The server keeps the DeepSeek session and the last trusted `response_message_id`. When you switch the public model or the thinking toggle, the same DeepSeek session continues as long as the history or an explicit ID matches.

> Concurrent writes within one session are not supported. Parallel requests may reuse the same parent and branch upstream.

## Tool calling notes

DeepSeek Web has no native OpenAI function calling. This project writes the tools/functions and selection policy into the prompt and requires the model to output:

```text
<tool_call>
{"name":"tool_name","arguments":{"key":"value"}}
</tool_call>
```

Once parsed successfully it maps to the standard structure. Tool-result rounds also enter session/history matching.

This is still **prompt emulation**: it does not guarantee the model will call tools, strictly follow JSON Schema, or parallel-call correctly. Streaming requests with tools may emit the structured calls in a burst at the tail, because the service must strip the protocol text first.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP listen address; not recommended to change to a public address |
| `PORT` | `8787` | HTTP port |
| `DS_CDP` | `http://127.0.0.1:9333` | Chrome DevTools Protocol endpoint |
| `DS_DATA_DIR` | `./data` | Root for runtime credentials, sessions, and profile |
| `DS_API_KEY` | empty | One or more API keys, comma/whitespace separated; takes precedence over the file |
| `DS_API_KEY_FILE` | `data/.api-key` | API key file, one per line |
| `DS_AUTH_FILE` | `data/auth.json` | DeepSeek token/cookie snapshot |
| `DS_SESSION_FILE` | `data/sessions.json` | Session lineage index |
| `DS_CHROME_PROFILE` | `data/chrome-profile` | Dedicated Chrome profile |
| `DS_CHROME_PATH` | auto-discovered | Chrome/Chromium executable |
| `DS_SHOW_BROWSER` | `false` | Show the browser for daily requests; always visible when login needs it |
| `DS_POW_JS` | built-in current worker URL | DeepSeekHashV1 worker chunk URL |
| `DS_BASE_URL` | `https://chat.deepseek.com` | Upstream URL, mainly for debugging |
| `DS_DEBUG` | `false` | Extra debug logs and HTTP error stacks |
| `DS_TOOL_REASONING` | `hidden` | Tool-round reasoning: `hidden` or `clean` |

You can copy `.env.example` to `.env`. The file is read at startup, but it does not override existing process environment variables.

## Security

The following paths contain credentials or private session content and are excluded by `.gitignore`:

```text
.env
data/auth.json
data/.api-key
data/sessions.json
data/chrome-profile/
```

- Never commit, upload, package, screenshot, or paste these contents.
- Keep loopback listening; an API key is not a sufficient public-network security boundary.
- If you must allow cross-host access, use a controlled network, a TLS reverse proxy, origin restrictions, and separate key rotation.
- An auth-data leak is equivalent to leaking the DeepSeek login session.

See [SECURITY.md](SECURITY.md) for security disclosure and account risk.

## Documentation

- [Architecture & request flow](docs/architecture.md)
- [API compatibility matrix](docs/api.md)
- [Responses API events & objects](docs/responses-api.md)
- [Pi full integration guide](docs/pi.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Maintainer spec](SPEC.md)
- [Contributing guide](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Development & verification

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

CI runs the same checks on Node.js 20 and 22. Unit tests do not touch a real DeepSeek account, and login e2e is not started in CI.

Project constraints:

- TypeScript ESM, Node.js >= 20
- `node:http`; no heavy web framework
- Each `src/**/*.ts` file stays under 300 lines
- strict TypeScript; no `any` to bypass boundary types
- Protocol behavior changes require a minimal regression test

## Known limitations

- Depends on the private Web API, the frontend PoW worker, and account risk control; any of them may break without notice.
- Text only; no image, file, audio, video, or upload support.
- Tool calls are a prompt compatibility layer, not native function calling.
- OpenAI `store`, background Responses, strict structured output, hosted tools, and prompt caching are not implemented.
- Input tokens have no reliable upstream count and return `0`; output tokens use the upstream cumulative value.
- Concurrent requests on one session may fork.
- The anti-ban layer paces and caps your own traffic; it cannot guarantee immunity from upstream risk control, and the outage hold is bounded by the poll interval (no instant detection).

## Credits

- **Base project**: [kittors/deepseek-web-api](https://github.com/kittors/deepseek-web-api) — the OpenAI-compatible wrapper for DeepSeek Web sessions (MIT, © 2026 kittors). This fork builds on it and preserves its license.
- **Anti-ban layer**: [No-Ban Bouncer](https://github.com/tanvirbinzahid/No-Ban-Bouncer) — the configurable doorman middleware (warm-up pacing, circuit breaker, daily cap, outage hold) integrated here by [tanvirbinzahid](https://github.com/tanvirbinzahid).
- **Translations**: Chinese original by kittors; English translation by [tanvirbinzahid](https://github.com/tanvirbinzahid).

## Contributing

Focused issues/PRs are welcome. Before submitting, read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and make sure the full verification passes. Before reporting logs, remove all tokens, cookies, keys, accounts, and private paths.

## License

[MIT](LICENSE) © 2026 kittors
