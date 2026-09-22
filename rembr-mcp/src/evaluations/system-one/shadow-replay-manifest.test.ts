import { describe, expect, it } from 'vitest';
import {
  buildRelationshipReplayManifest,
  PILOT_BASELINE_FILE_SHA256,
  PILOT_FIXTURE_FILE_SHA256,
} from './shadow-replay-manifest.js';

describe('locked relationship replay manifest', () => {
  it('maps the audited files to the exact 100 sanitised relationship cases', async () => {
    const manifest = await buildRelationshipReplayManifest();
    expect(manifest).toMatchObject({
      fixtureSetSha256: PILOT_FIXTURE_FILE_SHA256,
      baselineSetSha256: PILOT_BASELINE_FILE_SHA256,
    });
    expect(manifest.cases).toHaveLength(100);
    expect(new Set(manifest.cases.map(item => item.caseId)).size).toBe(100);
    expect(new Set(manifest.cases.flatMap(item => [item.sourceContent, item.targetContent])).size).toBe(200);
    expect(manifest.cases.every(item => item.fixtureSha256.length === 64 &&
      item.baselineSha256.length === 64)).toBe(true);
  });

  it('retains unrelated labels and exact audited class distributions', async () => {
    const manifest = await buildRelationshipReplayManifest();
    const count = (field: 'expectedRelationship' | 'baselineRelationship') =>
      Object.fromEntries([...manifest.cases.reduce<Map<string, number>>((result, item) => {
        result.set(item[field], (result.get(item[field]) ?? 0) + 1);
        return result;
      }, new Map()).entries()].sort());
    expect(count('expectedRelationship')).toEqual({
      refines: 20, relates_to: 20, supersedes: 20, supports: 20, unrelated: 20,
    });
    expect(count('baselineRelationship')).toEqual({
      relates_to: 68, supersedes: 9, supports: 4, unrelated: 19,
    });
  });
});
