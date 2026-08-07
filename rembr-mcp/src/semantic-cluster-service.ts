import { randomUUID } from 'node:crypto';
import { MemoryDatabase, type Memory } from './database.js';

const LEAF_MEMORY_LIMIT = 240;
const MAX_ROOT_CHILDREN = 12;
const MAX_CHILDREN = 8;
const MAX_LEVEL = 4;
const PROJECTED_DIMENSIONS = 96;
const KMEANS_ITERATIONS = 6;
const HIERARCHY_VERSION = 4;

interface ClusterItem {
  id: string;
  content: string;
  category: string;
  embedding: number[];
}

interface ClusterGroup {
  items: ClusterItem[];
  centroid: number[];
  label: string;
  categoryCounts: Record<string, number>;
}

interface StoredCluster {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  level: number;
  label: string;
  centroid: string | number[];
  memory_count: number;
  total_memory_count?: number;
  category_counts: Record<string, number> | string;
  is_leaf: boolean;
  generated_at: Date | string;
  source_embedding_count?: number | null;
  source_embedding_at?: Date | string | null;
  algorithm_version?: number | null;
}

export interface SemanticClusterSummary {
  id: string;
  parent_id: string | null;
  level: number;
  label: string;
  memory_count: number;
  total_memory_count: number;
  is_leaf: boolean;
  category_counts: Record<string, number>;
  dominant_category: string | null;
}

export interface SemanticClusterView {
  cluster: SemanticClusterSummary;
  breadcrumbs: SemanticClusterSummary[];
  children: SemanticClusterSummary[];
  links: Array<{ source: string; target: string; similarity: number }>;
  memories: Memory[];
  edges: Array<{ source: string; target: string; weight: number }>;
  leaf_limit: number;
  total_children: number;
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'been', 'before', 'being', 'between', 'both', 'but', 'could',
  'current', 'does', 'each', 'from', 'have', 'into', 'memory', 'more', 'most', 'other', 'over',
  'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'through', 'using', 'very', 'were', 'what', 'when', 'where', 'which', 'while',
  'will', 'with', 'would', 'your', 'work', 'works', 'used', 'uses', 'only', 'must', 'need', 'the',
  'for', 'not', 'has', 'had', 'was', 'its', 'can', 'all', 'any', 'our', 'out', 'now', 'new',
]);

function parseVector(value: string | number[]): number[] {
  if (Array.isArray(value)) return value.map(Number);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Invalid pgvector value');
  return parsed.map(Number);
}

function normalize(vector: number[]): number[] {
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aLength = 0;
  let bLength = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    aLength += a[index] * a[index];
    bLength += b[index] * b[index];
  }
  return aLength && bLength ? dot / Math.sqrt(aLength * bLength) : 0;
}

function project(vector: number[]): number[] {
  if (vector.length <= PROJECTED_DIMENSIONS) return normalize(vector);
  const projected: number[] = [];
  const stride = vector.length / PROJECTED_DIMENSIONS;
  for (let index = 0; index < PROJECTED_DIMENSIONS; index++) {
    projected.push(vector[Math.floor(index * stride)]);
  }
  return normalize(projected);
}

function stableIndex(seed: string, length: number): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % length;
}

function categoryCounts(items: ClusterItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;
  return counts;
}

function termsOf(content: string): Set<string> {
  return new Set(
    content
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{2,}/gu)
      ?.filter(term => !STOP_WORDS.has(term) && !/^\d+$/.test(term)) ?? [],
  );
}

function clusterLabel(items: ClusterItem[], corpusFrequency: Map<string, number>, corpusSize: number): string {
  const localFrequency = new Map<string, number>();
  const sample = items.slice(0, 120);
  for (const item of sample) {
    for (const term of termsOf(item.content)) localFrequency.set(term, (localFrequency.get(term) ?? 0) + 1);
  }

  const terms = [...localFrequency.entries()]
    .map(([term, count]) => ({
      term,
      score: (count / sample.length) * Math.log((corpusSize + 1) / ((corpusFrequency.get(term) ?? 0) + 1)) * Math.log2(count + 2),
    }))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, 3)
    .map(({ term }) => term);
  if (terms.length) return terms.join(' ');

  const fallback = items[0]?.content.split(/\r?\n/)[0].trim() || 'Related memories';
  return fallback.length > 42 ? `${fallback.slice(0, 39)}...` : fallback;
}

