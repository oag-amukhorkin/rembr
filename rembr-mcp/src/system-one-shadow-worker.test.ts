import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  consumePilotRuntimeFiles,
  loadPilotRuntimeInputs,
} from './system-one-shadow-worker.js';

describe('System One worker runtime files', () => {
  it('loads and consumes every tmpfs input before enabling the process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rembr-system-one-files-'));
    const inputs = {
      TYPESAFE_API_KEY: ['test', 'api', 'key'].join('-'),
      DB_PASSWORD: ['test', 'shadow', 'password'].join('-'),
      SYSTEM_ONE_SHADOW_TENANT_ID: '00000000-0000-4000-8000-000000000001',
      SYSTEM_ONE_SHADOW_PROJECT_ID: '00000000-0000-4000-8000-000000000002',
      SYSTEM_ONE_SHADOW_RUN_ID: '00000000-0000-4000-8000-000000000003',
    } as const;
    const env: NodeJS.ProcessEnv = {};
    const restartEnv: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(inputs)) {
      const path = join(directory, name.toLowerCase());
      await writeFile(path, value, { mode: 0o600 });
      const fileName = name === 'DB_PASSWORD' ? 'DB_SHADOW_PASSWORD_FILE' : `${name}_FILE`;
      env[fileName] = path;
      restartEnv[fileName] = path;
    }

    await loadPilotRuntimeInputs(env);

    for (const [name, value] of Object.entries(inputs)) {
      expect(env[name]).toBe(value);
      const fileName = name === 'DB_PASSWORD' ? 'DB_SHADOW_PASSWORD_FILE' : `${name}_FILE`;
      await expect(readFile(env[fileName]!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await consumePilotRuntimeFiles(restartEnv)).toBe(false);
    expect(Object.keys(restartEnv).some(name => !name.endsWith('_FILE'))).toBe(false);
  });

  it('leaves the runtime inert when a mounted file is multiline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rembr-system-one-invalid-files-'));
    const env: NodeJS.ProcessEnv = {};
    const values = ['first\nsecond', 'password', 'tenant', 'project', 'run'];
    const files = [
      'TYPESAFE_API_KEY_FILE',
      'DB_SHADOW_PASSWORD_FILE',
      'SYSTEM_ONE_SHADOW_TENANT_ID_FILE',
      'SYSTEM_ONE_SHADOW_PROJECT_ID_FILE',
      'SYSTEM_ONE_SHADOW_RUN_ID_FILE',
    ];
    for (let index = 0; index < files.length; index++) {
      const path = join(directory, String(index));
      await writeFile(path, values[index], { mode: 0o600 });
      env[files[index]] = path;
    }

    expect(await consumePilotRuntimeFiles(env)).toBe(false);
    expect(Object.keys(env).some(name => !name.endsWith('_FILE'))).toBe(false);
    await expect(readFile(env.TYPESAFE_API_KEY_FILE!, 'utf8')).resolves.toBe('first\nsecond');
  });
});
