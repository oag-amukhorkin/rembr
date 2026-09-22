import { describe, expect, it, vi } from 'vitest';
import { MemoryRelationshipService } from './memory-relationship-service.js';

function createService() {
  return new MemoryRelationshipService(
    { query: vi.fn() } as any,
    { generateEmbedding: vi.fn() } as any
  ) as any;
}

describe('MemoryRelationshipService contradiction heuristics', () => {
  it('detects direct negated predicates on the same subject', () => {
    const service = createService();

    expect(service.hasContradictionPattern(
      'The system is operational',
      'The system is not operational'
    )).toBe(true);
  });

  it('does not flag unrelated text just because one side contains not', () => {
    const service = createService();

    expect(service.hasContradictionPattern(
      'Rembr production is hosted on the test cluster and serves MCP traffic.',
      'API key last_used_at is not reliable proof of recent agent activity.'
    )).toBe(false);
  });

  it('does not flag unrelated true/false or yes/no words without shared subject terms', () => {
    const service = createService();

    expect(service.hasContradictionPattern(
      'The import job returned false for one optional flag.',
      'The deployment approval answer is yes.'
    )).toBe(false);
  });
});

describe('MemoryRelationshipService observational trace', () => {
  it('returns the existing top-eight result unchanged and emits content-free candidate traces', async () => {
    const service = createService();
    const target = {
      id: 'source-memory',
      content: 'The deployment uses a bounded relationship worker.',
      category: 'projects',
      metadata: {},
      created_at: new Date('2026-09-18T00:00:00Z'),
      embedding: [1, 0],
    };
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      id: `target-${index}`,
      content: index === 9
        ? 'A completely separate subject about catering menus.'
        : `The deployment relationship worker processes bounded candidate ${index}.`,
      category: 'projects',
      metadata: {},
      created_at: new Date('2026-09-18T00:00:00Z'),
      embedding: index === 9 ? [0, 1] : [1, 0],
    }));

    vi.spyOn(service, 'getMemory').mockResolvedValue(target);
    vi.spyOn(service, 'getCandidateMemories').mockResolvedValue(candidates);

    const traced = await service.inferRelationshipsWithTrace(
      'source-memory',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    );
    const publicResult = await service.inferRelationshipsForMemory(
      'source-memory',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    );

    expect(publicResult).toEqual(traced.relationships);
    expect(traced.relationships).toHaveLength(8);
    expect(traced.trace).toHaveLength(10);
    expect(traced.trace.filter(item => item.selected_for_write)).toHaveLength(8);
    expect(traced.trace.find(item => item.target_memory_id === 'target-9')).toMatchObject({
      decision_reason: 'below_similarity',
      selected_for_write: false,
    });
    for (const item of traced.trace) {
      expect(item).not.toHaveProperty('content');
      expect(item).not.toHaveProperty('evidence');
    }
  });
});
