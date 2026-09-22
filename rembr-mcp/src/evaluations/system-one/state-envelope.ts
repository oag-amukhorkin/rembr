export type EvaluationStateEnvelope = 'raw-v1' | 'strip-shared-sentences-v1';

function sentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
}

/**
 * Remove exact sentence-level boilerplate shared by both sides while retaining
 * at least one distinct sentence on each side. This is deliberately narrow:
 * it does not paraphrase, summarise, or ask a model to decide what is relevant.
 */
export function stripSharedSentences(left: string, right: string): [string, string] {
  const leftSentences = sentences(left);
  const rightSentences = sentences(right);
  const shared = new Set(leftSentences.filter(sentence => rightSentences.includes(sentence)));
  const cleanLeft = leftSentences.filter(sentence => !shared.has(sentence));
  const cleanRight = rightSentences.filter(sentence => !shared.has(sentence));
  if (cleanLeft.length === 0 || cleanRight.length === 0) return [left, right];
  return [cleanLeft.join(' '), cleanRight.join(' ')];
}

export function selectedStateEnvelope(): EvaluationStateEnvelope {
  const value = process.env.EVALUATION_STATE_ENVELOPE || 'raw-v1';
  if (value !== 'raw-v1' && value !== 'strip-shared-sentences-v1') {
    throw new Error(`Invalid EVALUATION_STATE_ENVELOPE: ${value}`);
  }
  return value;
}
