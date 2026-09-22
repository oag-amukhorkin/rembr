import { describe, expect, it } from 'vitest';
import { buildBoundaryFixtures } from './boundary-fixtures.js';

describe('System One boundary fixtures', () => {
  const fixtures = buildBoundaryFixtures();

  it('contains 392 locked, sanitised cases', () => {
    expect(fixtures).toHaveLength(392);
    expect(new Set(fixtures.map(item => item.split))).toEqual(new Set(['locked']));
    expect(new Set(fixtures.map(item => item.dataClassification))).toEqual(new Set(['sanitised']));
  });

  it('has four perturbations for every human-adjudicated seed', () => {
    const bySeed = new Map<string, string[]>();
    for (const fixture of fixtures) {
      const seed = fixture.id.replace(/-\d$/, '');
      bySeed.set(seed, [...(bySeed.get(seed) ?? []), fixture.tags[2]]);
    }
    expect(bySeed.size).toBe(98);
    for (const variants of bySeed.values()) {
      expect(new Set(variants)).toEqual(new Set([
        'plain',
        'irrelevant-prefix',
        'irrelevant-suffix',
        'adversarial-quote',
      ]));
    }
  });

  it('contains every expected label for every decision output', () => {
    expect(new Set(fixtures.filter(item => item.task === 'query_intent').map(item => item.expected.category)))
      .toEqual(new Set(['facts', 'patterns', 'decisions', 'workflows', 'insights', 'projects', 'conversations', 'learning']));
    expect(new Set(fixtures.filter(item => item.task === 'query_intent').map(item => item.expected.intent)))
      .toEqual(new Set(['search', 'store', 'analyze']));
    expect(new Set(fixtures.filter(item => item.task === 'content_importance').map(item => item.expected.importance)))
      .toEqual(new Set(['decision', 'user_request', 'technical_detail', 'acknowledgment', 'filler']));
    expect(new Set(fixtures.filter(item => item.task === 'contradiction').map(item => item.expected.contradiction)))
      .toEqual(new Set(['yes', 'no']));
    expect(new Set(fixtures.filter(item => item.task === 'relationship').map(item => item.expected.relationship)))
      .toEqual(new Set(['supports', 'refines', 'supersedes', 'relates_to', 'unrelated']));
  });

  it('contains no duplicate task inputs', () => {
    const keys = fixtures.map(item => `${item.task}:${JSON.stringify(item.input)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
