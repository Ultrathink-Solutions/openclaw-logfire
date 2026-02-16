// SPDX-License-Identifier: MIT
/**
 * Hook: before_agent_start
 *
 * Creates the root `invoke_agent` span following OTEL GenAI semantic
 * conventions.  This span parents all tool call spans and is closed
 * in agent-end.ts.
 */

import { trace, context, SpanKind } from '@opentelemetry/api';
import { spanStore, type SessionSpanContext } from '../context/span-store.js';
import { extractWorkspaceName } from '../util.js';
import type { LogfirePluginConfig } from '../config.js';

/** OpenClaw before_agent_start event payload. */
export interface BeforeAgentStartEvent {
  prompt: string;
  messages?: unknown[];
}

/** OpenClaw agent lifecycle hook context (2nd argument). */
export interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

export function handleBeforeAgentStart(
  _event: BeforeAgentStartEvent,
  ctx: AgentContext,
  config: LogfirePluginConfig,
): void {
  const sessionKey =
    typeof ctx.sessionKey === 'string' && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0
        ? ctx.sessionId
        : undefined;
  if (!sessionKey) return;

  const tracer = trace.getTracer('@ultrathink-solutions/openclaw-logfire', '0.1.0');
  const agentName =
    typeof ctx.agentId === 'string' && ctx.agentId.length > 0
      ? ctx.agentId
      : 'agent';
  const workspace = extractWorkspaceName(
    typeof ctx.workspaceDir === 'string' ? ctx.workspaceDir : undefined,
  );
  const channel =
    typeof ctx.messageProvider === 'string' && ctx.messageProvider.length > 0
      ? ctx.messageProvider
      : 'unknown';

  // Span name per spec: "invoke_agent {gen_ai.agent.name}"
  const spanName = `invoke_agent ${agentName}`;

  const agentSpan = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        // Required GenAI attributes
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.provider.name': config.providerName || 'unknown',

        // Agent attributes
        'gen_ai.agent.name': agentName,
        'gen_ai.agent.id': agentName,
        'gen_ai.conversation.id': sessionKey,

        // OpenClaw-specific context
        'openclaw.session_key': sessionKey,
        'openclaw.workspace': workspace,
        'openclaw.channel': channel,
      },
    },
    context.active(),
  );

  const agentCtx = trace.setSpan(context.active(), agentSpan);

  const session: SessionSpanContext = {
    agentSpan,
    agentCtx,
    toolStack: [],
    toolSequence: 0,
    hasError: false,
    startTime: Date.now(),
  };

  spanStore.set(sessionKey, session);
}
