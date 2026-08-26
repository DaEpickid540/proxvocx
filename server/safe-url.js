import dns from 'node:dns/promises';
import net from 'node:net';

export class UrlRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrlRejectedError';
    this.code = 'ERR_URL_REJECTED';
  }
}

const BLOCKED_PORTS = new Set([
  19, 22, 23, 25, 110, 135, 137, 138, 139, 143, 445, 465, 587, 993, 995, 1900, 3389,
]);

/** Parse and structurally validate a proxy target. Does no DNS work. */
export function parseTargetUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new UrlRejectedError('url is missing or not a string');
  }
  const candidate = raw.trim();
  if (candidate.length > 2048) {
    throw new UrlRejectedError('url is longer than 2048 characters');
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    throw new UrlRejectedError(`url is not parseable: ${candidate}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlRejectedError(`unsupported protocol ${url.protocol} (only http and https)`);
  }
  if (!url.hostname) {
    throw new UrlRejectedError('url has no hostname');
  }
  if (url.username || url.password) {
    throw new UrlRejectedError('urls with embedded credentials are not proxied');
  }
  if (url.port && BLOCKED_PORTS.has(Number(url.port))) {
    throw new UrlRejectedError(`port ${url.port} is not allowed`);
  }
  return url;
}

/** True for loopback, link-local, private, CGNAT, multicast and reserved space. */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true; // not an IP literal we understand — treat as unsafe
}

function isPrivateIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(address) {
  const addr = address.toLowerCase().split('%')[0];
  if (addr === '::' || addr === '::1') return true;
  if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  if (/^f[cd]/.test(addr)) return true; // unique local fc00::/7
  if (addr.startsWith('ff')) return true; // multicast
  if (addr.startsWith('::ffff:')) {
    const mapped = addr.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return isPrivateIPv4(mapped);
    return true;
  }
  if (addr.startsWith('2001:db8')) return true; // documentation
  if (addr.startsWith('64:ff9b')) return true; // NAT64
  return false;
}

/**
 * Resolve the hostname and reject it if any answer points into private space.
 * Returns the resolved addresses so the caller can log them.
 */
export async function assertPublicHost(url, { allowPrivateNetwork = false } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (allowPrivateNetwork) return [host];

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new UrlRejectedError(`refusing to fetch private address ${host}`);
    }
    return [host];
  }

  if (/(^|\.)(localhost|local|internal|home|lan)$/i.test(host)) {
    throw new UrlRejectedError(`refusing to fetch internal hostname ${host}`);
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new UrlRejectedError(`dns lookup failed for ${host}: ${err.code || err.message}`);
  }
  if (!records.length) {
    throw new UrlRejectedError(`dns lookup returned no addresses for ${host}`);
  }
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new UrlRejectedError(`${host} resolves to private address ${record.address}`);
    }
  }
  return records.map((r) => r.address);
}
