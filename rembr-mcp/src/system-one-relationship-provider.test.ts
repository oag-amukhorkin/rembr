import { describe, expect, it, vi } from 'vitest';
import {
  scanRelationshipPairForExternalProcessing,
  stripExactSharedSentences,
  SystemOneProviderError,
  SystemOneRelationshipProvider,
} from './system-one-relationship-provider.js';

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      relationship: {
        type: 'choice',
        choice: 'refines',
        probabilities: {
          supports: 0.01,
          refines: 0.92,
          supersedes: 0.01,
          relates_to: 0.05,
          unrelated: 0.01,
        },
        confidence: 0.92,
      },
    },
    usage: { input_tokens: 125, output_tokens: 7 },
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('System One relationship data boundary', () => {
  it('removes only exact shared sentences and retains distinct state', () => {
    expect(stripExactSharedSentences(
      'Shared context. The queue is bounded.',
      'Shared context. The queue uses leases.',
    )).toEqual(['The queue is bounded.', 'The queue uses leases.']);
    expect(stripExactSharedSentences('Same sentence.', 'Same sentence.')).toEqual([
      'Same sentence.',
      'Same sentence.',
    ]);
  });

  it('fails closed on PII, secrets, empty and oversized content', () => {
    expect(scanRelationshipPairForExternalProcessing(
      'Contact the owner at owner@example.com.',
      'The owner approved the deployment.',
    )).toMatchObject({ allowed: false, reason: 'pii_detected' });
    expect(scanRelationshipPairForExternalProcessing(
      'The API key is api_key=abcdefghijklmnop.',
      'The deployment consumes the credential.',
    )).toMatchObject({ allowed: false, reason: 'secret_detected' });
    expect(scanRelationshipPairForExternalProcessing('', 'valid')).toMatchObject({
      allowed: false,
      reason: 'content_empty',
    });
    expect(scanRelationshipPairForExternalProcessing('a'.repeat(101), 'valid', 100)).toMatchObject({
      allowed: false,
      reason: 'content_too_long',
    });
  });
});

