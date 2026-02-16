import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import { mockSpan, mockContext, createTestConfig } from '../test-helpers.js';
import { handleLlmOutput } from './llm-output.js';
import type { LlmOutputEvent } from './llm-output.js';
import type { LlmContext } from './llm-input.js';

// Mock metrics and inference-details to verify they get called
vi.mock('../metrics/genai-metrics.js', () => ({
  recordTokenUsage: vi.fn(),
}));

vi.mock('../events/inference-details.js', () => ({
  emitInferenceDetailsEvent: vi.fn(),
}));

import { recordTokenUsage } from '../metrics/genai-metrics.js';
import { emitInferenceDetailsEvent } from '../events/inference-details.js';

function seedSessionWithLlm(sessionKey: string, runId: string) {
  const agentSpan = mockSpan();
  const llmSpan = mockSpan();
  const agentCtx = mockContext();

  spanStore.set(sessionKey, {
    agentSpan,
    agentCtx,
    toolStack: [],
    llmSpans: new Map(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: 0,
    hasError: false,
    startTime: Date.now(),
  });

  spanStore.setLlmSpan(sessionKey, runId, {
    span: llmSpan,
    ctx: mockContext(),
    runId,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    startTime: Date.now(),
  });

  return { agentSpan, llmSpan };
}

describe('handleLlmOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spanStore.delete('sess-1');
  });

  afterEach(() => {
    spanStore.delete('sess-1');
  });

  const baseEvent: LlmOutputEvent = {
    runId: 'run-1',
    sessionId: 'sess-1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    assistantTexts: ['Hello!'],
    usage: {
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 80,
    },
  };

  const baseCtx: LlmContext = {
    agentId: 'my-agent',
    sessionKey: 'sess-1',
    workspaceDir: '/workspaces/marketing',
  };

  it('accumulates tokens on the session', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(100);
    expect(session.tokens.output).toBe(50);
    expect(session.tokens.cacheRead).toBe(200);
    expect(session.tokens.cacheWrite).toBe(80);
  });

  it('accumulates across multiple LLM calls', () => {
    const { llmSpan: llmSpan1 } = seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    // Seed another LLM span for a second call
    const llmSpan2 = mockSpan();
    spanStore.setLlmSpan('sess-1', 'run-2', {
      span: llmSpan2,
      ctx: mockContext(),
      runId: 'run-2',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now(),
    });

    const secondEvent: LlmOutputEvent = {
      ...baseEvent,
      runId: 'run-2',
      usage: { input: 50, output: 25 },
    };

    handleLlmOutput(secondEvent, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(150);
    expect(session.tokens.output).toBe(75);
  });

  it('sets token attributes on the LLM span', () => {
    const { llmSpan } = seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    expect(llmSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 100);
    expect(llmSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 50);
    expect(llmSpan.setAttribute).toHaveBeenCalledWith('openclaw.usage.cache_read_tokens', 200);
    expect(llmSpan.setAttribute).toHaveBeenCalledWith('openclaw.usage.cache_write_tokens', 80);
    expect(llmSpan.setAttribute).toHaveBeenCalledWith('gen_ai.response.model', 'claude-sonnet-4-5-20250929');
  });

  it('ends the LLM span with OK status', () => {
    const { llmSpan } = seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    expect(llmSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(llmSpan.end).toHaveBeenCalled();
  });

  it('removes the LLM span from the store after closing', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    expect(spanStore.getLlmSpan('sess-1', 'run-1')).toBeUndefined();
  });

  it('records token metrics when enableMetrics is true', () => {
    seedSessionWithLlm('sess-1', 'run-1');
    const config = createTestConfig({ enableMetrics: true });

    handleLlmOutput(baseEvent, baseCtx, config);

    expect(recordTokenUsage).toHaveBeenCalledWith(
      100,
      'input',
      expect.objectContaining({
        agentName: 'my-agent',
        providerName: 'anthropic',
        requestModel: 'claude-sonnet-4-5-20250929',
      }),
    );
    expect(recordTokenUsage).toHaveBeenCalledWith(
      50,
      'output',
      expect.objectContaining({
        agentName: 'my-agent',
      }),
    );
  });

  it('does not record metrics when enableMetrics is false', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig({ enableMetrics: false }));

    expect(recordTokenUsage).not.toHaveBeenCalled();
  });

  it('emits inference details event when captureInferenceEvents is true', () => {
    const { llmSpan } = seedSessionWithLlm('sess-1', 'run-1');
    const config = createTestConfig({ captureInferenceEvents: true });

    handleLlmOutput(baseEvent, baseCtx, config);

    expect(emitInferenceDetailsEvent).toHaveBeenCalledWith(
      llmSpan,
      expect.objectContaining({
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 100,
        outputTokens: 50,
      }),
    );
  });

  it('does not emit inference details when captureInferenceEvents is false', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    expect(emitInferenceDetailsEvent).not.toHaveBeenCalled();
  });

  it('handles missing usage gracefully', () => {
    seedSessionWithLlm('sess-1', 'run-1');
    const event: LlmOutputEvent = { ...baseEvent, usage: undefined };

    handleLlmOutput(event, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(0);
    expect(session.tokens.output).toBe(0);
  });

  it('handles partial usage (only input tokens)', () => {
    seedSessionWithLlm('sess-1', 'run-1');
    const event: LlmOutputEvent = {
      ...baseEvent,
      usage: { input: 100 },
    };

    handleLlmOutput(event, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(100);
    expect(session.tokens.output).toBe(0);
  });

  it('updates session model/provider to latest', () => {
    seedSessionWithLlm('sess-1', 'run-1');
    const event: LlmOutputEvent = {
      ...baseEvent,
      provider: 'openai',
      model: 'gpt-4o',
    };

    handleLlmOutput(event, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.model).toBe('gpt-4o');
    expect(session.provider).toBe('openai');
  });

  it('returns early when no session key exists', () => {
    handleLlmOutput(baseEvent, {}, createTestConfig());

    // No error thrown, nothing happens
    expect(recordTokenUsage).not.toHaveBeenCalled();
  });

  it('handles missing LLM span gracefully (still accumulates tokens)', () => {
    // Seed session but WITHOUT an LLM span for this runId
    const agentSpan = mockSpan();
    spanStore.set('sess-1', {
      agentSpan,
      agentCtx: mockContext(),
      toolStack: [],
      llmSpans: new Map(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolSequence: 0,
      hasError: false,
      startTime: Date.now(),
    });

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    // Tokens still accumulate even without a matching LLM span
    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(100);
    expect(session.tokens.output).toBe(50);
  });
});
