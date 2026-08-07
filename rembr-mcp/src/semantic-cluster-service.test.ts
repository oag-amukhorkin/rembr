import { describe, expect, it } from 'vitest';
import { buildSemanticGroups } from './semantic-cluster-service.js';

function vector(x: number, y: number): number[] {
  return Array.from({ length: 12 }, (_, index) => index % 2 ? y : x);
}

describe('buildSemanticGroups', () => {
  it('forms cross-category groups from embedding proximity', () => {
    const groups = buildSemanticGroups([
      { id: '1', content: 'Orchard harvest schedule', category: 'facts', embedding: vector(1, 0) },
      { id: '2', content: 'Orchard harvest checklist', category: 'goals', embedding: vector(0.98, 0.02) },
      { id: '3', content: 'Harbour shipping schedule', category: 'facts', embedding: vector(0, 1) },
      { id: '4', content: 'Harbour shipping checklist', category: 'workflows', embedding: vector(0.02, 0.98) },
    ], 2, 'fixture-seed');

    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.items.map(item => item.id).sort())).toEqual(
      expect.arrayContaining([['1', '2'], ['3', '4']]),
    );
    expect(groups.every(group => Object.keys(group.categoryCounts).length === 2)).toBe(true);
  });

  it('returns stable groups for the same seed', () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      content: `Fixture topic ${index % 3}`,
      category: index % 2 ? 'facts' : 'goals',
      embedding: vector(index % 3, 3 - (index % 3)),
    }));

    const first = buildSemanticGroups(items, 3, 'stable-seed').map(group => group.items.map(item => item.id));
    const second = buildSemanticGroups(items, 3, 'stable-seed').map(group => group.items.map(item => item.id));
    expect(second).toEqual(first);
  });
});
