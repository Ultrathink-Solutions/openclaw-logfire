import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import {
  mockSpan,
  mockContext,
  createTestConfig,
  createMockLogger,
} from '../test-helpers.js';
import { handleAgentEnd } from './agent-end.js';
import type { AgentEndEvent } from './agent-end.js';
import type { AgentContext } from './before-agent-start.js';

vi.mock('../metrics/genai-metrics.js', () => ({
  recordOperationDuration: vi.fn(),
}));

vi.mock('../trace-link.js', () => ({
  buildLogfireTraceUrl: vi.fn(() => 'https://logfire.dev/trace/abc'),
}));

import { recordOperationDuration } from '../metrics/genai-metrics.js';
import { buildLogfireTraceUrl } from '../trace-link.js';

function seedSession(
  sessionKey: string,
  overrides?: Partial<{
    hasError: boolean;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    model: string;
    provider: string;
    toolSequence: number;
  }>,
) {
  const agentSpan = mockSpan();

  spanStore.set(sessionKey, {
    agentSpan,
    agentCtx: mockContext(),
    toolStack: [],
    llmSpans: new Map(),
    tokens: overrides?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: overrides?.toolSequence ?? 0,
    hasError: overrides?.hasError ?? false,
    startTime: Date.now() - 5000, // 5 seconds ago
    model: overrides?.model,
    provider: overrides?.provider,
  });

  return agentSpan;
}

describe('handleAgentEnd', () => {
  const logger = createMockLogger();

  beforeEach(() => {
    vi.clearAllMocks();
    spanStore.delete('sess-1');
  });

  afterEach(() => {
    spanStore.delete('sess-1');
  });

  const baseEvent: AgentEndEvent = {
    messages: [],
    success: true,
  };

  const baseCtx: AgentContext = {
    agentId: 'my-agent',
    sessionKey: 'sess-1',
    workspaceDir: '/workspaces/marketing',
  };

  it('ends the agent span with OK status on success', () => {
    const agentSpan = seedSession('sess-1');

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(agentSpan.end).toHaveBeenCalled();
  });

  it('sets ERROR status when event.success is false', () => {
    const agentSpan = seedSession('sess-1');
    const event: AgentEndEvent = { messages: [], success: false };

    handleAgentEnd(event, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: SpanStatusCode.ERROR }),
    );
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('error.type', 'Error');
  });

  it('sets AgentError when event.error is present', () => {
    const agentSpan = seedSession('sess-1');
    const event: AgentEndEvent = {
      messages: [],
      success: false,
      error: 'API rate limit exceeded',
    };

    handleAgentEnd(event, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('error.type', 'AgentError');
    expect(agentSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'API rate limit exceeded',
    });
  });

  it('sets ToolError when session.hasError is true', () => {
    const agentSpan = seedSession('sess-1', { hasError: true });
    const event: AgentEndEvent = { messages: [], success: false };

    handleAgentEnd(event, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('error.type', 'ToolError');
  });

  it('sets cumulative token attributes on agent span', () => {
    const agentSpan = seedSession('sess-1', {
      tokens: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 800 },
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 1000);
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 500);
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('openclaw.usage.cache_read_tokens', 2000);
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('openclaw.usage.cache_write_tokens', 800);
  });

  it('omits token attributes when tokens are zero', () => {
    const agentSpan = seedSession('sess-1');

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    const calls = (agentSpan.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const hasInputTokens = calls.some(([key]: [string]) => key === 'gen_ai.usage.input_tokens');
    expect(hasInputTokens).toBe(false);
  });

  it('omits cache token attributes when cache tokens are zero', () => {
    const agentSpan = seedSession('sess-1', {
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    const calls = (agentSpan.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const hasCacheRead = calls.some(([key]: [string]) => key === 'openclaw.usage.cache_read_tokens');
    expect(hasCacheRead).toBe(false);
  });

  it('sets model and provider from session on agent span', () => {
    const agentSpan = seedSession('sess-1', {
      model: 'claude-sonnet-4-5-20250929',
      provider: 'anthropic',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'claude-sonnet-4-5-20250929');
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.response.model', 'claude-sonnet-4-5-20250929');
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'anthropic');
  });

  it('sets duration and tool count attributes', () => {
    const agentSpan = seedSession('sess-1', { toolSequence: 5 });
    const event: AgentEndEvent = { messages: [], success: true, durationMs: 3000 };

    handleAgentEnd(event, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('openclaw.request.duration_ms', 3000);
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('openclaw.request.tool_count', 5);
  });

  it('closes remaining tool spans on the stack', () => {
    const agentSpan = seedSession('sess-1');
    const orphanedToolSpan = mockSpan();
    spanStore.pushTool('sess-1', {
      span: orphanedToolSpan,
      ctx: mockContext(),
      name: 'Read',
      callId: 'c1',
      startTime: Date.now(),
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(orphanedToolSpan.end).toHaveBeenCalled();
  });

  it('closes remaining LLM spans', () => {
    seedSession('sess-1');
    const orphanedLlmSpan = mockSpan();
    spanStore.setLlmSpan('sess-1', 'run-orphan', {
      span: orphanedLlmSpan,
      ctx: mockContext(),
      runId: 'run-orphan',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now(),
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(orphanedLlmSpan.end).toHaveBeenCalled();
  });

  it('records operation duration metrics when enabled', () => {
    seedSession('sess-1', { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' });
    const config = createTestConfig({ enableMetrics: true });
    const event: AgentEndEvent = { messages: [], success: true, durationMs: 2000 };

    handleAgentEnd(event, baseCtx, config, logger);

    expect(recordOperationDuration).toHaveBeenCalledWith(
      2, // 2000ms / 1000 = 2s
      expect.objectContaining({
        agentName: 'my-agent',
        providerName: 'anthropic',
        requestModel: 'claude-sonnet-4-5-20250929',
        hasError: false,
      }),
    );
  });

  it('does not record metrics when disabled', () => {
    seedSession('sess-1');

    handleAgentEnd(baseEvent, baseCtx, createTestConfig({ enableMetrics: false }), logger);

    expect(recordOperationDuration).not.toHaveBeenCalled();
  });

  it('logs trace link when enabled and projectUrl is set', () => {
    seedSession('sess-1');
    const config = createTestConfig({
      enableTraceLinks: true,
      projectUrl: 'https://logfire.pydantic.dev/org/proj',
    });

    handleAgentEnd(baseEvent, baseCtx, config, logger);

    expect(buildLogfireTraceUrl).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Logfire trace:'));
  });

  it('does not log trace link when disabled', () => {
    seedSession('sess-1');

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(buildLogfireTraceUrl).not.toHaveBeenCalled();
  });

  it('deletes the session from span store', () => {
    seedSession('sess-1');

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(spanStore.get('sess-1')).toBeUndefined();
  });

  it('falls back to sessionId when sessionKey is missing', () => {
    seedSession('sess-1');
    const ctx: AgentContext = { agentId: 'my-agent', sessionId: 'sess-1' };

    handleAgentEnd(baseEvent, ctx, createTestConfig(), logger);

    expect(spanStore.get('sess-1')).toBeUndefined(); // cleaned up
  });

  it('returns early when no session key exists', () => {
    handleAgentEnd(baseEvent, {}, createTestConfig(), logger);
    // No error
  });
});
