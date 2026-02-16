// SPDX-License-Identifier: MIT
/**
 * Hook: message_received
 *
 * Enriches the active agent span with channel and sender information.
 */

import { spanStore } from '../context/span-store.js';
import type { LogfirePluginConfig } from '../config.js';

/** OpenClaw message_received event payload. */
export interface MessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/** OpenClaw message_received hook context (2nd argument). */
export interface MessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
}

export function handleMessageReceived(
  event: MessageReceivedEvent,
  ctx: MessageContext,
  _config: LogfirePluginConfig,
): void {
  // message_received context has no sessionKey — use conversationId as fallback.
  // This hook fires before before_agent_start, so a session typically doesn't exist yet.
  const lookupKey =
    typeof ctx.conversationId === 'string' && ctx.conversationId.length > 0
      ? ctx.conversationId
      : undefined;
  if (!lookupKey) return;

  const session = spanStore.get(lookupKey);
  if (!session) return;

  // Enrich the agent span with channel info
  if (typeof ctx.channelId === 'string' && ctx.channelId.length > 0) {
    session.agentSpan.setAttribute('openclaw.channel', ctx.channelId);
  }
  if (typeof event.from === 'string' && event.from.length > 0) {
    session.agentSpan.setAttribute('openclaw.sender_id', event.from);
  }
}
