// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { classifyGeminiError } from '../../src/services/worker/GeminiProvider.js';
import { classifyOpenRouterError } from '../../src/services/worker/OpenRouterProvider.js';
import { classifyOpenAICompatError } from '../../src/services/worker/OpenAICompatProvider.js';
import { classifyGeminiServerError } from '../../src/server/generation/providers/GeminiObservationProvider.js';
import { classifyHttpProviderError } from '../../src/server/generation/providers/shared/error-classification.js';

/**
 * The worker and the server runtime classify the same provider answers, each
 * with its own error model (src/server may not import from the worker). What
 * they decide must not drift: a per-day cap retried by one and parked by the
 * other spends requests for nothing, and a region refusal read as a refused
 * key by one rotates and parks every pooled key.
 */

const openRouterBody = (message: string) => JSON.stringify({ error: { message, code: 429 } });
const geminiQuota = (...quotaIds: string[]) => JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota, please check your plan and billing details.',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: quotaIds.map(quotaId => ({ quotaId })) },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '6s' },
    ],
  },
});
const geminiRegion = (status: number) => JSON.stringify({
  error: { code: status, message: 'User location is not supported for the API use.', status: status === 400 ? 'FAILED_PRECONDITION' : 'PERMISSION_DENIED' },
});

describe('worker and server agree on provider refusals', () => {
  const openRouterCases: Array<[string, string, string]> = [
    ['a per-day free-model cap', 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', 'quota_exhausted'],
    ['a per-minute free-model limit', 'Rate limit exceeded: free-models-per-min.', 'rate_limit'],
  ];
  for (const [name, message, kind] of openRouterCases) {
    it(`OpenRouter 429: ${name} is ${kind} on both, and on openai-compatible`, () => {
      const bodyText = openRouterBody(message);
      expect(classifyOpenRouterError({ status: 429, bodyText, cause: new Error('429') }).kind).toBe(kind);
      expect(classifyHttpProviderError({ status: 429, bodyText, cause: new Error('429'), providerLabel: 'OpenRouter' }).kind).toBe(kind);
      // The same answer through the openai-compatible provider (R4-9): as a
      // rate limit, a daily cap was re-probed every 90 seconds until it reset.
      expect(classifyOpenAICompatError({ status: 429, bodyText, cause: new Error('429') }).kind).toBe(kind);
    });
  }

  const geminiQuotaCases: Array<[string, string, string]> = [
    ['a per-minute window', geminiQuota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), 'rate_limit'],
    ['a per-day window', geminiQuota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'), 'quota_exhausted'],
  ];
  for (const [name, bodyText, kind] of geminiQuotaCases) {
    it(`Gemini 429 naming ${name} is ${kind} on both`, () => {
      expect(classifyGeminiError({ status: 429, bodyText, cause: new Error('429') }).kind).toBe(kind);
      expect(classifyGeminiServerError({ status: 429, bodyText, cause: new Error('429') }).kind).toBe(kind);
    });
  }

  for (const status of [400, 403]) {
    it(`Gemini region refusal (${status}) is the same refusal on both`, () => {
      const worker = classifyGeminiError({ status, bodyText: geminiRegion(status), cause: new Error(String(status)) });
      const server = classifyGeminiServerError({ status, bodyText: geminiRegion(status), cause: new Error(String(status)) });
      expect(server.kind).toBe(worker.kind);
      expect(server.message).toBe(worker.message);
    });
  }

  // #6447: OpenRouter delivers the real status in a 200 body's error.code.
  // The worker and the server runtime have to agree, or one pauses and the
  // other finalizes the same answer.
  const rateLimitedUpstream = 'openai/gpt-6-luna is temporarily rate-limited upstream.';
  const highDemand = 'The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.';

  function openRouterKinds(bodyText: string): { worker: string; server: string } {
    const cause = new Error('200');
    return {
      worker: classifyOpenRouterError({ status: 200, bodyText, cause }).kind,
      server: classifyHttpProviderError({ status: 200, bodyText, cause, providerLabel: 'OpenRouter' }).kind,
    };
  }

  it('OpenRouter 200 with numeric error.code 429 is rate_limit on both, and on openai-compatible', () => {
    const bodyText = JSON.stringify({ error: { code: 429, message: rateLimitedUpstream } });
    const kinds = openRouterKinds(bodyText);
    expect(kinds.worker).toBe('rate_limit');
    expect(kinds.server).toBe(kinds.worker);
    expect(classifyOpenAICompatError({ status: 200, bodyText, cause: new Error('200') }).kind).toBe('rate_limit');
  });

  it.each([503, 529])('OpenRouter 200 with numeric error.code %i and a peak-load message is transient on both', (code) => {
    const bodyText = JSON.stringify({ error: { code, message: highDemand } });
    const kinds = openRouterKinds(bodyText);
    expect(kinds.worker).toBe('transient');
    expect(kinds.server).toBe(kinds.worker);
    expect(classifyOpenAICompatError({ status: 200, bodyText, cause: new Error('200') }).kind).toBe('transient');
  });

  it('OpenRouter capacity phrases with no numeric code are retryable on both', () => {
    const rateLimited = openRouterKinds(JSON.stringify({ error: { message: rateLimitedUpstream } }));
    expect(rateLimited.worker).toBe('rate_limit');
    expect(rateLimited.server).toBe(rateLimited.worker);

    const demand = openRouterKinds(highDemand);
    expect(demand.worker).toBe('transient');
    expect(demand.server).toBe(demand.worker);
  });

  it('a litellm parse failure inside a 200 envelope stays an output failure on both', () => {
    const bodyText = JSON.stringify({
      error: { code: 200, message: 'Unable to get json response - Expecting value: line 45 column 1 (char 44)' },
    });
    const cause = new Error('200');
    const worker = classifyOpenRouterError({ status: 200, bodyText, cause });
    const server = classifyHttpProviderError({ status: 200, bodyText, cause, providerLabel: 'OpenRouter' });
    expect(worker.kind).toBe('unrecoverable');
    expect(worker.paidSendOutcome).toBe('output_failure');
    expect(server.kind).toBe(worker.kind);
    expect(server.paidSendOutcome).toBe('output_failure');
  });

  it('a model deprecation inside a 200 envelope stays unrecoverable on both', () => {
    const bodyText = JSON.stringify({ error: { code: 404, message: 'This model has been deprecated' } });
    const cause = new Error('200');
    const worker = classifyOpenRouterError({ status: 200, bodyText, cause });
    const server = classifyHttpProviderError({ status: 200, bodyText, cause, providerLabel: 'OpenRouter' });
    expect(worker.kind).toBe('unrecoverable');
    expect(worker.code).toBe('model_unavailable');
    expect(server.kind).toBe('unrecoverable');
  });

  it('Gemini 400 refusing the key is a refused credential on both', () => {
    const bodyText = JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
      },
    });
    const worker = classifyGeminiError({ status: 400, bodyText, cause: new Error('400') });
    const server = classifyGeminiServerError({ status: 400, bodyText, cause: new Error('400') });
    expect(worker.kind).toBe('auth_invalid');
    expect(server.kind).toBe(worker.kind);
    expect(server.message).toBe(worker.message);
  });
});
