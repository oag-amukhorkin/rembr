import { buildBoundaryFixtures } from './boundary-fixtures.js';
import { buildFixtures } from './fixtures.js';
import type { EvaluationCase } from './types.js';

export type FixtureSet = 'synthetic' | 'boundary';

export function selectedFixtureSet(): FixtureSet {
  const value = process.env.EVALUATION_FIXTURE_SET || 'synthetic';
  if (value !== 'synthetic' && value !== 'boundary') {
    throw new Error(`Invalid EVALUATION_FIXTURE_SET: ${value}`);
  }
  return value;
}

export function buildSelectedFixtures(fixtureSet = selectedFixtureSet()): EvaluationCase[] {
  return fixtureSet === 'boundary' ? buildBoundaryFixtures() : buildFixtures();
}

export function evaluationRoot(fixtureSet: FixtureSet): string {
  return fixtureSet === 'boundary' ? 'system-one-boundary' : 'system-one';
}
