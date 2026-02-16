import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanKind } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import { mockSpan, mockContext, createTestConfig } from '../test-helpers.js';
import { handleLlmInput } from './llm-input.js';
import type { LlmInputEvent, LlmContext } from './llm-input.js';

const { mockLlmSpan, mockTracerInstance, mockSetSpan } = vi.hoisted(() => {
  const span = {
    end: vi.fn(),
    spanContext: vi.fn(() => ({ traceId: 'abc', spanId: 'def', traceFlags: 1 })),
    setAttribute: vi.fn().mockReturnThis(),
    setStatus: vi.fn().mockReturnThis(),
    addEvent: vi.fn().mockReturnThis(),
    addLink: vi.fn().mockReturnThis(),
    recordException: vi.fn().mockReturnThis(),
    isRecording: vi.fn(() => true),
    updateName: vi.fn().mockReturnThis(),
    setAttributes: vi.fn().mockReturnThis(),
  };
  return {
    mockLlmSpan: span,
    mockTracerInstance: { startSpan: vi.fn(() => span) },
    mockSetSpan: vi.fn(() => ({})),
  };
});

vi.mock('@opentelemetry/api', async () => {
  const actual = await vi.importActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
  return {
    ...actual,
    trace: {
      getTracer: vi.fn(() => mockTracerInstance),
      setSpan: mockSetSpan,
    },
    SpanKind: actual.SpanKind,
  };
});

function seedSession(sessionKey: string) {
  const agentSpan = mockSpan();
  spanStore.set(sessionKey, {
    agentSpan,
    agentCtx: mockContext(),
    toolStack: [],
    llmSpans: new Map(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: 0,
    hasError: false,
    startTime: Date.now(),
  });
  return agentSpan;
}

describe('handleLlmInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spanStore.delete('sess-1');
  });

  afterEach(() => {
    spanStore.delete('sess-1');
  });

  const baseEvent: LlmInputEvent = {
    runId: 'run-abc',
    sessionId: 'sess-1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    prompt: 'Hello',
    historyMessages: [],
    imagesCount: 0,
  };

  const baseCtx: LlmContext = {
    agentId: 'my-agent',
    sessionKey: 'sess-1',
  };

  it('creates a gen_ai.chat span with correct attributes', () => {
    seedSession('sess-1');

    handleLlmInput(baseEvent, baseCtx, createTestConfig());

    expect(mockTracerInstance.startSpan).toHaveBeenCalledWith(
      'gen_ai.chat anthropic',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: expect.objectContaining({
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': 'claude-sonnet-4-5-20250929',
          'gen_ai.provider.name': 'anthropic',
          'openclaw.llm.run_id': 'run-abc',
          'openclaw.llm.images_count': 0,
        }),
      }),
      expect.anything(), // parent context
    );
  });

  it('stores the LLM span in the session', () => {
    seedSession('sess-1');

    handleLlmInput(baseEvent, baseCtx, createTestConfig());

    const llmEntry = spanStore.getLlmSpan('sess-1', 'run-abc');
    expect(llmEntry).toBeDefined();
    expect(llmEntry!.span).toBe(mockLlmSpan);
    expect(llmEntry!.runId).toBe('run-abc');
    expect(llmEntry!.provider).toBe('anthropic');
    expect(llmEntry!.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('updates session model and provider', () => {
    seedSession('sess-1');

    handleLlmInput(baseEvent, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.model).toBe('claude-sonnet-4-5-20250929');
    expect(session.provider).toBe('anthropic');
  });

  it('updates agent span provider when config providerName is empty', () => {
    const agentSpan = seedSession('sess-1');
    const config = createTestConfig({ providerName: '' });

    handleLlmInput(baseEvent, baseCtx, config);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith(
      'gen_ai.provider.name',
      'anthropic',
    );
  });

  it('does NOT update agent span provider when config has explicit providerName', () => {
    const agentSpan = seedSession('sess-1');
    const config = createTestConfig({ providerName: 'custom-provider' });

    handleLlmInput(baseEvent, baseCtx, config);

    expect(agentSpan.setAttribute).not.toHaveBeenCalledWith(
      'gen_ai.provider.name',
      expect.anything(),
    );
  });

  it('captures message content when enabled', () => {
    seedSession('sess-1');
    const config = createTestConfig({ captureMessageContent: true });
    const event = { ...baseEvent, systemPrompt: 'You are helpful' };

    handleLlmInput(event, baseCtx, config);

    expect(mockTracerInstance.startSpan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attributes: expect.objectContaining({
          'gen_ai.system': 'You are helpful',
          'gen_ai.prompt': 'Hello',
        }),
      }),
      expect.anything(),
    );
  });

  it('does not capture message content by default', () => {
    seedSession('sess-1');

    handleLlmInput(baseEvent, baseCtx, createTestConfig());

    const attrs = mockTracerInstance.startSpan.mock.calls[0][1].attributes;
    expect(attrs).not.toHaveProperty('gen_ai.system');
    expect(attrs).not.toHaveProperty('gen_ai.prompt');
  });

  it('falls back to sessionId when sessionKey is missing', () => {
    seedSession('sess-1');
    const ctx: LlmContext = { sessionId: 'sess-1' };

    handleLlmInput(baseEvent, ctx, createTestConfig());

    expect(spanStore.getLlmSpan('sess-1', 'run-abc')).toBeDefined();
  });

  it('returns early when no session key exists', () => {
    handleLlmInput(baseEvent, {}, createTestConfig());

    expect(mockTracerInstance.startSpan).not.toHaveBeenCalled();
  });

  it('returns early when session is not found', () => {
    // Don't seed session
    handleLlmInput(baseEvent, baseCtx, createTestConfig());

    expect(mockTracerInstance.startSpan).not.toHaveBeenCalled();
  });
});
