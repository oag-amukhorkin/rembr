import { promises as dns } from 'node:dns';
import { createServer } from 'node:http';
import { connect } from 'node:net';

export const SYSTEM_ONE_PROXY_UPSTREAM = 'api.typesafe.ai:443';

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0) >>> 0;
}

function inIpv4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

export function isPublicSystemOneUpstreamAddress(address: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) ||
      address.split('.').some(octet => Number(octet) > 255)) return false;
  return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
      ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => inIpv4Range(address, String(base), Number(bits)));
}

function proxyPort(value: string | undefined): number {
  const parsed = Number(value ?? '3128');
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error('SYSTEM_ONE_PROXY_PORT must be an integer between 1024 and 65535');
  }
  return parsed;
}

export function startSystemOneFixedEgressProxy(env: NodeJS.ProcessEnv = process.env) {
  if ((env.SYSTEM_ONE_PROXY_UPSTREAM ?? SYSTEM_ONE_PROXY_UPSTREAM) !== SYSTEM_ONE_PROXY_UPSTREAM) {
    throw new Error(`SYSTEM_ONE_PROXY_UPSTREAM must be exactly ${SYSTEM_ONE_PROXY_UPSTREAM}`);
  }
  const server = createServer((_request, response) => {
    response.writeHead(405, { Connection: 'close' });
    response.end();
  });

  server.on('connect', async (request, clientSocket, head) => {
    if (request.url !== SYSTEM_ONE_PROXY_UPSTREAM) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    try {
      const addresses = await dns.lookup('api.typesafe.ai', { all: true, verbatim: true, family: 4 });
      const destination = addresses.find(candidate => isPublicSystemOneUpstreamAddress(candidate.address));
      if (!destination) throw new Error('no public upstream address');
      const upstream = connect({ host: destination.address, port: 443, family: destination.family });
      const closeBoth = () => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.setTimeout(30_000, closeBoth);
      upstream.once('error', closeBoth);
      clientSocket.once('error', closeBoth);
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
    } catch {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  return server.listen(proxyPort(env.SYSTEM_ONE_PROXY_PORT), '0.0.0.0');
}

if (process.env.NODE_ENV !== 'test') {
  startSystemOneFixedEgressProxy();
}
