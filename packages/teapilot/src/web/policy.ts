import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Why a URL or address was not contacted; shown to the model as the reason a read was refused. */
export class WebRefusal extends Error {}

// Everything that is not global unicast: private, loopback, link-local (cloud metadata), CGNAT (tailnets),
// documentation, benchmarking, multicast and reserved ranges.
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 96],['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) blocked.addSubnet(network, prefix, 'ipv6');

/** The IPv4 address carried inside an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) address. */
function embeddedIPv4(address: string): string | undefined {
  const match = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (!match) return undefined;
  if (match[1]) return match[1];
  const high = parseInt(match[2]!, 16), low = parseInt(match[3]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const inner = embeddedIPv4(address);
  if (inner) return isPublicAddress(inner);
  // Other forms that end in a dotted quad (IPv4-compatible ::a.b.c.d) are deprecated, and ::/96 is blocked anyway.
  if (address.includes('.')) return false;
  return !blocked.check(address, 'ipv6');
}

const localSuffixes = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];
/**
 * A URL the controller may fetch: http(s) on the standard ports, no credentials, fragment dropped.
 * Hostnames that only make sense on a private network are refused before any lookup.
 */
export function checkUrl(raw: string, allowPort?: (port: string) => boolean): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new WebRefusal('Not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new WebRefusal('Only http and https URLs can be read.');
  if (url.username || url.password) throw new WebRefusal('URLs with embedded credentials are not read.');
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80') && !allowPort?.(url.port)) throw new WebRefusal('Only the standard web ports (80 and 443) can be read.');
  url.hash = '';
  if (url.href.length > 2000) throw new WebRefusal('URL is too long.');
  const host = hostOf(url);
  if (!isIP(host)) {
    const name = host.replace(/\.$/, '').toLowerCase();
    if (name === 'localhost' || !name.includes('.') || localSuffixes.some(suffix => name.endsWith(suffix))) throw new WebRefusal('Local and private network addresses are never read.');
  } else if (!isPublicAddress(host)) throw new WebRefusal('Local and private network addresses are never read.');
  return url;
}

/** The hostname without IPv6 brackets. */
export const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
export const systemLookup: Lookup = host => dnsLookup(host, { all: true, verbatim: true });
/** Overrides for tests only; nothing in configuration sets them. */
export interface AddressPolicy { lookup?: Lookup; allowAddress?: (address: string) => boolean; allowPort?: (port: string) => boolean }

/**
 * Resolves a host and returns one address to connect to. Every resolved address must be public, so a
 * name that answers with a mix of public and private addresses is refused rather than raced.
 */
export async function vetHost(host: string, policy: AddressPolicy = {}): Promise<{ address: string; family: 4 | 6 }> {
  const allow = policy.allowAddress ?? isPublicAddress;
  const literal = isIP(host);
  if (literal) {
    if (!allow(host)) throw new WebRefusal('Local and private network addresses are never read.');
    return { address: host, family: literal as 4 | 6 };
  }
  let answers: Array<{ address: string; family: number }>;
  try { answers = await (policy.lookup ?? systemLookup)(host); } catch { throw new WebRefusal(`Could not resolve ${host}.`); }
  if (!answers.length) throw new WebRefusal(`Could not resolve ${host}.`);
  if (answers.some(answer => !allow(answer.address))) throw new WebRefusal(`${host} resolves to a local or private network address, so it is not read.`);
  return { address: answers[0]!.address, family: answers[0]!.family === 6 ? 6 : 4 };
}
