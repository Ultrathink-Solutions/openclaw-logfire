// SPDX-License-Identifier: MIT
/**
 * Hook: llm_output
 *
 * Fires after each LLM API call with the response and token usage.
 * Closes the per-LLM-call span, records token metrics, accumulates
 * tokens on the session, and optionally emits inference detail events.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import { recordTokenUsage, type MetricAttributes } from '../metrics/genai-metrics.js';
import { emitInferenceDetailsEvent } from '../events/inference-details.js';
import { extractWorkspaceName, prepareForCapture } from '../util.js';
import type { LogfirePluginConfig } from '../config.js';
import type { LlmContext } from './llm-input.js';

/** OpenClaw llm_output event payload (minimal — only fields we use). */
export interface LlmOutputEvent {
  runId: string;
  provider: string;
  model: string;
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

/** Type guard for finite numbers (handles zero correctly). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function handleLlmOutput(
  event: LlmOutputEvent,
  ctx: LlmContext,
  config: LogfirePluginConfig,
): void {
  const sessionKey = ctx.sessionKey ?? ctx.sessionId;
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  // Update model/provider (may differ between calls, keep latest)
  session.model = event.model;
  session.provider = event.provider;

  const llmEntry = spanStore.deleteLlmSpan(sessionKey, event.runId);
  const usage = event.usage;

  // Accumulate tokens on the session (use numeric validation, not truthy)
  if (usage) {
    if (isFiniteNumber(usage.input)) session.tokens.input += usage.input;
    if (isFiniteNumber(usage.output)) session.tokens.output += usage.output;
    if (isFiniteNumber(usage.cacheRead)) session.tokens.cacheRead += usage.cacheRead;
    if (isFiniteNumber(usage.cacheWrite)) session.tokens.cacheWrite += usage.cacheWrite;
  }

  // Record token metrics
  if (config.enableMetrics && usage) {
    const agentName = ctx.agentId || 'agent';
    const workspace = extractWorkspaceName(ctx.workspaceDir);
    const metricAttrs: MetricAttributes = {
      agentName,
      workspace,
      providerName: event.provider,
      requestModel: event.model,
      responseModel: event.model,
      hasError: false,
    };
    if (isFiniteNumber(usage.input) && usage.input > 0) {
      recordTokenUsage(usage.input, 'input', metricAttrs);
    }
    if (isFiniteNumber(usage.output) && usage.output > 0) {
      recordTokenUsage(usage.output, 'output', metricAttrs);
    }
  }

  // Close the per-LLM-call span (always end in finally)
  if (llmEntry) {
    try {
      if (usage) {
        if (usage.input !== undefined) {
          llmEntry.span.setAttribute('gen_ai.usage.input_tokens', usage.input);
        }
        if (usage.output !== undefined) {
          llmEntry.span.setAttribute('gen_ai.usage.output_tokens', usage.output);
        }
        if (usage.cacheRead !== undefined) {
          llmEntry.span.setAttribute('openclaw.usage.cache_read_tokens', usage.cacheRead);
        }
        if (usage.cacheWrite !== undefined) {
          llmEntry.span.setAttribute('openclaw.usage.cache_write_tokens', usage.cacheWrite);
        }
      }

      llmEntry.span.setAttribute('gen_ai.response.model', event.model);

      // Opt-in: emit inference detail event on the LLM span
      if (config.captureInferenceEvents) {
        emitInferenceDetailsEvent(llmEntry.span, {
          model: event.model,
          inputTokens: usage?.input,
          outputTokens: usage?.output,
          // Only include message content when captureMessageContent is enabled
          outputMessages: config.captureMessageContent
            ? prepareForCapture(
                event.lastAssistant,
                config.toolOutputMaxLength,
                config.redactSecrets,
              )
            : undefined,
        });
      }

      llmEntry.span.setStatus({ code: SpanStatusCode.OK });
    } finally {
      llmEntry.span.end();
    }
  }
}