function fullCentroid(items: ClusterItem[]): number[] {
  const sums = new Array(items[0].embedding.length).fill(0);
  for (const item of items) {
    for (let index = 0; index < sums.length; index++) sums[index] += item.embedding[index];
  }
  return sums.map(value => value / items.length);
}

export function buildSemanticGroups(items: ClusterItem[], requestedGroups: number, seed: string): ClusterGroup[] {
  if (!items.length) return [];
  if (items.length === 1 || requestedGroups <= 1) {
    const frequency = new Map<string, number>();
    for (const term of termsOf(items[0].content)) frequency.set(term, 1);
    return [{ items, centroid: fullCentroid(items), label: clusterLabel(items, frequency, 1), categoryCounts: categoryCounts(items) }];
  }

  const vectors = items.map(item => project(item.embedding));
  const groupCount = Math.min(requestedGroups, items.length);
  const seedIndexes = [stableIndex(seed, items.length)];
  const minimumDistances = vectors.map(vector => 1 - cosine(vector, vectors[seedIndexes[0]]));

  while (seedIndexes.length < groupCount) {
    let nextIndex = 0;
    for (let index = 1; index < minimumDistances.length; index++) {
      if (minimumDistances[index] > minimumDistances[nextIndex]) nextIndex = index;
    }
    if (seedIndexes.includes(nextIndex)) break;
    seedIndexes.push(nextIndex);
    for (let index = 0; index < vectors.length; index++) {
      minimumDistances[index] = Math.min(minimumDistances[index], 1 - cosine(vectors[index], vectors[nextIndex]));
    }
  }

  let centroids = seedIndexes.map(index => [...vectors[index]]);
  let assignments = new Array(items.length).fill(-1);
  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration++) {
    const nextAssignments = vectors.map(vector => {
      let best = 0;
      let bestSimilarity = -Infinity;
      for (let index = 0; index < centroids.length; index++) {
        const similarity = cosine(vector, centroids[index]);
        if (similarity > bestSimilarity) {
          best = index;
          bestSimilarity = similarity;
        }
      }
      return best;
    });
    const unchanged = nextAssignments.every((value, index) => value === assignments[index]);
    assignments = nextAssignments;
    if (unchanged) break;

    const sums = centroids.map(() => new Array(vectors[0].length).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let itemIndex = 0; itemIndex < vectors.length; itemIndex++) {
      const groupIndex = assignments[itemIndex];
      counts[groupIndex] += 1;
      for (let dimension = 0; dimension < vectors[itemIndex].length; dimension++) {
        sums[groupIndex][dimension] += vectors[itemIndex][dimension];
      }
    }
    centroids = centroids.map((centroid, index) => counts[index] ? normalize(sums[index]) : centroid);
  }

  let grouped = centroids
    .map((_, groupIndex) => items.filter((__, itemIndex) => assignments[itemIndex] === groupIndex))
    .filter(group => group.length > 0);
  if (grouped.length === 1 && items.length > 1) {
    grouped = Array.from({ length: groupCount }, (_, groupIndex) =>
      items.filter((_, itemIndex) => itemIndex % groupCount === groupIndex),
    ).filter(group => group.length > 0);
  }

  const corpusFrequency = new Map<string, number>();
  for (const item of items) {
    for (const term of termsOf(item.content)) corpusFrequency.set(term, (corpusFrequency.get(term) ?? 0) + 1);
  }
  return grouped.map(groupItems => ({
    items: groupItems,
    centroid: fullCentroid(groupItems),
    label: clusterLabel(groupItems, corpusFrequency, items.length),
    categoryCounts: categoryCounts(groupItems),
  }));
}

export class SemanticClusterService {
  constructor(private readonly database: MemoryDatabase) {}

