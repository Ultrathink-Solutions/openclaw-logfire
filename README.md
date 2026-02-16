# @ultrathink-solutions/openclaw-logfire

[![npm version](https://img.shields.io/npm/v/@ultrathink-solutions/openclaw-logfire)](https://www.npmjs.com/package/@ultrathink-solutions/openclaw-logfire)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Pydantic [Logfire](https://pydantic.dev/logfire) observability plugin for [OpenClaw](https://openclaw.ai).

Full agent lifecycle tracing aligned with [OTEL GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) — tool calls, token metrics, error stack traces, and optional distributed tracing across services.

> **Real-world context:** We built this plugin as part of deploying OpenClaw into production on the [Ultrathink Axon platform](https://ultrathinksolutions.com/the-signal/openclaw-to-production/). The architecture and design decisions are detailed in that post.

## Quickstart

```bash
npm install @ultrathink-solutions/openclaw-logfire
```

Set your Logfire write token:

```bash
export LOGFIRE_TOKEN="your-token"
```

Add to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-logfire": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

Restart OpenClaw. That's it — traces appear in your Logfire dashboard.

## What You Get

### Span Hierarchy

Every agent invocation produces a trace tree:

```
invoke_agent my-agent                (root span, cumulative tokens)
  |-- gen_ai.chat anthropic          (LLM call: model, input/output tokens)
  |-- execute_tool Read              (file read)
  |-- execute_tool exec              (shell command)
  |-- gen_ai.chat anthropic          (LLM call: model, input/output tokens)
  |-- execute_tool Write             (file write)
  |-- gen_ai.chat anthropic          (LLM call: model, input/output tokens)
```

### Attributes (OTEL GenAI Semantic Conventions)

| Attribute | Span | Example | Description |
|-----------|------|---------|-------------|
| `gen_ai.operation.name` | All | `invoke_agent` | Operation type |
| `gen_ai.agent.name` | Agent | `my-agent` | Agent identifier |
| `gen_ai.conversation.id` | Agent | `session_abc123` | Session key |
| `gen_ai.request.model` | Agent, LLM | `claude-sonnet-4-5-20250929` | Model name |
| `gen_ai.response.model` | Agent, LLM | `claude-sonnet-4-5-20250929` | Response model |
| `gen_ai.provider.name` | Agent, LLM | `anthropic` | LLM provider |
| `gen_ai.usage.input_tokens` | Agent, LLM | `1024` | Input tokens (cumulative on agent) |
| `gen_ai.usage.output_tokens` | Agent, LLM | `512` | Output tokens (cumulative on agent) |
| `openclaw.usage.cache_read_tokens` | Agent, LLM | `8192` | Cached prompt tokens read |
| `openclaw.usage.cache_write_tokens` | Agent, LLM | `4096` | Cached prompt tokens written |
| `gen_ai.tool.name` | Tool | `Read` | Tool being called |
| `gen_ai.tool.call.id` | Tool | `call_abc123` | Unique tool call identifier |
| `gen_ai.tool.call.arguments` | Tool | `{"path": "/..."}` | Tool input (opt-in) |
| `error.type` | Agent | `AgentError` | Error classification |
| `openclaw.workspace` | Agent | `my-agent` | Workspace name |
| `openclaw.channel` | Agent | `slack` | Message source |

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `gen_ai.client.token.usage` | Histogram | Token counts by type (input/output) |
| `gen_ai.client.operation.duration` | Histogram | Agent invocation latency (seconds) |

### Error Tracing

Agent-level errors are captured on the root `invoke_agent` span with `error.type` and error status. Errors from tool failures propagate up so the agent span is marked as errored.

## Configuration

All settings are optional. Sensible defaults work out of the box.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-logfire": {
        "enabled": true,
        "config": {
          // Logfire project (enables clickable trace links in logs)
          "projectUrl": "https://logfire.pydantic.dev/myorg/myproject",
          "region": "us",           // "us" or "eu"
          "environment": "production",
          "serviceName": "openclaw-agent",

          // GenAI provider name for OTEL compliance
          "providerName": "anthropic",

          // Trace depth controls
          "captureToolInput": true,       // Record tool arguments
          "captureToolOutput": false,     // Record tool results (verbose)
          "toolInputMaxLength": 2048,     // Truncation limit
          "captureStackTraces": true,     // Stack traces on errors
          "captureMessageContent": false, // Record message text (privacy)
          "redactSecrets": true,          // Strip API keys from tool args

          // Distributed tracing (opt-in)
          "distributedTracing": {
            "enabled": false,
            "urlPatterns": ["https://api.mycompany.com/*"]
          },

          // Metrics
          "enableMetrics": true,

          // Trace links
          "enableTraceLinks": true
        }
      }
    }
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `LOGFIRE_TOKEN` | Logfire write token (required) |
| `LOGFIRE_ENVIRONMENT` | Deployment environment fallback |
| `LOGFIRE_PROJECT_URL` | Project URL fallback |
| `LOGFIRE_PROVIDER_NAME` | Provider name fallback |

### Secret Redaction

When `redactSecrets: true` (default), the plugin strips values matching common patterns before recording tool arguments:

- API keys (`api_key: sk_live_...`)
- Platform tokens (`ghp_`, `gho_`, `glpat_`, `xoxb-`, etc.)
- JWTs (`eyJ...`)
- Bearer tokens, passwords, credentials

## Distributed Tracing

Connect OpenClaw traces to your backend services. When enabled, the plugin injects `traceparent` headers into HTTP calls made by exec/Bash tools.

```jsonc
{
  "distributedTracing": {
    "enabled": true,
    "injectIntoCommands": true,      // Add traceparent to curl/wget/httpie
    "extractFromWebhooks": true,     // Extract traceparent from inbound webhooks
    "urlPatterns": [                 // Only inject for matching URLs
      "https://api.mycompany.com/*",
      "http://localhost:8000/*"
    ]
  }
}
```

This produces connected traces across services:

```
OpenClaw: invoke_agent my-agent
  |-- execute_tool exec (curl POST /api/data)
       |-- [Your Backend] POST /api/data
            |-- database query
            |-- downstream service call
```

Your backend must support W3C trace context extraction (most frameworks do: FastAPI with Logfire, Express with OTEL, etc.).

## Architecture

```
openclaw-logfire/src/
  index.ts              Plugin entry point + hook wiring
  config.ts             Typed configuration with defaults
  otel.ts               OTEL SDK initialization (Logfire OTLP)
  hooks/
    before-agent-start  invoke_agent span creation
    llm-input           gen_ai.chat span creation (per LLM call)
    llm-output          LLM span close + token metrics + accumulation
    before-tool-call    execute_tool span + context propagation
    tool-result-persist Tool span close + result capture
    agent-end           Span close + cumulative tokens + metrics
    message-received    Channel attribution + inbound context
  context/
    span-store          Session -> active spans (LIFO tool stack, LLM spans)
    propagation         W3C traceparent inject/extract
  metrics/
    genai-metrics       Token usage + operation duration histograms
  events/
    inference-details   Opt-in inference operation event
```

### OpenClaw Hooks Used

| Hook | Purpose |
|------|---------|
| `before_agent_start` | Create root `invoke_agent` span |
| `llm_input` | Create `gen_ai.chat` child span per LLM call |
| `llm_output` | Close LLM span, record token usage metrics |
| `before_tool_call` | Create `execute_tool` child span |
| `tool_result_persist` | Close tool span, record result size |
| `agent_end` | Close spans, set cumulative tokens, emit metrics |
| `message_received` | Enrich with channel info |

Requires OpenClaw >= 2026.2.1 (`before_tool_call` and `llm_input`/`llm_output` hooks).

## Development

```bash
git clone https://github.com/Ultrathink-Solutions/openclaw-logfire
cd openclaw-logfire
npm install
npm run typecheck
npm test
```

### Local testing with OpenClaw

```bash
# Symlink into OpenClaw extensions
ln -s $(pwd) ~/.openclaw/extensions/openclaw-logfire

# Or add to openclaw.json
# "plugins": { "load": { "paths": ["./path/to/openclaw-logfire"] } }

export LOGFIRE_TOKEN="your-write-token"
openclaw restart
openclaw plugins list  # Should show "openclaw-logfire" as enabled
```

## Built By

[Ultrathink Solutions](https://ultrathinksolutions.com) — production-grade AI agent infrastructure. We help teams close the gap between AI demos and production systems.

- [We Put OpenClaw Into Production in a Weekend](https://ultrathinksolutions.com/the-signal/openclaw-to-production/) — the architecture behind this plugin
- [The AI Execution Gap](https://ultrathinksolutions.com/the-signal/ai-execution-gap/) — why most AI projects stall between POC and production

## License

MIT
