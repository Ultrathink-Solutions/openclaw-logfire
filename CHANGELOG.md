# Changelog

All notable changes to `@ultrathink/openclaw-logfire` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-15

### Added

- Initial release
- Full agent lifecycle tracing with OTEL GenAI semantic conventions
- `invoke_agent` root spans with agent name, session key, workspace, and channel attribution
- `execute_tool` child spans with tool arguments, duration, and result size
- Error tracing with OTEL exception events (type, message, stack trace)
- Token usage metrics (`gen_ai.client.token.usage` histogram)
- Operation duration metrics (`gen_ai.client.operation.duration` histogram)
- Pydantic Logfire OTLP HTTP export (US and EU regions)
- Clickable Logfire trace URLs in agent logs
- Secret redaction for API keys, platform tokens, JWTs, and credentials
- W3C traceparent injection into HTTP commands for distributed tracing
- W3C trace context extraction from inbound webhook headers
- Configurable trace depth (tool input/output capture, message content, inference events)
- Batch and simple span processor modes
- Zero-config quickstart (just set `LOGFIRE_TOKEN`)

[0.1.0]: https://github.com/Ultrathink-Solutions/openclaw-logfire/releases/tag/v0.1.0