  async getView(tenantId: string, clusterId?: string, minEdgeWeight = 0.68, filterQuery?: string): Promise<SemanticClusterView> {
    const root = await this.ensureRoot(tenantId);
    let target = clusterId ? await this.getCluster(tenantId, clusterId) : root;
    if (!target) throw new Error('Semantic cluster is no longer available; reload the overview');

    if (!target.is_leaf) {
      await this.ensureChildren(tenantId, target);
      target = (await this.getCluster(tenantId, target.id)) ?? target;
    }

    const query = filterQuery?.trim() || undefined;
    const allChildren = await this.getChildren(tenantId, target.id);
    const children = query ? await this.getFilteredChildren(tenantId, target.id, query) : allChildren;
    const breadcrumbs = await this.getBreadcrumbs(tenantId, target.id);
    const memories = target.is_leaf ? await this.getClusterMemories(tenantId, target.id, query) : [];
    const filteredTarget = query
      ? this.withFilteredCounts(target, target.is_leaf
        ? memories.map(memory => ({ category_counts: { [memory.category]: 1 }, memory_count: 1 }))
        : children)
      : target;
    const edges = memories.length > 1
      ? await this.database.getEmbeddingSimilarityEdges(tenantId, memories.map(memory => memory.id), minEdgeWeight)
      : [];

    const childVectors = children.map(child => ({ child, vector: parseVector(child.centroid) }));
    const links: SemanticClusterView['links'] = [];
    for (let left = 0; left < childVectors.length; left++) {
      for (let right = left + 1; right < childVectors.length; right++) {
        links.push({
          source: childVectors[left].child.id,
          target: childVectors[right].child.id,
          similarity: cosine(childVectors[left].vector, childVectors[right].vector),
        });
      }
    }

    return {
      cluster: this.toSummary(filteredTarget),
      breadcrumbs: breadcrumbs.map(cluster => this.toSummary(cluster)),
      children: children.map(cluster => this.toSummary(cluster)),
      links,
      memories,
      edges: edges.map(edge => ({ source: edge.source, target: edge.target, weight: edge.similarity })),
      leaf_limit: LEAF_MEMORY_LIMIT,
      total_children: allChildren.length,
    };
  }

  private async ensureRoot(tenantId: string): Promise<StoredCluster> {
    const client = await this.database.dbPool.connect();
    try {
      await client.query('BEGIN');
      await this.database.setTenantContext(client, tenantId);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`semantic-clusters:${tenantId}`]);
      const source = await client.query(
        `SELECT COUNT(*)::int AS count, MAX(e.created_at) AS latest
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
         WHERE m.tenant_id = $1`,
        [tenantId],
      );
      const sourceCount = Number(source.rows[0]?.count ?? 0);
      if (!sourceCount) throw new Error('No embedded memories are available for semantic clustering');

      const existing = await client.query(
        `SELECT *, centroid::text AS centroid
         FROM semantic_clusters
         WHERE tenant_id = $1 AND parent_id IS NULL
         ORDER BY generated_at DESC
         LIMIT 1`,
        [tenantId],
      );
      const current = existing.rows[0] as StoredCluster | undefined;
      const sourceLatest = source.rows[0]?.latest ? new Date(source.rows[0].latest).getTime() : 0;
      const currentLatest = current?.source_embedding_at ? new Date(current.source_embedding_at).getTime() : 0;
      if (current && current.algorithm_version === HIERARCHY_VERSION && current.source_embedding_count === sourceCount && currentLatest >= sourceLatest) {
        await client.query('COMMIT');
        return current;
      }

