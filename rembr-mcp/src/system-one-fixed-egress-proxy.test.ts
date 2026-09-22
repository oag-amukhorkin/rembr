import { describe, expect, it } from 'vitest';
import { isPublicSystemOneUpstreamAddress } from './system-one-fixed-egress-proxy.js';

describe('fixed System One egress proxy', () => {
  it('accepts public IPv4 only and rejects private, reserved and IPv6 destinations', () => {
    expect(isPublicSystemOneUpstreamAddress('1.1.1.1')).toBe(true);
    for (const address of [
      '127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.1',
      '203.0.113.1', '::1', '2606:4700:4700::1111', 'not-an-ip',
    ]) expect(isPublicSystemOneUpstreamAddress(address)).toBe(false);
  });
});
