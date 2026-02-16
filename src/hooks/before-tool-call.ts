// SPDX-License-Identifier: MIT
/**
 * Hook: before_tool_call
 *
 * Creates an `execute_tool` child span for each tool invocation,
 * following OTEL GenAI semantic conventions.  Optionally injects
 * W3C traceparent into HTTP commands for distributed tracing.
 */

import { trace, SpanKind } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import {
  generateCallId,
  prepareForCapture,
  safeJsonStringify,
} from '../util.js';
import { injectTraceContext } from '../context/propagation.js';
import type { LogfirePluginConfig } from '../config.js';

/** OpenClaw before_tool_call event payload. */
export interface BeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
}

/** OpenClaw tool call hook context (2nd argument). */
export interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
}

export function handleBeforeToolCall(
  event: BeforeToolCallEvent,
  ctx: ToolContext,
  config: LogfirePluginConfig,
): void {
  const sessionKey =
    typeof ctx.sessionKey === 'string' && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : undefined;
  if (!sessionKey) return;
  const session = spanStore.get(sessionKey);
  if (!session) return;

  const tracer = trace.getTracer('@ultrathink-solutions/openclaw-logfire', '0.1.0');
  const toolName =
    typeof ctx.toolName === 'string' && ctx.toolName.length > 0
      ? ctx.toolName
      : typeof event.toolName === 'string' && event.toolName.length > 0
        ? event.toolName
        : 'unknown';
  const callId = generateCallId();

  session.toolSequence++;

  // Span name per spec: "execute_tool {gen_ai.tool.name}"
  const spanName = `execute_tool ${toolName}`;

  const attributes: Record<string, string | number | boolean> = {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': toolName,
    'gen_ai.tool.call.id': callId,
    'gen_ai.tool.type': 'function',
    'openclaw.tool.sequence': session.toolSequence,
  };

  // Opt-in: capture tool arguments
  if (config.captureToolInput && event.params !== undefined) {
    attributes['gen_ai.tool.call.arguments'] = prepareForCapture(
      event.params,
      config.toolInputMaxLength,
      config.redactSecrets,
    );
    attributes['openclaw.tool.input_size'] =
      safeJsonStringify(event.params).length;
  }

  const toolSpan = tracer.startSpan(
    spanName,
    { kind: SpanKind.INTERNAL, attributes },
    session.agentCtx,
  );

  const toolCtx = trace.setSpan(session.agentCtx, toolSpan);

  spanStore.pushTool(sessionKey, {
    span: toolSpan,
    ctx: toolCtx,
    name: toolName,
    callId,
    startTime: Date.now(),
  });

  // Distributed tracing: inject traceparent into HTTP calls
  if (
    config.distributedTracing.enabled &&
    config.distributedTracing.injectIntoCommands &&
    event.params !== undefined
  ) {
    injectTraceContext(event, toolSpan, config.distributedTracing.urlPatterns);
  }
}