      await client.query('DELETE FROM semantic_clusters WHERE tenant_id = $1', [tenantId]);
      const aggregate = await client.query(
        `SELECT AVG(e.embedding)::text AS centroid,
                jsonb_object_agg(category, count) AS category_counts
         FROM (
           SELECT m.category, COUNT(*)::int AS count
           FROM memories m
           JOIN memory_embeddings e ON e.memory_id = m.id
           WHERE m.tenant_id = $1
           GROUP BY m.category
         ) categories
         CROSS JOIN LATERAL (
           SELECT AVG(e2.embedding) AS embedding
           FROM memory_embeddings e2
           JOIN memories m2 ON m2.id = e2.memory_id
           WHERE m2.tenant_id = $1
         ) e`,
        [tenantId],
      );
      const rootId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO semantic_clusters (
           id, tenant_id, parent_id, level, label, centroid, memory_count, category_counts,
           is_leaf, source_embedding_count, source_embedding_at, algorithm_version
         ) VALUES ($1, $2, NULL, 0, 'All memories', $3::vector, $4, $5::jsonb, $6, $4, $7, $8)
         RETURNING *, centroid::text AS centroid`,
        [
          rootId,
          tenantId,
          aggregate.rows[0].centroid,
          sourceCount,
          JSON.stringify(aggregate.rows[0].category_counts ?? {}),
          sourceCount <= LEAF_MEMORY_LIMIT,
          source.rows[0].latest,
          HIERARCHY_VERSION,
        ],
      );
      await client.query(
        `INSERT INTO semantic_cluster_members (cluster_id, memory_id)
         SELECT $1, e.memory_id
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
         WHERE m.tenant_id = $2`,
        [rootId, tenantId],
      );
      await client.query('COMMIT');
      return inserted.rows[0] as StoredCluster;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureChildren(tenantId: string, cluster: StoredCluster): Promise<void> {
    const client = await this.database.dbPool.connect();
    try {
      await client.query('BEGIN');
      await this.database.setTenantContext(client, tenantId);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`semantic-clusters:${tenantId}`]);
      const existing = await client.query(
        'SELECT 1 FROM semantic_clusters WHERE tenant_id = $1 AND parent_id = $2 LIMIT 1',
        [tenantId, cluster.id],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        return;
      }

      const rows = await client.query(
        `SELECT m.id, m.content, m.category, e.embedding::text AS embedding
         FROM semantic_cluster_members scm
         JOIN semantic_clusters sc ON sc.id = scm.cluster_id
         JOIN memories m ON m.id = scm.memory_id
         JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE scm.cluster_id = $1 AND sc.tenant_id = $2
         ORDER BY m.id`,
        [cluster.id, tenantId],
      );
      const items: ClusterItem[] = rows.rows.map(row => ({
        id: row.id,
        content: row.content,
        category: row.category,
        embedding: parseVector(row.embedding),
      }));
      if (items.length <= LEAF_MEMORY_LIMIT || cluster.level >= MAX_LEVEL) {
        await client.query('UPDATE semantic_clusters SET is_leaf = TRUE WHERE id = $1 AND tenant_id = $2', [cluster.id, tenantId]);
        await client.query('COMMIT');
        return;
      }

      const maxChildren = cluster.level === 0 ? MAX_ROOT_CHILDREN : MAX_CHILDREN;
      const requestedGroups = Math.min(maxChildren, Math.max(2, Math.ceil(items.length / LEAF_MEMORY_LIMIT)));
      const groups = buildSemanticGroups(items, requestedGroups, cluster.id);
      if (groups.length < 2) {
        await client.query('UPDATE semantic_clusters SET is_leaf = TRUE WHERE id = $1 AND tenant_id = $2', [cluster.id, tenantId]);
        await client.query('COMMIT');
        return;
      }

      for (const group of groups) {
        const childId = randomUUID();
        const isLeaf = group.items.length <= LEAF_MEMORY_LIMIT || cluster.level + 1 >= MAX_LEVEL;
        await client.query(
          `INSERT INTO semantic_clusters (
             id, tenant_id, parent_id, level, label, centroid, memory_count, category_counts, is_leaf
           ) VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8::jsonb, $9)`,
          [
            childId,
            tenantId,
            cluster.id,
            cluster.level + 1,
            group.label,
            `[${group.centroid.join(',')}]`,
            group.items.length,
            JSON.stringify(group.categoryCounts),
            isLeaf,
          ],
        );
        await client.query(
          `INSERT INTO semantic_cluster_members (cluster_id, memory_id)
           SELECT $1, id FROM unnest($2::uuid[]) AS id`,
          [childId, group.items.map(item => item.id)],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  private async getCluster(tenantId: string, clusterId: string): Promise<StoredCluster | null> {
    const result = await this.database.query(
      `SELECT *, centroid::text AS centroid
       FROM semantic_clusters
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, clusterId],
      tenantId,
    );
    return result.rows[0] ?? null;
  }

  private async getChildren(tenantId: string, clusterId: string): Promise<StoredCluster[]> {
    const result = await this.database.query(
      `SELECT *, centroid::text AS centroid
       FROM semantic_clusters
       WHERE tenant_id = $1 AND parent_id = $2
       ORDER BY memory_count DESC, id`,
      [tenantId, clusterId],
      tenantId,
    );
    return result.rows;
  }

  private async getFilteredChildren(tenantId: string, clusterId: string, query: string): Promise<StoredCluster[]> {
    const result = await this.database.query(
      `WITH matched AS (
         SELECT child.id AS cluster_id, m.category
         FROM semantic_clusters child
         JOIN semantic_cluster_members scm ON scm.cluster_id = child.id
         JOIN memories m ON m.id = scm.memory_id
         WHERE child.tenant_id = $1 AND child.parent_id = $2 AND m.tenant_id = $1
           AND POSITION(LOWER($3) IN LOWER(CONCAT_WS(' ', m.content, m.category, m.metadata::text))) > 0
       ), counts AS (
         SELECT cluster_id, COUNT(*)::int AS memory_count
         FROM matched
         GROUP BY cluster_id
       ), categories AS (
         SELECT cluster_id, jsonb_object_agg(category, category_count) AS category_counts
         FROM (
           SELECT cluster_id, category, COUNT(*)::int AS category_count
           FROM matched
           GROUP BY cluster_id, category
         ) grouped
         GROUP BY cluster_id
       )
       SELECT child.id, child.tenant_id, child.parent_id, child.level, child.label,
              child.centroid::text AS centroid, counts.memory_count,
              child.memory_count AS total_memory_count, categories.category_counts,
              child.is_leaf, child.generated_at, child.source_embedding_count,
              child.source_embedding_at, child.algorithm_version
       FROM semantic_clusters child
       JOIN counts ON counts.cluster_id = child.id
       JOIN categories ON categories.cluster_id = child.id
       WHERE child.tenant_id = $1 AND child.parent_id = $2
       ORDER BY counts.memory_count DESC, child.id`,
      [tenantId, clusterId, query],
      tenantId,
    );
    return result.rows;
  }

  private withFilteredCounts(
    cluster: StoredCluster,
    matches: Array<Pick<StoredCluster, 'memory_count' | 'category_counts'>>,
  ): StoredCluster {
    const categoryCounts: Record<string, number> = {};
    let memoryCount = 0;
    for (const match of matches) {
      memoryCount += Number(match.memory_count);
      const counts = typeof match.category_counts === 'string'
        ? JSON.parse(match.category_counts) as Record<string, number>
        : match.category_counts;
      for (const [category, count] of Object.entries(counts)) {
        categoryCounts[category] = (categoryCounts[category] ?? 0) + Number(count);
      }
    }
    return {
      ...cluster,
      memory_count: memoryCount,
      total_memory_count: Number(cluster.memory_count),
      category_counts: categoryCounts,
    };
  }

  private async getBreadcrumbs(tenantId: string, clusterId: string): Promise<StoredCluster[]> {
    const result = await this.database.query(
      `WITH RECURSIVE ancestors AS (
         SELECT * FROM semantic_clusters WHERE tenant_id = $1 AND id = $2
         UNION ALL
         SELECT parent.*
         FROM semantic_clusters parent
         JOIN ancestors child ON child.parent_id = parent.id
         WHERE parent.tenant_id = $1
       )
       SELECT *, centroid::text AS centroid FROM ancestors ORDER BY level`,
      [tenantId, clusterId],
      tenantId,
    );
    return result.rows;
  }

  private async getClusterMemories(tenantId: string, clusterId: string, filterQuery?: string): Promise<Memory[]> {
    const result = await this.database.query(
      `SELECT m.*
       FROM semantic_cluster_members scm
       JOIN semantic_clusters sc ON sc.id = scm.cluster_id
       JOIN memories m ON m.id = scm.memory_id
       WHERE scm.cluster_id = $1 AND sc.tenant_id = $2 AND m.tenant_id = $2
         AND ($3::text IS NULL OR POSITION(LOWER($3) IN LOWER(CONCAT_WS(' ', m.content, m.category, m.metadata::text))) > 0)
       ORDER BY COALESCE(
         CASE WHEN pg_input_is_valid(m.metadata->>'source_created_at', 'timestamptz')
              THEN (m.metadata->>'source_created_at')::timestamptz END,
         m.created_at
       ) DESC
       LIMIT 300`,
      [clusterId, tenantId, filterQuery ?? null],
      tenantId,
    );
    return result.rows.map((row: Memory) => ({
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    }));
  }

  private toSummary(cluster: StoredCluster): SemanticClusterSummary {
    const counts = typeof cluster.category_counts === 'string'
      ? JSON.parse(cluster.category_counts)
      : (cluster.category_counts ?? {});
    const dominant = Object.entries(counts as Record<string, number>)
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] ?? null;
    return {
      id: cluster.id,
      parent_id: cluster.parent_id,
      level: Number(cluster.level),
      label: cluster.label,
      memory_count: Number(cluster.memory_count),
      total_memory_count: Number(cluster.total_memory_count ?? cluster.memory_count),
      is_leaf: Boolean(cluster.is_leaf),
      category_counts: counts,
      dominant_category: dominant,
    };
  }
}
