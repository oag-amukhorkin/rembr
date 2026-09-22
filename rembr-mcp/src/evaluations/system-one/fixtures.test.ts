import { describe, expect, it } from 'vitest';
import { buildFixtures } from './fixtures.js';
import type { EvaluationCase, EvaluationSplit } from './types.js';

const SPLITS: EvaluationSplit[] = ['development', 'calibration', 'locked'];
const FIELDS: Record<EvaluationCase['task'], string[]> = {
  query_intent: ['category', 'intent'],
  content_importance: ['importance'],
  contradiction: ['contradiction'],
  relationship: ['relationship'],
};

describe('system-one evaluation fixtures', () => {
  it('contains no duplicate task inputs', () => {
    const fixtures = buildFixtures();
    const keys = fixtures.map(testCase => `${testCase.task}|${JSON.stringify(testCase.input)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('represents every output class in development, calibration and locked splits', () => {
    const fixtures = buildFixtures();
    for (const task of Object.keys(FIELDS) as EvaluationCase['task'][]) {
      const taskCases = fixtures.filter(testCase => testCase.task === task);
      for (const field of FIELDS[task]) {
        const allLabels = new Set(taskCases.map(testCase => testCase.expected[field]));
        for (const split of SPLITS) {
          const splitLabels = new Set(
            taskCases.filter(testCase => testCase.split === split).map(testCase => testCase.expected[field]),
          );
          expect(splitLabels, `${task}.${field} in ${split}`).toEqual(allLabels);
        }
      }
    }
  });

  it('preserves the 20/30/50 split for every relationship class and wording style', () => {
    const cases = buildFixtures().filter(testCase => testCase.task === 'relationship');
    for (const relationship of ['supports', 'refines', 'supersedes', 'relates_to', 'unrelated']) {
      for (const style of ['wording-explicit', 'wording-keyword-light']) {
        const stratum = cases.filter(testCase =>
          testCase.expected.relationship === relationship && testCase.tags.includes(style),
        );
        expect(stratum).toHaveLength(60);
        expect(stratum.filter(testCase => testCase.split === 'development')).toHaveLength(12);
        expect(stratum.filter(testCase => testCase.split === 'calibration')).toHaveLength(18);
        expect(stratum.filter(testCase => testCase.split === 'locked')).toHaveLength(30);
      }
    }
  });
});
