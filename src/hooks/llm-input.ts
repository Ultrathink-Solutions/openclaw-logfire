// SPDX-License-Identifier: MIT
/**
 * Hook: llm_input
 *
 * Fires before each LLM API call with the full request context.
 * Creates a `gen_ai.chat` child span per LLM invocation and stores
 * model/provider on the session for later use in metrics.
 */

import { trace, SpanKind } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import { prepareForCapture } from '../util.js';
import type { LogfirePluginConfig } from '../config.js';

/** OpenClaw llm_input event payload (minimal — only fields we use). */
export interface LlmInputEvent {
  runId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  imagesCount: number;
}

/** OpenClaw agent context (shared with before_agent_start, agent_end, etc.). */
export interface LlmContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

export function handleLlmInput(
  event: LlmInputEvent,
  ctx: LlmContext,
  config: LogfirePluginConfig,
): void {
  const sessionKey = ctx.sessionKey ?? ctx.sessionId;
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  // Store model/provider for use in agent_end metrics
  session.model = event.model;
  session.provider = event.provider;

  // Update the provider on the agent span if it was unknown at start
  if (event.provider && config.providerName === '') {
    session.agentSpan.setAttribute('gen_ai.provider.name', event.provider);
  }

  const tracer = trace.getTracer('@ultrathink-solutions/openclaw-logfire', '0.3.0');

  const attributes: Record<string, string | number> = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.agent.name': ctx.agentId || 'agent',
    'gen_ai.request.model': event.model,
    'gen_ai.provider.name': event.provider,
    'openclaw.llm.run_id': event.runId,
    'openclaw.llm.images_count': event.imagesCount,
  };

  // Opt-in: capture prompt content (with redaction + truncation)
  if (config.captureMessageContent) {
    if (event.systemPrompt) {
      attributes['gen_ai.system'] = prepareForCapture(
        event.systemPrompt,
        config.toolInputMaxLength,
        config.redactSecrets,
      );
    }
    attributes['gen_ai.prompt'] = prepareForCapture(
      event.prompt,
      config.toolInputMaxLength,
      config.redactSecrets,
    );
  }

  const span = tracer.startSpan(
    `gen_ai.chat ${event.provider}`,
    { kind: SpanKind.INTERNAL, attributes },
    session.agentCtx,
  );

  const spanCtx = trace.setSpan(session.agentCtx, span);

  spanStore.setLlmSpan(sessionKey, event.runId, {
    span,
    ctx: spanCtx,
    runId: event.runId,
    provider: event.provider,
    model: event.model,
    startTime: Date.now(),
  });
}
