import { describe, expect, it } from 'vitest';

import { UnsafePostingUrlError, isGlobalIp, resolveSafeTarget } from './safe-fetch';

/** A lookup that always resolves to one global address. */
const globalLookup = async () => ['93.184.216.34'];

describe('isGlobalIp', () => {
  it('rejects loopback, private, link-local, and IPv6 local ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
    ]) {
      expect(isGlobalIp(ip)).toBe(false);
    }
  });

  it('rejects IPv4-mapped / embedded IPv6 forms that hide a private or loopback v4', () => {
    for (const ip of [
      '::ffff:7f00:1', // hex-form ::ffff:127.0.0.1 (loopback)
      '::ffff:a9fe:a9fe', // hex-form ::ffff:169.254.169.254 (metadata)
      '::ffff:0a00:0001', // hex-form ::ffff:10.0.0.1 (private)
      '0:0:0:0:0:ffff:10.0.0.1', // expanded IPv4-mapped
      '::ffff:192.168.1.1', // dotted IPv4-mapped
      '64:ff9b::a00:1', // NAT64 embedding 10.0.0.1
      '64:ff9b:1::7f00:1', // RFC 8215 local-use NAT64 (v4 position varies; whole /48 is non-global)
      '64:ff9b:1:ffff::203.0.113.9', // local-use NAT64, dotted form, high end of the /48
      '2002:7f00:1::', // 6to4 embedding 127.0.0.1
      '2002:a9fe:a9fe::', // 6to4 embedding 169.254.169.254
    ]) {
      expect(isGlobalIp(ip)).toBe(false);
    }
  });

  it('still accepts a 6to4 address that embeds a global v4', () => {
    expect(isGlobalIp('2002:5db8:d822::')).toBe(true); // 6to4 of 93.184.216.34
  });

  it('accepts publicly-routable addresses', () => {
    expect(isGlobalIp('93.184.216.34')).toBe(true);
    expect(isGlobalIp('8.8.8.8')).toBe(true);
    expect(isGlobalIp('2606:2800:220:1::1')).toBe(true);
  });
});

describe('resolveSafeTarget', () => {
  it('pins a hostname to its first validated global address', async () => {
    const target = await resolveSafeTarget('https://jobs.example.com/role', async () => [
      '93.184.216.34',
      '8.8.8.8',
    ]);
    expect(target.pinnedAddress).toBe('93.184.216.34');
  });

  it('does not pin an IP literal (nothing to re-resolve)', async () => {
    const target = await resolveSafeTarget('http://93.184.216.34/role', globalLookup);
    expect(target.pinnedAddress).toBeNull();
  });

  it('rejects a hostname resolving to a private address before any fetch', async () => {
    await expect(
      resolveSafeTarget('https://internal.example.com/role', async () => ['10.0.0.1']),
    ).rejects.toBeInstanceOf(UnsafePostingUrlError);
  });
});
