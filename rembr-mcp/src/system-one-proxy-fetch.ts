import { fetch as undiciFetch, ProxyAgent } from 'undici';

export function validateSystemOneProxyUrl(proxyUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error('SYSTEM_ONE_HTTPS_PROXY must be a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('SYSTEM_ONE_HTTPS_PROXY must use http or https');
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('SYSTEM_ONE_HTTPS_PROXY must be an uncredentialled proxy URL');
  }
  if (parsed.pathname !== '/') {
    throw new Error('SYSTEM_ONE_HTTPS_PROXY must not contain a path');
  }
  return parsed.toString();
}

export function createSystemOneProxyFetch(proxyUrl: string): typeof globalThis.fetch {
  const validatedProxyUrl = validateSystemOneProxyUrl(proxyUrl);
  const dispatcher = new ProxyAgent({ uri: validatedProxyUrl });
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    // Supplying the dispatcher explicitly is the security boundary. Node's
    // global fetch does not reliably honour HTTPS_PROXY by itself.
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Response;
  }) as typeof globalThis.fetch;
}
