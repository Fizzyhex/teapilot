import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { checkUrl, hostOf, vetHost, WebRefusal, type AddressPolicy } from './policy.js';

export interface FetchLimits { deadlineMs: number; maxBytes: number; maxRedirects: number }
export const defaultLimits: FetchLimits = { deadlineMs: 20_000, maxBytes: 2_000_000, maxRedirects: 5 };
export interface FetchOptions extends AddressPolicy {
  signal?: AbortSignal; limits?: Partial<FetchLimits>; accept?: string;
  /** Media types whose bodies are read; anything else is refused from its headers alone. */
  types: readonly string[];
}
export interface FetchedPage { url: string; status: number; contentType: string; charset?: string; body: Buffer }

const userAgent = 'Mozilla/5.0 (compatible; teapilot; +https://github.com/Fizzyhex/teapilot)';
const redirects = new Set([301, 302, 303, 307, 308]);

/**
 * GET a URL on the public internet. Each hop is checked against the URL policy and resolved once; the
 * socket then connects to exactly that address, so a DNS answer cannot change between check and use.
 * Redirects are followed here, never by the transport, so every one is checked the same way.
 */
export async function guardedGet(raw: string, options: FetchOptions): Promise<FetchedPage> {
  const limits = { ...defaultLimits, ...options.limits };
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(limits.deadlineMs)]);
  let url = checkUrl(raw, options.allowPort);
  for (let hop = 0; ; hop++) {
    const response = await open(url, options, signal);
    const location = response.headers.location;
    if (redirects.has(response.statusCode ?? 0) && location) {
      response.destroy();
      if (hop >= limits.maxRedirects) throw new WebRefusal(`Stopped after ${limits.maxRedirects} redirects.`);
      let next: URL;
      try { next = new URL(location, url); } catch { throw new WebRefusal('The page redirected to an invalid URL.'); }
      url = checkUrl(next.href, options.allowPort);
      continue;
    }
    const [type = '', ...parameters] = String(response.headers['content-type'] ?? '').split(';').map(part => part.trim());
    const contentType = type.toLowerCase();
    const charset = parameters.find(part => /^charset=/i.test(part))?.slice(8).replace(/^"|"$/g, '');
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) { response.destroy(); return { url: url.href, status, contentType, charset, body: Buffer.alloc(0) }; }
    if (!options.types.includes(contentType)) { response.destroy(); throw new WebRefusal(`Unsupported content type (${contentType || 'none'}); only web pages and text are read.`); }
    return { url: url.href, status, contentType, charset, body: await collect(response, limits.maxBytes, signal) };
  }
}

async function open(url: URL, options: FetchOptions, signal: AbortSignal): Promise<IncomingMessage> {
  signal.throwIfAborted();
  const vetted = await vetHost(hostOf(url), options);
  // Hand the transport the checked address instead of letting it resolve the name again.
  const lookup: LookupFunction = (_host, lookupOptions, callback) => {
    if ((lookupOptions as { all?: boolean }).all) (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: vetted.address, family: vetted.family }]);
    else callback(null, vetted.address, vetted.family);
  };
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const req = send(url, { method: 'GET', agent: false, lookup, signal, headers: {
      'user-agent': userAgent, accept: options.accept ?? 'text/markdown, text/html;q=0.9, text/plain;q=0.8', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en',
    } }, resolve);
    req.on('error', error => reject(signal.aborted ? abortError(signal) : new Error(`Could not fetch ${url.host}: ${error.message}`)));
    req.end();
  });
}

const abortError = (signal: AbortSignal) => signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? new WebRefusal('The page took too long to load.') : signal.reason;

async function collect(response: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
  const stream: Readable = decoder ? response.pipe(decoder) : response;
  const chunks: Buffer[] = []; let size = 0;
  try {
    // The limit applies after decompression, so a small compressed body cannot expand past it.
    for await (const chunk of stream) {
      signal.throwIfAborted();
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new WebRefusal(`The page is larger than ${Math.round(maxBytes / 1_000_000)} MB, so it was not read.`);
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof WebRefusal) throw error;
    if (signal.aborted) throw abortError(signal);
    throw new Error(`The page could not be read: ${error instanceof Error ? error.message : String(error)}`);
  } finally { response.destroy(); decoder?.destroy(); }
  return Buffer.concat(chunks);
}
