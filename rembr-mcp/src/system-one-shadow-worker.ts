import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryDatabase } from './database.js';
import {
  PostgresRelationshipShadowWorkerRepository,
  RelationshipShadowWorker,
  relationshipShadowWorkerConfigFromEnv,
} from './relationship-shadow-worker.js';
import { SystemOneRelationshipProvider } from './system-one-relationship-provider.js';
import { createSystemOneProxyFetch } from './system-one-proxy-fetch.js';

function intervalFromEnv(value: string | undefined): number {
  if (!value) return 60_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 5_000 || parsed > 3_600_000) {
    throw new Error('SYSTEM_ONE_SHADOW_INTERVAL_MS must be an integer between 5000 and 3600000');
  }
  return parsed;
}

function timeoutFromEnv(value: string | undefined): number {
  if (!value) return 30_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 60_000) {
    throw new Error('SYSTEM_ONE_SHADOW_TIMEOUT_MS must be an integer between 100 and 60000');
  }
  return parsed;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

const PILOT_FILE_INPUTS = [
  ['TYPESAFE_API_KEY', 'TYPESAFE_API_KEY_FILE'],
  ['DB_PASSWORD', 'DB_SHADOW_PASSWORD_FILE'],
  ['SYSTEM_ONE_SHADOW_TENANT_ID', 'SYSTEM_ONE_SHADOW_TENANT_ID_FILE'],
  ['SYSTEM_ONE_SHADOW_PROJECT_ID', 'SYSTEM_ONE_SHADOW_PROJECT_ID_FILE'],
  ['SYSTEM_ONE_SHADOW_RUN_ID', 'SYSTEM_ONE_SHADOW_RUN_ID_FILE'],
] as const;

export async function consumePilotRuntimeFiles(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  let complete = true;
  const loaded: Array<[string, string, string]> = [];
  for (const [valueName, fileName] of PILOT_FILE_INPUTS) {
    if (env[valueName]?.trim() && env[fileName]) {
      throw new Error(`${valueName} and ${fileName} are mutually exclusive`);
    }
    if (env[valueName]?.trim()) continue;
    const path = env[fileName];
    if (!path) {
      complete = false;
      continue;
    }
    try {
      const raw = await readFile(path, { encoding: 'utf8' });
      const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
      if (!value.trim() || value.includes('\n') || value.includes('\r')) complete = false;
      else loaded.push([valueName, value, path]);
    } catch {
      complete = false;
    }
  }
  if (!complete) return false;
  // emptyDir survives a container restart inside the same Pod. Consume all
  // files before exposing values to the runtime so any restart returns to
  // the inert waiting state. A partial unlink also fails closed because at
  // least one required file will be absent on restart.
  await Promise.all(loaded.map(([, , path]) => unlink(path)));
  for (const [name, value] of loaded) env[name] = value;
  return true;
}

export async function loadPilotRuntimeInputs(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let announced = false;
  while (!await consumePilotRuntimeFiles(env)) {
    if (!announced) {
      console.log('[SystemOneShadow] Waiting for runtime files; no provider or database request will be made');
      announced = true;
    }
    await wait(5_000);
  }
}

async function main(): Promise<void> {
  if (process.env.SYSTEM_ONE_INTEGRATION_ENABLED !== 'true') {
    console.log('[SystemOneShadow] Provider worker is disabled');
    return;
  }
  await loadPilotRuntimeInputs();
  const config = relationshipShadowWorkerConfigFromEnv();
  if (!config) {
    console.log('[SystemOneShadow] Provider worker is disabled');
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is required when the provider worker is enabled');
  const proxyUrl = process.env.SYSTEM_ONE_HTTPS_PROXY;

  const database = new MemoryDatabase();
  const repository = new PostgresRelationshipShadowWorkerRepository(database);
  const provider = new SystemOneRelationshipProvider(apiKey, {
    maxRetries: config.maxRetries,
    timeoutMs: timeoutFromEnv(process.env.SYSTEM_ONE_SHADOW_TIMEOUT_MS),
    fetchImplementation: proxyUrl ? createSystemOneProxyFetch(proxyUrl) : undefined,
  });
  const worker = new RelationshipShadowWorker(repository, provider, config);
  const intervalMs = intervalFromEnv(process.env.SYSTEM_ONE_SHADOW_INTERVAL_MS);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    while (!stopping) {
      const result = await worker.runOnce();
      console.log('[SystemOneShadow] Cycle complete', result);
      if (!stopping) await wait(intervalMs);
    }
  } finally {
    await database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('[SystemOneShadow] Worker failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
