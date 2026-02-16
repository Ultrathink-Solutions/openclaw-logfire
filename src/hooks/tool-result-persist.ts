// SPDX-License-Identifier: MIT
/**
 * Hook: tool_result_persist (synchronous)
 *
 * Closes the most recent tool span, records result size, duration,
 * and any errors with full stack traces per OTEL exception conventions.
 *
 * This hook is synchronous — it MUST NOT return a Promise.
 * Return undefined to leave the result unmodified.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import {
  prepareForCapture,
  safeJsonStringify,
} from '../util.js';
import type { LogfirePluginConfig } from '../config.js';

/** OpenClaw tool_result_persist event payload. */
export interface ToolResultPersistEvent {
  toolName?: string;
  toolCallId?: string;
  message?: unknown;
  isSynthetic?: boolean;
}

/** OpenClaw tool result persist hook context (2nd argument). */
export interface ToolResultPersistContext {
  agentId?: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
}

export function handleToolResultPersist(
  event: ToolResultPersistEvent,
  ctx: ToolResultPersistContext,
  config: LogfirePluginConfig,
): void {
  const sessionKey =
    typeof ctx.sessionKey === 'string' && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : undefined;
  if (!sessionKey) return;
  const entry = spanStore.popTool(sessionKey);
  if (!entry) return;

  try {
    const durationMs = Date.now() - entry.startTime;
    entry.span.setAttribute('openclaw.tool.duration_ms', durationMs);

    // Result size (from the persisted message)
    if (event.message !== undefined) {
      const resultStr =
        typeof event.message === 'string'
          ? event.message
          : safeJsonStringify(event.message);
      entry.span.setAttribute('openclaw.tool.output_size', resultStr.length);

      // Opt-in: capture tool output
      if (config.captureToolOutput) {
        entry.span.setAttribute(
          'gen_ai.tool.call.result',
          prepareForCapture(
            event.message,
            config.toolOutputMaxLength,
            config.redactSecrets,
          ),
        );
      }
    }

    // Tool-level errors are not available in this hook's event payload.
    // Errors are captured at the agent level in agent_end via event.error/event.success.
    entry.span.setStatus({ code: SpanStatusCode.OK });
  } finally {
    entry.span.end();
  }
}
