import { beforeEach, describe, expect, it, vi } from 'vitest';

const undiciFetch = vi.fn();
const proxyAgent = vi.fn(function ProxyAgent(this: { marker?: string }) {
  this.marker = 'proxy-agent';
});

vi.mock('undici', () => ({ fetch: undiciFetch, ProxyAgent: proxyAgent }));

describe('explicit System One proxy fetch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts an uncredentialled self-hosted proxy URL', async () => {
    const { createSystemOneProxyFetch } = await import('./system-one-proxy-fetch.js');
    expect(() => createSystemOneProxyFetch('http://system-one-egress-proxy:3128/')).not.toThrow();
  });

  it('rejects credentials, paths and unsupported schemes', async () => {
    const { createSystemOneProxyFetch } = await import('./system-one-proxy-fetch.js');
    expect(() => createSystemOneProxyFetch('http://user:secret@proxy:3128/')).toThrow('uncredentialled');
    expect(() => createSystemOneProxyFetch('http://proxy:3128/tunnel')).toThrow('must not contain a path');
    expect(() => createSystemOneProxyFetch('file:///tmp/proxy')).toThrow('must use http or https');
  });

  it('passes an explicit dispatcher instead of relying on HTTPS_PROXY', async () => {
    const { createSystemOneProxyFetch } = await import('./system-one-proxy-fetch.js');
    const proxyUrl = 'http://system-one-egress-proxy:3128/';
    undiciFetch.mockResolvedValue(new Response('{}'));
    const proxyFetch = createSystemOneProxyFetch(proxyUrl);
    await proxyFetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', body: '{}' });
    expect(proxyAgent).toHaveBeenCalledWith({ uri: proxyUrl });
    expect(undiciFetch).toHaveBeenCalledWith(
      'https://api.typesafe.ai/v1/systemone',
      expect.objectContaining({ dispatcher: expect.objectContaining({ marker: 'proxy-agent' }) }),
    );
  });
});
