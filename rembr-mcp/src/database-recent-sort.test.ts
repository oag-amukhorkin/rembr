import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDatabase } from './database.js';

describe('MemoryDatabase.getRecentMemories ordering', () => {
  let db: MemoryDatabase | undefined;

  afterEach(async () => {
    await db?.dbPool.end();
  });

  function setup() {
    db = new MemoryDatabase('postgresql://unused:unused@localhost/unused');
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT * FROM memories') ? [] : [] }));
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => undefined) };
    (db as any).pool = pool;
    (db as any).readPool = null;
    return { db, query };
  }

  it('preserves insertion-time ordering by default', async () => {
    const { db, query } = setup();
    await db.getRecentMemories('tenant-1', 2, 'facts');

    const select = query.mock.calls.find(([sql]) => sql.startsWith('SELECT * FROM memories'))!;
    expect(select[0]).toContain('AND category = $2 ORDER BY created_at DESC LIMIT $3');
    expect(select[1]).toEqual(['tenant-1', 'facts', 2]);
  });

  it('uses a guarded effective timestamp before applying the limit', async () => {
    const { db, query } = setup();
    await db.getRecentMemories('tenant-1', 50, undefined, 'source_created_at');

    const select = query.mock.calls.find(([sql]) => sql.startsWith('SELECT * FROM memories'))!;
    expect(select[0]).toContain("pg_input_is_valid(metadata->>'source_created_at', 'timestamptz')");
    expect(select[0]).toContain("THEN (metadata->>'source_created_at')::timestamptz");
    expect(select[0]).toContain('ELSE created_at');
    expect(select[0]).toContain('END DESC, created_at DESC, id DESC LIMIT $2');
    expect(select[1]).toEqual(['tenant-1', 50]);
  });

  it('counts every memory in each category', async () => {
    const { db, query } = setup();
    query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith('SELECT category')
        ? [{ category: 'facts', count: 2400 }, { category: 'decisions', count: 875 }]
        : []
    }));

    await expect(db.getMemoryCountsByCategory('tenant-1')).resolves.toEqual({
      facts: 2400,
      decisions: 875
    });
    const select = query.mock.calls.find(([sql]) => sql.startsWith('SELECT category'))!;
    expect(select[0]).toContain('GROUP BY category');
    expect(select[1]).toEqual(['tenant-1']);
  });
});
