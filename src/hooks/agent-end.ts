// SPDX-License-Identifier: MIT
/**
 * Hook: agent_end
 *
 * Closes the invoke_agent span, records token usage and duration,
 * emits metrics, and logs the Logfire trace link.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import { buildLogfireTraceUrl } from '../trace-link.js';
import { recordOperationDuration } from '../metrics/genai-metrics.js';
import { extractWorkspaceName, extractErrorDetails } from '../util.js';
import type { LogfirePluginConfig } from '../config.js';
import type { AgentContext } from './before-agent-start.js';

/** OpenClaw agent_end event payload. */
export interface AgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

/** Logger interface — matches OpenClaw plugin api.logger shape. */
export interface Logger {
  info(msg: string): void;
  debug(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function handleAgentEnd(
  event: AgentEndEvent,
  ctx: AgentContext,
  config: LogfirePluginConfig,
  logger: Logger,
): void {
  const sessionKey =
    typeof ctx.sessionKey === 'string' && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0
        ? ctx.sessionId
        : undefined;
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  const durationMs =
    typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)
      ? event.durationMs
      : Date.now() - session.startTime;
  const durationS = durationMs / 1000;
  const agentName =
    typeof ctx.agentId === 'string' && ctx.agentId.length > 0
      ? ctx.agentId
      : 'agent';
  const workspace = extractWorkspaceName(
    typeof ctx.workspaceDir === 'string' ? ctx.workspaceDir : undefined,
  );

  // Close any remaining tool spans (shouldn't happen but safety net)
  // Reverse order: close children before parent (LIFO)
  for (let i = session.toolStack.length - 1; i >= 0; i--) {
    session.toolStack[i].span.end();
  }

  // Close any pending LLM spans (aborted mid-call)
  for (const llm of [...session.llmSpans.values()].reverse()) {
    llm.span.end();
  }

  // Duration and tool count
  session.agentSpan.setAttribute('openclaw.request.duration_ms', durationMs);
  session.agentSpan.setAttribute(
    'openclaw.request.tool_count',
    session.toolSequence,
  );

  // Cumulative token usage from llm_output hooks
  const { tokens } = session;
  if (tokens.input > 0 || tokens.output > 0) {
    session.agentSpan.setAttribute('gen_ai.usage.input_tokens', tokens.input);
    session.agentSpan.setAttribute('gen_ai.usage.output_tokens', tokens.output);
    if (tokens.cacheRead > 0) {
      session.agentSpan.setAttribute('openclaw.usage.cache_read_tokens', tokens.cacheRead);
    }
    if (tokens.cacheWrite > 0) {
      session.agentSpan.setAttribute('openclaw.usage.cache_write_tokens', tokens.cacheWrite);
    }
  }

  // Model/provider from LLM hooks (last seen values)
  if (session.model) {
    session.agentSpan.setAttribute('gen_ai.request.model', session.model);
    session.agentSpan.setAttribute('gen_ai.response.model', session.model);
  }
  if (session.provider) {
    session.agentSpan.setAttribute('gen_ai.provider.name', session.provider);
  }

  // Error status
  if (event.error || !event.success || session.hasError) {
    const errorType =
      event.error
        ? 'AgentError'
        : session.hasError
          ? 'ToolError'
          : 'Error';
    const errorMsg = event.error || 'Agent invocation failed';
    session.agentSpan.setAttribute('error.type', errorType);
    session.agentSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorMsg,
    });

    // Record structured exception per OTEL semantic conventions.
    // recordException() expects Error | string — construct a real Error instance.
    const errDetails = extractErrorDetails(event.error ?? errorMsg);
    const exception = new Error(errDetails.message);
    exception.name = errDetails.type;
    if (errDetails.stacktrace) exception.stack = errDetails.stacktrace;
    session.agentSpan.recordException(exception);
  } else {
    session.agentSpan.setStatus({ code: SpanStatusCode.OK });
  }

  // End the agent span
  session.agentSpan.end();

  // Record metrics
  if (config.enableMetrics) {
    const metricAttrs = {
      agentName,
      workspace,
      providerName: session.provider || config.providerName || 'unknown',
      requestModel: session.model || '',
      responseModel: session.model || '',
      hasError: !!(event.error || !event.success || session.hasError),
      errorType: event.error
        ? 'AgentError'
        : undefined,
    };

    recordOperationDuration(durationS, metricAttrs);
  }

  // Log trace link
  if (config.enableTraceLinks && config.projectUrl) {
    const traceId = session.agentSpan.spanContext().traceId;
    const url = buildLogfireTraceUrl(config.projectUrl, traceId);
    logger.info(`Logfire trace: ${url}`);
  }

  // Cleanup
  spanStore.delete(sessionKey);
}