describe('SystemOneRelationshipProvider', () => {
  it('sends the frozen relationship question and returns validated usage and hashes', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(successResponse());
    const provider = new SystemOneRelationshipProvider('test-key-that-is-never-logged', {
      fetchImplementation,
      wait: async () => undefined,
    });

    const prediction = await provider.predict(
      'Shared context. The worker has a bounded queue.',
      'Shared context. The worker queue has a cap of three hundred.',
    );

    expect(prediction).toMatchObject({
      returnedModel: 'jev-1.13.0',
      label: 'refines',
      confidence: 0.92,
      acceptedByGate: true,
      requestAttempts: 1,
      inputTokens: 125,
      outputTokens: 7,
    });
    expect(prediction.rawContentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prediction.cleanedContentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prediction.cleanedContentSha256).not.toBe(prediction.rawContentSha256);
    expect(prediction.predictionSha256).toMatch(/^[0-9a-f]{64}$/);
    const [, init] = fetchImplementation.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toEqual({
      memoryA: 'The worker has a bounded queue.',
      memoryB: 'The worker queue has a cap of three hundred.',
    });
    expect(Object.keys(body.questions.relationship.criteria)).toEqual([
      'supports', 'refines', 'supersedes', 'relates_to', 'unrelated',
    ]);
  });

  it('retries only bounded transient responses and records the attempt count', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '99' } }))
      .mockResolvedValueOnce(successResponse());
    const provider = new SystemOneRelationshipProvider('test-key', {
      maxRetries: 1,
      fetchImplementation,
      wait,
    });

    const prediction = await provider.predict('The worker is enabled.', 'The worker processes pairs.');
    expect(prediction.requestAttempts).toBe(2);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2_000);
  });

  it('does not include upstream response bodies in errors', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response('sensitive upstream body', { status: 500 }),
    );
    const provider = new SystemOneRelationshipProvider('test-key', {
      maxRetries: 0,
      fetchImplementation,
    });

    await expect(provider.predict('The worker is enabled.', 'The worker processes pairs.'))
      .rejects.toMatchObject({ errorClass: 'upstream_error' });
    await expect(provider.predict('The worker is enabled.', 'The worker processes pairs.'))
      .rejects.not.toThrow('sensitive upstream body');
  });

  it('opens its circuit after five consecutive failures', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const provider = new SystemOneRelationshipProvider('test-key', {
      maxRetries: 0,
      fetchImplementation,
    });
    for (let index = 0; index < 5; index++) {
      await expect(provider.predict('The worker is enabled.', 'The worker processes pairs.'))
        .rejects.toBeInstanceOf(SystemOneProviderError);
    }
    await expect(provider.predict('The worker is enabled.', 'The worker processes pairs.'))
      .rejects.toMatchObject({ errorClass: 'circuit_open' });
    expect(fetchImplementation).toHaveBeenCalledTimes(5);
  });

  it('rejects malformed probability distributions', async () => {
    const invalid = successResponse({
      answers: {
        relationship: {
          type: 'choice',
          choice: 'refines',
          probabilities: { refines: 1 },
          confidence: 1,
        },
      },
    });
    const provider = new SystemOneRelationshipProvider('test-key', {
      maxRetries: 0,
      fetchImplementation: vi.fn().mockResolvedValue(invalid),
    });
    await expect(provider.predict('The worker is enabled.', 'The worker processes pairs.'))
      .rejects.toMatchObject({ errorClass: 'invalid_response' });
  });

  it('rejects unrecognised fields at every response nesting level', async () => {
    const valid = JSON.parse(await successResponse().text()) as Record<string, any>;
    const invalidResponses = [
      { ...valid, unexpected: true },
      { ...valid, answers: { ...valid.answers, unexpected: true } },
      {
        ...valid,
        answers: {
          ...valid.answers,
          relationship: { ...valid.answers.relationship, unexpected: true },
        },
      },
      { ...valid, usage: { ...valid.usage, unexpected: true } },
    ];

    for (const body of invalidResponses) {
      const provider = new SystemOneRelationshipProvider('test-key', {
        maxRetries: 0,
        fetchImplementation: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })),
      });
      await expect(provider.predict('The worker is enabled.', 'The worker processes pairs.'))
        .rejects.toMatchObject({ errorClass: 'invalid_response' });
    }
  });

  it('admits and finalises every HTTP attempt, including failures', async () => {
    const hooks = {
      reserve: vi.fn().mockResolvedValue({ attemptId: '00000000-0000-4000-8000-000000000099' }),
      finish: vi.fn().mockResolvedValue(undefined),
    };
    const provider = new SystemOneRelationshipProvider('test-key', {
      maxRetries: 0,
      fetchImplementation: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    });
    await expect(provider.predict(
      'The worker is enabled.',
      'The worker processes pairs.',
      hooks,
    )).rejects.toMatchObject({ errorClass: 'upstream_error' });
    expect(hooks.reserve).toHaveBeenCalledTimes(1);
    expect(hooks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      attemptNumber: 1,
      conservativeInputTokens: expect.any(Number),
      conservativeCostUsd: expect.any(Number),
    }));
    expect(hooks.finish).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: '00000000-0000-4000-8000-000000000099',
      outcome: 'upstream_error',
      httpStatus: 503,
    }));
  });

  it('allows documented confidence to differ from choice probability', async () => {
    const response = successResponse({
      answers: {
        relationship: {
          type: 'choice',
          choice: 'refines',
          probabilities: {
            supports: 0.03, refines: 0.85, supersedes: 0.02, relates_to: 0.06, unrelated: 0.04,
          },
          confidence: 0.82,
        },
      },
    });
    const provider = new SystemOneRelationshipProvider('test-key', {
      fetchImplementation: vi.fn().mockResolvedValue(response),
    });
    await expect(provider.predict('The worker is enabled.', 'The worker processes pairs.'))
      .resolves.toMatchObject({ label: 'refines', confidence: 0.82, acceptedByGate: true });
  });

  it('rejects a choice that is not a highest-probability option', async () => {
    const response = successResponse({
      answers: {
        relationship: {
          type: 'choice',
          choice: 'refines',
          probabilities: {
            supports: 0.8, refines: 0.1, supersedes: 0.02, relates_to: 0.04, unrelated: 0.04,
          },
          confidence: 0.7,
        },
      },
    });
    const provider = new SystemOneRelationshipProvider('test-key', {
      fetchImplementation: vi.fn().mockResolvedValue(response),
    });
    await expect(provider.predict('The worker is enabled.', 'The worker processes pairs.'))
      .rejects.toMatchObject({ errorClass: 'invalid_response' });
  });

  it('rejects an unpinned returned model version', async () => {
    const provider = new SystemOneRelationshipProvider('test-key', {
      maxRetries: 0,
      fetchImplementation: vi.fn().mockResolvedValue(successResponse({ model: 'jev-latest' })),
    });
    await expect(provider.predict('The worker is enabled.', 'The worker processes pairs.'))
      .rejects.toMatchObject({ errorClass: 'invalid_response' });
  });
});
