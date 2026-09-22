import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { piiDetector, type PIIType } from './pii-detector.js';
import {
  SYSTEM_ONE_RELATIONSHIP_QUESTION_SET,
  SYSTEM_ONE_STATE_ENVELOPE,
} from './system-one-shadow-capture.js';

export const SYSTEM_ONE_RELATIONSHIP_MODEL = 'jev-1.13.0';
export const SYSTEM_ONE_RELATIONSHIP_CONFIDENCE_GATE = 0.8;
export const SYSTEM_ONE_INPUT_PRICE_PER_MILLION_USD = 0.042;

function inputCostUsd(inputTokens: number): number {
  return Number((inputTokens / 1_000_000 * SYSTEM_ONE_INPUT_PRICE_PER_MILLION_USD).toFixed(8));
}

const RELATIONSHIP_LABELS = [
  'supports',
  'refines',
  'supersedes',
  'relates_to',
  'unrelated',
] as const;

export type SystemOneRelationshipLabel = typeof RELATIONSHIP_LABELS[number];

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.enum(RELATIONSHIP_LABELS),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  confidence: z.number().min(0).max(1),
}).strict();

const responseSchema = z.object({
  model: z.string().min(1).max(128),
  answers: z.object({ relationship: choiceAnswerSchema }).strict(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const SECRET_PATTERNS: Array<{ type: string; pattern: RegExp }> = [
  { type: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { type: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}\b/i },
  { type: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { type: 'known_token_prefix', pattern: /\b(?:sk|ghp|github_pat|glpat|xox[baprs])-[_A-Za-z0-9-]{12,}\b/i },
  {
    type: 'credential_assignment',
    pattern: /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"]?[A-Za-z0-9._~+\/-]{12,}/i,
  },
];

export interface ExternalProcessingScanResult {
  allowed: boolean;
  piiTypes: PIIType[];
  secretTypes: string[];
  reason?: 'pii_detected' | 'secret_detected' | 'content_empty' | 'content_too_long';
}

export interface SystemOneRelationshipPrediction {
  provider: 'typesafe-system-one';
  requestedModel: typeof SYSTEM_ONE_RELATIONSHIP_MODEL;
  returnedModel: string;
  questionSet: typeof SYSTEM_ONE_RELATIONSHIP_QUESTION_SET;
  stateEnvelope: typeof SYSTEM_ONE_STATE_ENVELOPE;
  label: SystemOneRelationshipLabel;
  probabilities: Record<string, number>;
  confidence: number;
  acceptedByGate: boolean;
  rawContentSha256: string;
  cleanedContentSha256: string;
  durationMs: number;
  requestAttempts: number;
  httpResultClass: '2xx';
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  requestedAt: Date;
  completedAt: Date;
  attemptReservationId: string;
  predictionSha256: string;
}

export type SystemOneAttemptOutcome =
  | 'succeeded'
  | 'timeout'
  | 'rate_limited'
  | 'upstream_error'
  | 'invalid_response'
  | 'network_error';

export interface SystemOneAttemptReservationRequest {
  attemptNumber: number;
  requestedAt: Date;
  conservativeInputTokens: number;
  conservativeCostUsd: number;
}

export interface SystemOneAttemptCompletion {
  attemptId: string;
  outcome: SystemOneAttemptOutcome;
  completedAt: Date;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  actualCostUsd: number | null;
}

export interface SystemOneAttemptHooks {
  reserve(request: SystemOneAttemptReservationRequest): Promise<{ attemptId: string }>;
  finish(completion: SystemOneAttemptCompletion): Promise<void>;
}

export class SystemOneProviderError extends Error {
  constructor(
    readonly errorClass:
      | 'circuit_open'
      | 'timeout'
      | 'rate_limited'
      | 'upstream_error'
      | 'invalid_response'
      | 'network_error',
    message: string,
  ) {
    super(message);
    this.name = 'SystemOneProviderError';
  }
}

export interface SystemOneRelationshipProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImplementation?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
}

function canonicalPredictionHash(input: {
  label: SystemOneRelationshipLabel;
  probabilities: Record<string, number>;
  confidence: number;
  rawContentSha256: string;
  cleanedContentSha256: string;
  inputTokens: number;
  outputTokens: number;
}): string {
  const orderedProbabilities = Object.fromEntries(
    RELATIONSHIP_LABELS.map(label => [label, input.probabilities[label]]),
  );
  return createHash('sha256').update(JSON.stringify({
    provider: 'typesafe-system-one',
    requestedModel: SYSTEM_ONE_RELATIONSHIP_MODEL,
    returnedModel: SYSTEM_ONE_RELATIONSHIP_MODEL,
    questionSet: SYSTEM_ONE_RELATIONSHIP_QUESTION_SET,
    stateEnvelope: SYSTEM_ONE_STATE_ENVELOPE,
    label: input.label,
    probabilities: orderedProbabilities,
    confidence: input.confidence,
    rawContentSha256: input.rawContentSha256,
    cleanedContentSha256: input.cleanedContentSha256,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  })).digest('hex');
}

function sentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
}

export function stripExactSharedSentences(left: string, right: string): [string, string] {
  const leftSentences = sentences(left);
  const rightSentences = sentences(right);
  const shared = new Set(leftSentences.filter(sentence => rightSentences.includes(sentence)));
  const cleanedLeft = leftSentences.filter(sentence => !shared.has(sentence));
  const cleanedRight = rightSentences.filter(sentence => !shared.has(sentence));
  if (cleanedLeft.length === 0 || cleanedRight.length === 0) return [left, right];
  return [cleanedLeft.join(' '), cleanedRight.join(' ')];
}

function pairHash(left: string, right: string): string {
  return createHash('sha256').update(left).update('\0').update(right).digest('hex');
}

export function scanRelationshipPairForExternalProcessing(
  left: string,
  right: string,
  maximumCharacters = 16_000,
): ExternalProcessingScanResult {
  if (!left.trim() || !right.trim()) {
    return { allowed: false, piiTypes: [], secretTypes: [], reason: 'content_empty' };
  }
  if (left.length > maximumCharacters || right.length > maximumCharacters) {
    return { allowed: false, piiTypes: [], secretTypes: [], reason: 'content_too_long' };
  }

  const piiTypes = [...new Set([
    ...piiDetector.detectPII(left, 'high').types,
    ...piiDetector.detectPII(right, 'high').types,
  ])];
  if (piiTypes.length > 0) {
    return { allowed: false, piiTypes, secretTypes: [], reason: 'pii_detected' };
  }

  const combined = `${left}\n${right}`;
  const secretTypes = SECRET_PATTERNS
    .filter(candidate => candidate.pattern.test(combined))
    .map(candidate => candidate.type);
  if (secretTypes.length > 0) {
    return { allowed: false, piiTypes: [], secretTypes, reason: 'secret_detected' };
  }
  return { allowed: true, piiTypes: [], secretTypes: [] };
}

function validateProbabilityDistribution(probabilities: Record<string, number>): void {
  const keys = Object.keys(probabilities).sort();
  const expected = [...RELATIONSHIP_LABELS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new SystemOneProviderError('invalid_response', 'TypeSafe returned unexpected probability labels');
  }
  const sum = Object.values(probabilities).reduce((total, probability) => total + probability, 0);
  if (Math.abs(sum - 1) > 0.02) {
    throw new SystemOneProviderError('invalid_response', 'TypeSafe probabilities do not sum to one');
  }
}

function validateChoiceIsHighest(
  choice: SystemOneRelationshipLabel,
  probabilities: Record<string, number>,
): void {
  const highest = Math.max(...Object.values(probabilities));
  if (probabilities[choice] !== highest) {
    throw new SystemOneProviderError('invalid_response', 'TypeSafe choice is not a highest-probability option');
  }
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export class SystemOneRelationshipProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private consecutiveFailures = 0;
  private circuitOpen = false;

  constructor(
    private readonly apiKey: string,
    options: SystemOneRelationshipProviderOptions = {},
  ) {
    if (!apiKey.trim()) throw new Error('TypeSafe API key is empty');
    this.endpoint = options.endpoint ?? 'https://api.typesafe.ai/v1/systemone';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // The locked first pilot admits one HTTP attempt per queue item. Callers
    // must opt in explicitly if a later reviewed deployment permits retries.
    this.maxRetries = options.maxRetries ?? 0;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.wait = options.wait ?? defaultWait;
    if (this.endpoint !== 'https://api.typesafe.ai/v1/systemone') {
      throw new Error('TypeSafe endpoint must be https://api.typesafe.ai/v1/systemone');
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error('System One timeout must be between 100 and 60000 milliseconds');
    }
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 3) {
      throw new Error('System One retries must be between 0 and 3');
    }
  }

  async predict(
    left: string,
    right: string,
    attemptHooks?: SystemOneAttemptHooks,
  ): Promise<SystemOneRelationshipPrediction> {
    if (this.circuitOpen) {
      throw new SystemOneProviderError('circuit_open', 'System One circuit breaker is open');
    }
    const scan = scanRelationshipPairForExternalProcessing(left, right);
    if (!scan.allowed) {
      throw new Error(`Relationship pair is not eligible for external processing: ${scan.reason}`);
    }

    const [cleanedLeft, cleanedRight] = stripExactSharedSentences(left, right);
    const rawContentSha256 = pairHash(left, right);
    const cleanedContentSha256 = pairHash(cleanedLeft, cleanedRight);
    const started = performance.now();

    try {
      const { response, attempts, attemptReservationId, requestedAt } = await this.request({
        state: { memoryA: cleanedLeft, memoryB: cleanedRight },
        model: SYSTEM_ONE_RELATIONSHIP_MODEL,
        questions: {
          relationship: {
            type: 'choice',
            instructions: 'What is the strongest directed relationship of Memory B to Memory A?',
            criteria: {
              supports: 'Memory B provides evidence or confirmation for the claim in Memory A',
              refines: 'Memory B adds a narrower property, value, qualification, or implementation detail to the same claim in Memory A; a distinct activity about the same subject is insufficient',
              supersedes: 'Memory B is a newer version or state that replaces Memory A',
              relates_to: 'The memories concern the same useful subject or context but describe distinct activities or properties, and B does not prove, add specificity to, or replace A',
              unrelated: 'The memories concern different subjects and have no useful semantic relationship',
            },
          },
        },
      }, attemptHooks);
      this.consecutiveFailures = 0;
      if (response.model !== SYSTEM_ONE_RELATIONSHIP_MODEL) {
        throw new SystemOneProviderError('invalid_response', 'TypeSafe returned an unexpected model version');
      }
      const answer = response.answers.relationship;
      validateProbabilityDistribution(answer.probabilities);
      validateChoiceIsHighest(answer.choice, answer.probabilities);
      const completedAt = new Date();
      const predictionSha256 = canonicalPredictionHash({
        label: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        rawContentSha256,
        cleanedContentSha256,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });
      return {
        provider: 'typesafe-system-one',
        requestedModel: SYSTEM_ONE_RELATIONSHIP_MODEL,
        returnedModel: response.model,
        questionSet: SYSTEM_ONE_RELATIONSHIP_QUESTION_SET,
        stateEnvelope: SYSTEM_ONE_STATE_ENVELOPE,
        label: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        acceptedByGate: answer.confidence >= SYSTEM_ONE_RELATIONSHIP_CONFIDENCE_GATE,
        rawContentSha256,
        cleanedContentSha256,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        requestAttempts: attempts,
        httpResultClass: '2xx',
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        estimatedCostUsd: inputCostUsd(response.usage.input_tokens),
        requestedAt,
        completedAt,
        attemptReservationId,
        predictionSha256,
      };
    } catch (error) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 5) this.circuitOpen = true;
      throw error;
    }
  }

  private async request(body: Record<string, unknown>, attemptHooks?: SystemOneAttemptHooks): Promise<{
    response: z.infer<typeof responseSchema>;
    attempts: number;
    attemptReservationId: string;
    requestedAt: Date;
  }> {
    const maximumAttempts = this.maxRetries + 1;
    const serialisedBody = JSON.stringify(body);
    // UTF-8 bytes are a conservative token ceiling for the byte-level model
    // boundary and include the complete frozen rubric and state envelope.
    const conservativeInputTokens = Buffer.byteLength(serialisedBody, 'utf8');
    const conservativeCostUsd = conservativeInputTokens / 1_000_000 * SYSTEM_ONE_INPUT_PRICE_PER_MILLION_USD;
    for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
      const requestedAt = new Date();
      const reservation = attemptHooks
        ? await attemptHooks.reserve({
            attemptNumber: attempt,
            requestedAt,
            conservativeInputTokens,
            conservativeCostUsd,
          })
        : { attemptId: '00000000-0000-4000-8000-000000000000' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let outcome: SystemOneAttemptOutcome = 'network_error';
      let httpStatus: number | null = null;
      let usage: z.infer<typeof responseSchema>['usage'] | null = null;
      try {
        const httpResponse = await this.fetchImplementation(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: serialisedBody,
          signal: controller.signal,
        });
        httpStatus = httpResponse.status;
        if ((httpResponse.status === 429 || httpResponse.status === 529) && attempt < maximumAttempts) {
          outcome = 'rate_limited';
          await httpResponse.body?.cancel();
          const retryAfterSeconds = Number(httpResponse.headers.get('retry-after'));
          const delay = Number.isFinite(retryAfterSeconds)
            ? Math.min(Math.max(retryAfterSeconds * 1000, 0), 2_000)
            : Math.min(250 * 2 ** (attempt - 1), 2_000);
          await this.wait(delay);
          continue;
        }
        if (!httpResponse.ok) {
          await httpResponse.body?.cancel();
          const errorClass = httpResponse.status === 429 || httpResponse.status === 529
            ? 'rate_limited'
            : httpResponse.status >= 500 ? 'upstream_error' : 'invalid_response';
          throw new SystemOneProviderError(errorClass, `TypeSafe request failed with HTTP ${httpResponse.status}`);
        }
        const contentLength = Number(httpResponse.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > 65_536) {
          await httpResponse.body?.cancel();
          throw new SystemOneProviderError('invalid_response', 'TypeSafe response exceeded the size limit');
        }
        const responseText = await httpResponse.text();
        if (responseText.length > 65_536) {
          throw new SystemOneProviderError('invalid_response', 'TypeSafe response exceeded the size limit');
        }
        let json: unknown;
        try {
          json = JSON.parse(responseText);
        } catch {
          throw new SystemOneProviderError('invalid_response', 'TypeSafe returned invalid JSON');
        }
        const parsed = responseSchema.safeParse(json);
        if (!parsed.success) {
          throw new SystemOneProviderError('invalid_response', 'TypeSafe returned an invalid response shape');
        }
        if (parsed.data.model !== SYSTEM_ONE_RELATIONSHIP_MODEL) {
          throw new SystemOneProviderError('invalid_response', 'TypeSafe returned an unexpected model version');
        }
        validateProbabilityDistribution(parsed.data.answers.relationship.probabilities);
        validateChoiceIsHighest(
          parsed.data.answers.relationship.choice,
          parsed.data.answers.relationship.probabilities,
        );
        usage = parsed.data.usage;
        outcome = 'succeeded';
        return {
          response: parsed.data,
          attempts: attempt,
          attemptReservationId: reservation.attemptId,
          requestedAt,
        };
      } catch (error) {
        if (error instanceof SystemOneProviderError) {
          outcome = error.errorClass === 'circuit_open' ? 'network_error' : error.errorClass;
          throw error;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          outcome = 'timeout';
          if (attempt < maximumAttempts) continue;
          throw new SystemOneProviderError('timeout', 'TypeSafe request timed out');
        }
        outcome = 'network_error';
        if (attempt < maximumAttempts) continue;
        throw new SystemOneProviderError('network_error', 'TypeSafe request failed');
      } finally {
        clearTimeout(timer);
        if (attemptHooks) {
          await attemptHooks.finish({
            attemptId: reservation.attemptId,
            outcome,
            completedAt: new Date(),
            httpStatus,
            inputTokens: usage?.input_tokens ?? null,
            outputTokens: usage?.output_tokens ?? null,
            actualCostUsd: usage
              ? inputCostUsd(usage.input_tokens)
              : null,
          });
        }
      }
    }
    throw new SystemOneProviderError('network_error', 'TypeSafe retry limit exhausted');
  }
}
