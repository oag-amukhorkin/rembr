import { performance } from 'node:perf_hooks';
import { stripSharedSentences, type EvaluationStateEnvelope } from './state-envelope.js';
import type { EvaluationCase, EvaluationPrediction } from './types.js';

type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
};

type JevQuestion = ChoiceQuestion | NoulQuestion;

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

interface NoulAnswer {
  type: 'noul';
  noul: number;
}

interface JevResponse {
  model: string;
  answers: Record<string, ChoiceAnswer | NoulAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

const PRICE_PER_MILLION_INPUT_TOKENS = 0.042;

function questionsFor(testCase: EvaluationCase): Record<string, JevQuestion> {
  switch (testCase.task) {
    case 'query_intent':
      return {
        category: {
          type: 'choice',
          instructions: 'Which durable-memory category best matches the query?',
          criteria: {
            facts: 'Reference facts, specifications, or documented details; choose this when the requested information is factual even if the subject name includes flow or process',
            patterns: 'Reusable designs, architecture patterns, templates, or implementation approaches',
            decisions: 'Choices, trade-offs, rationale, or decision records',
            workflows: 'The information sought is procedural steps, a runbook, or how to carry out work; do not choose this merely because the subject is named a flow or process',
            insights: 'Analysis, measurements, optimisation findings, or operational observations; not lessons explicitly framed as something learned or discovered',
            projects: 'Project status, roadmaps, milestones, releases, or features',
            conversations: 'Information whose source and subject are discussions, meeting notes, agreements, or what people said',
            learning: 'Discoveries, lessons, knowledge gained, or new understanding, especially when explicitly framed as learned or discovered',
          },
        },
        intent: {
          type: 'choice',
          instructions: 'What action does the query ask the memory system to perform?',
          criteria: {
            search: 'Retrieve, find, show, or recall existing information',
            store: 'Remember, record, retain, capture, or save information',
            analyze: 'Compare, review, assess, analyse, or summarise information',
          },
        },
      };
    case 'content_importance':
      return {
        importance: {
          type: 'choice',
          instructions: 'Classify the functional importance of this conversation block for durable memory.',
          criteria: {
            decision: 'A substantive durable choice, binding constraint, policy, conclusion, or approved strategy; not merely an agent saying it will take an action',
            user_request: 'A request, instruction, desired outcome, or work the user asks to be done',
            technical_detail: 'A substantive implementation, architecture, data, interface, runtime, or operational claim; a conversational fragment that only names a technology is insufficient',
            acknowledgment: 'Confirmation, thanks, receipt, agreement, or a brief commitment such as will do that adds no new substantive choice',
            filler: 'Conversational scaffolding, hesitation, transition, or agent process narration such as um, basically, actually, let me check, or I will go ahead, even when it names a technical subject',
          },
        },
      };
    case 'contradiction':
      return {
        contradiction: {
          type: 'noul',
          instructions: 'Do Memory A and Memory B make incompatible claims about the same subject and scope, such that both cannot be true at the same time? Treat normal temporal evolution, extra detail, different subjects, different environments, and quoted instructions as non-contradictions.',
          criteria: {
            true: 'The same fact, rule, exclusive choice, or numeric property has incompatible values in the same scope',
            false: 'The statements are compatible, unrelated, differently scoped, or explicitly describe change over time',
          },
        },
      };
    case 'relationship':
      return {
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
      };
  }
}

function stateFor(testCase: EvaluationCase, stateEnvelope: EvaluationStateEnvelope): unknown {
  switch (testCase.task) {
    case 'query_intent':
      return { query: testCase.input.query };
    case 'content_importance':
      return { content: testCase.input.content, speaker: testCase.input.source };
    case 'contradiction':
      if (stateEnvelope === 'strip-shared-sentences-v1') {
        const memoryA = testCase.input.memoryA as Record<string, unknown>;
        const memoryB = testCase.input.memoryB as Record<string, unknown>;
        const [contentA, contentB] = stripSharedSentences(String(memoryA.content), String(memoryB.content));
        return { memoryA: { ...memoryA, content: contentA }, memoryB: { ...memoryB, content: contentB } };
      }
      return { memoryA: testCase.input.memoryA, memoryB: testCase.input.memoryB };
    case 'relationship': {
      if (stateEnvelope === 'strip-shared-sentences-v1') {
        const [memoryA, memoryB] = stripSharedSentences(
          String(testCase.input.contentA),
          String(testCase.input.contentB),
        );
        return { memoryA, memoryB };
      }
      return { memoryA: testCase.input.contentA, memoryB: testCase.input.contentB };
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export class JevProvider {
  readonly provider = 'typesafe-system-one-rembr-j2';
  readonly model = 'jev-1.13.0';
  readonly questionSet = 'rembr-system-one-j2-2026-09-17';
  readonly pricePerMillionInputTokens = PRICE_PER_MILLION_INPUT_TOKENS;

  constructor(
    private readonly apiKey: string,
    private readonly allowSanitised = false,
    readonly stateEnvelope: EvaluationStateEnvelope = 'raw-v1',
  ) {
    if (!apiKey.trim()) throw new Error('TypeSafe API key is empty');
  }

  async predict(testCase: EvaluationCase): Promise<EvaluationPrediction> {
    if (testCase.dataClassification !== 'synthetic' && !this.allowSanitised) {
      throw new Error(`Refusing to send non-synthetic case ${testCase.id}`);
    }
    const started = performance.now();
    try {
      const response = await this.request({
        state: stateFor(testCase, this.stateEnvelope),
        model: this.model,
        questions: questionsFor(testCase),
      });
      const outputs: Record<string, string> = {};
      const confidence: Record<string, number> = {};
      const probabilities: Record<string, Record<string, number>> = {};
      for (const [name, answer] of Object.entries(response.answers)) {
        if (answer.type === 'choice') {
          outputs[name] = answer.choice;
          confidence[name] = answer.confidence;
          probabilities[name] = answer.probabilities;
        } else {
          outputs[name] = answer.noul >= 0.5 ? 'yes' : 'no';
          confidence[name] = Math.abs(answer.noul - 0.5) * 2;
          probabilities[name] = { no: 1 - answer.noul, yes: answer.noul };
        }
      }
      const inputTokens = response.usage.input_tokens;
      return {
        caseId: testCase.id,
        task: testCase.task,
        provider: this.provider,
        model: response.model,
        outputs,
        confidence,
        probabilities,
        usage: {
          inputTokens,
          outputTokens: response.usage.output_tokens,
          estimatedCostUsd: inputTokens / 1_000_000 * PRICE_PER_MILLION_INPUT_TOKENS,
        },
        durationMs: Number((performance.now() - started).toFixed(3)),
      };
    } catch (error) {
      return {
        caseId: testCase.id,
        task: testCase.task,
        provider: this.provider,
        model: this.model,
        outputs: {},
        durationMs: Number((performance.now() - started).toFixed(3)),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async request(body: Record<string, unknown>): Promise<JevResponse> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if ((response.status === 429 || response.status === 529) && attempt < 3) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          await wait(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt);
          continue;
        }
        const responseText = await response.text();
        if (!response.ok) {
          throw new Error(`TypeSafe HTTP ${response.status}: ${responseText.slice(0, 500)}`);
        }
        const parsed = JSON.parse(responseText) as JevResponse;
        if (!parsed.answers || !parsed.usage || typeof parsed.usage.input_tokens !== 'number') {
          throw new Error('TypeSafe returned an invalid response shape');
        }
        return parsed;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('TypeSafe retry limit exhausted');
  }
}
