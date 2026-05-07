// SSRF defense for server-side `fetch(userControlledUrl)` paths.
//
// The threat: an authenticated user (or anyone exploiting CSRF) submits
// a URL like http://169.254.169.254/latest/meta-data/iam/security-credentials/
// or http://127.0.0.1:9200/ — the server fetches it from inside the
// network perimeter and either reflects the body or leaks timing/error
// signals about which internal hosts exist.
//
// Mitigation:
//   1. Whitelist scheme to http/https.
//   2. Reject non-default ports (no http://internal:8080 admin panels).
//   3. Resolve the hostname via dns.lookup({ all: true }) and require ALL
//      resolved addresses to be `unicast` per ipaddr.js (rejects private,
//      loopback, link-local, multicast, reserved, ULA, broadcast, etc.).
//   4. Caller chases redirects manually, re-validating each hop's URL.
//
// Residual risk: DNS rebinding — an attacker-controlled domain can
// return public IPs at our validation lookup and then localhost at the
// subsequent fetch. Mitigating that fully requires fetching by IP with
// a manual Host header (and accepting TLS-name-validation pain). This
// implementation is sufficient for a single-author CMS where the only
// authenticated user is the owner; revisit before opening to untrusted
// posters.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Default scheme ports. Anything else (8080, 3000, …) is rejected. */
const DEFAULT_PORT_FOR: Record<string, string> = {
  'http:': '80',
  'https:': '443'
};

/**
 * Throws UnsafeUrlError if `urlString` should not be fetched server-side.
 * Resolves DNS as a side effect; do not call inside a tight loop.
 */
export async function assertSafeFetchUrl(urlString: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new UnsafeUrlError('not a valid URL');
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new UnsafeUrlError(`scheme not allowed: ${url.protocol}`);
  }

  // Empty url.port means default-for-scheme; otherwise compare numerically.
  const port = url.port || DEFAULT_PORT_FOR[url.protocol] || '';
  if (port !== DEFAULT_PORT_FOR[url.protocol]) {
    throw new UnsafeUrlError(`non-default port not allowed: ${url.port}`);
  }

  // URL.hostname keeps brackets around IPv6 literals (`[::1]`); strip
  // them so isIP/ipaddr.parse can recognise the address.
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (!hostname) {
    throw new UnsafeUrlError('empty hostname');
  }

  // If the host is an IP literal, validate it directly. Otherwise resolve.
  const literal = isIP(hostname);
  const addresses = literal
    ? [{ address: hostname, family: literal }]
    : await lookup(hostname, { all: true });

  if (addresses.length === 0) {
    throw new UnsafeUrlError('hostname did not resolve');
  }

  for (const { address } of addresses) {
    assertSafeIp(address);
  }

  return url;
}

function assertSafeIp(address: string): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new UnsafeUrlError(`unparseable IP: ${address}`);
  }

  // IPv4-mapped IPv6 (::ffff:1.2.3.4): unwrap and re-check the IPv4.
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }

  const range = parsed.range();
  // ipaddr.js range categories: 'unicast' is the only public-routable
  // class. Everything else (private, loopback, linkLocal, multicast,
  // reserved, uniqueLocal, broadcast, etc.) we reject.
  if (range !== 'unicast') {
    throw new UnsafeUrlError(`address ${address} is in restricted range: ${range}`);
  }
}

export interface SafeFetchOptions {
  /** Per-request timeout (ms) applied to each hop. Default 15s. */
  timeoutMs?: number;
  /** Maximum redirect hops. Default 5. */
  maxRedirects?: number;
  /** Optional fetch override for tests. */
  fetcher?: typeof fetch;
}

/**
 * Like `fetch(url)`, but every hop is validated through assertSafeFetchUrl
 * and redirects are chased manually so an attacker can't redirect through
 * a private-IP host. Aborts if the body is consumed elsewhere — the caller
 * is expected to read `res.body` themselves.
 */
export async function safeFetch(
  urlString: string,
  options: SafeFetchOptions = {}
): Promise<Response> {
  const { timeoutMs = 15_000, maxRedirects = 5, fetcher = fetch } = options;
  let current = urlString;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertSafeFetchUrl(current);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetcher(url, { signal: ac.signal, redirect: 'manual' });
    } finally {
      clearTimeout(timer);
    }

    // Manual redirect handling: 301/302/303/307/308 → follow, re-validate.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new UnsafeUrlError(`redirect ${res.status} without Location header`);
      }
      // Resolve relative redirects against the current URL.
      current = new URL(location, url).toString();
      continue;
    }
    return res;
  }
  throw new UnsafeUrlError(`too many redirects (>${maxRedirects})`);
}
