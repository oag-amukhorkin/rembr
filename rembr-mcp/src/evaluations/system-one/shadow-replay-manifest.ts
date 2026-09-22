import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { scanRelationshipPairForExternalProcessing } from '../../system-one-relationship-provider.js';

export const PILOT_FIXTURE_FILE_SHA256 = 'bdfbcde7eb1d1c3cdb533a6149c4356af2df23651ac07c96be02c61590af3bb1';
export const PILOT_BASELINE_FILE_SHA256 = '0e581a0af15401e9cbd99e1e77ddfd8fcb898de626fbf5958e4730cde0e16e3a';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceUrl(filename: string): URL {
  return new URL(`./pilot-evidence/${filename}`, import.meta.url);
}

function exactJsonLines<T>(bytes: Buffer, expectedHash: string, label: string): Array<{ raw: string; value: T }> {
  if (sha256(bytes) !== expectedHash) throw new Error(`${label} evidence SHA-256 mismatch`);
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw new Error(`${label} evidence must end with one JSONL newline`);
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== 392 || lines.some(line => !line)) {
    throw new Error(`${label} evidence must contain exactly 392 non-empty JSONL rows`);
  }
  return lines.map((raw, index) => {
    try {
      return { raw, value: JSON.parse(raw) as T };
    } catch {
      throw new Error(`${label} evidence row ${index + 1} is not valid JSON`);
    }
  });
}

type LockedFixture = {
  id: string;
  task: string;
  split: string;
  dataClassification: string;
  input: { contentA?: unknown; contentB?: unknown };
  expected: { relationship?: unknown };
  tags: unknown;
  rationale: unknown;
};

type BaselinePrediction = {
  caseId: string;
  task: string;
  provider: string;
  model: string;
  outputs: { relationship?: unknown };
  error?: unknown;
};

export interface RelationshipReplayCase {
  caseId: string;
  sourceContent: string;
  targetContent: string;
  expectedRelationship: string;
  baselineRelationship: string;
  conditionalConstraints: {
    rationale: string;
    tags: string[];
    variant: string;
    scope: 'supplied-sanitised-pair-under-frozen-rubric';
  };
  fixtureSha256: string;
  baselineSha256: string;
}

export interface RelationshipReplayManifest {
  importBatch: string;
  fixtureSetSha256: string;
  baselineSetSha256: string;
  cases: RelationshipReplayCase[];
}

function exactCounts(values: string[], expected: Record<string, number>, label: string): void {
  const observed = values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
  if (JSON.stringify(Object.fromEntries(Object.entries(observed).sort())) !==
      JSON.stringify(Object.fromEntries(Object.entries(expected).sort()))) {
    throw new Error(`${label} distribution differs from the audited evidence contract`);
  }
}

export async function buildRelationshipReplayManifest(): Promise<RelationshipReplayManifest> {
  const [fixtureBytes, baselineBytes] = await Promise.all([
    readFile(evidenceUrl('fixtures.jsonl')),
    readFile(evidenceUrl('baseline-predictions.jsonl')),
  ]);
  const fixtureRows = exactJsonLines<LockedFixture>(fixtureBytes, PILOT_FIXTURE_FILE_SHA256, 'fixture');
  const baselineRows = exactJsonLines<BaselinePrediction>(baselineBytes, PILOT_BASELINE_FILE_SHA256, 'baseline');
  const fixtureIds = fixtureRows.map(row => row.value.id);
  const baselineIds = baselineRows.map(row => row.value.caseId);
  if (new Set(fixtureIds).size !== 392 || new Set(baselineIds).size !== 392) {
    throw new Error('audited evidence contains duplicate case IDs');
  }
  const baselineById = new Map(baselineRows.map(row => [row.value.caseId, row]));
  const relationshipRows = fixtureRows.filter(row => row.value.task === 'relationship');
  if (relationshipRows.length !== 100) throw new Error('audited fixture must contain exactly 100 relationship rows');

  const cases = relationshipRows.map(({ raw, value: fixture }) => {
    const baselineRow = baselineById.get(fixture.id);
    const baseline = baselineRow?.value;
    if (!baselineRow || !baseline || baseline.task !== 'relationship' ||
        baseline.provider !== 'rembr-existing' || baseline.model !== 'deterministic-current-code' ||
        baseline.error !== undefined) {
      throw new Error(`missing or invalid audited baseline for ${fixture.id}`);
    }
    if (fixture.split !== 'locked' || fixture.dataClassification !== 'sanitised' ||
        typeof fixture.input.contentA !== 'string' || typeof fixture.input.contentB !== 'string' ||
        typeof fixture.expected.relationship !== 'string' || typeof fixture.rationale !== 'string' ||
        !Array.isArray(fixture.tags) || fixture.tags.some(tag => typeof tag !== 'string') ||
        typeof baseline.outputs.relationship !== 'string') {
      throw new Error(`invalid locked relationship evidence for ${fixture.id}`);
    }
    const scan = scanRelationshipPairForExternalProcessing(
      fixture.input.contentA,
      fixture.input.contentB,
    );
    if (!scan.allowed) throw new Error(`audited fixture ${fixture.id} failed local scanner: ${scan.reason}`);
    const tags = fixture.tags as string[];
    return {
      caseId: fixture.id,
      sourceContent: fixture.input.contentA,
      targetContent: fixture.input.contentB,
      expectedRelationship: fixture.expected.relationship,
      baselineRelationship: baseline.outputs.relationship,
      conditionalConstraints: {
        rationale: fixture.rationale,
        tags: [...tags],
        variant: tags.find(tag =>
          ['plain', 'irrelevant-prefix', 'irrelevant-suffix', 'adversarial-quote'].includes(tag),
        ) ?? 'unknown',
        scope: 'supplied-sanitised-pair-under-frozen-rubric' as const,
      },
      fixtureSha256: sha256(raw),
      baselineSha256: sha256(baselineRow.raw),
    };
  });

  if (new Set(cases.map(item => item.caseId)).size !== 100 ||
      new Set(cases.flatMap(item => [item.sourceContent, item.targetContent])).size !== 200) {
    throw new Error('audited relationship evidence must map 100 unique IDs to 200 unique texts');
  }
  exactCounts(cases.map(item => item.expectedRelationship), {
    supports: 20, refines: 20, supersedes: 20, relates_to: 20, unrelated: 20,
  }, 'expected relationship');
  exactCounts(cases.map(item => item.baselineRelationship), {
    supports: 4, supersedes: 9, relates_to: 68, unrelated: 19,
  }, 'baseline relationship');

  return {
    importBatch: `system-one-relationship-locked-v1-${PILOT_FIXTURE_FILE_SHA256.slice(0, 16)}`,
    fixtureSetSha256: PILOT_FIXTURE_FILE_SHA256,
    baselineSetSha256: PILOT_BASELINE_FILE_SHA256,
    cases,
  };
}
