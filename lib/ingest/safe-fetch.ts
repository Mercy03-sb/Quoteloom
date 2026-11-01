// SSRF-safe outbound fetch. Every URL we fetch for ingest goes through here.
//  - http and https only, no credentials in the URL, standard-ish ports only
//  - the hostname is resolved and EVERY address must be public (checked before the request and again at connect time)
//  - redirects are followed by hand, each hop re-validated
//  - response size cap, overall timeout, text-like content types only
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class UnsafeUrlError extends Error {
  code = "unsafe_url";
}
export class FetchError extends Error {
  constructor(
    public code: "timeout" | "too_large" | "bad_status" | "bad_content_type" | "too_many_redirects" | "network",
    message: string,
  ) {
    super(message);
  }
}

// ---------- IP classification ----------

function v4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 3], // multicast and reserved (224/4 and 240/4), including broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true; // unparseable: refuse
  return V4_BLOCKS.some(([base, bits]) => {
    const b = v4ToInt(base) as number;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

/** Expand an IPv6 literal to eight 16-bit groups, or null if malformed. */
function expandV6(ip: string): number[] | null {
  let s = ip.split("%")[0].toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    if (n === null) return null;
    s = s.slice(0, -dotted[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function isBlockedV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedV4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedV4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedV4(embeddedV4(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  return false;
}

/** True when the address is private, loopback, link-local, multicast, reserved, or not an IP at all. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const kind = net.isIP(bare);
  if (kind === 4) return isBlockedV4(bare);
  if (kind === 6) return isBlockedV6(bare);
  return true;
}

// ---------- URL and DNS checks ----------

export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (hostname) => (await dns.promises.lookup(hostname, { all: true })).map((a) => a.address);

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/** Syntax-level checks that need no network. Returns the parsed URL. */
export function parseSafeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UnsafeUrlError("That does not look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only http and https URLs are allowed.");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not allowed.");
  if (!ALLOWED_PORTS.has(url.port)) throw new UnsafeUrlError("That port is not allowed.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new UnsafeUrlError("The URL has no host.");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("Local and internal hosts are not allowed.");
  }
  if (net.isIP(host.replace(/^\[|\]$/g, "")) && isBlockedIp(host)) {
    throw new UnsafeUrlError("Private, loopback and link-local addresses are not allowed.");
  }
  return url;
}

/** Full check: syntax, then resolve the hostname and require every address to be public. */
export async function assertPublicUrl(input: string | URL, resolve: Resolver = defaultResolver): Promise<URL> {
  const url = parseSafeUrl(typeof input === "string" ? input : input.href);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return url; // literal already vetted by parseSafeUrl
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new FetchError("network", `Could not resolve ${host}.`);
  }
  if (addrs.length === 0) throw new FetchError("network", `Could not resolve ${host}.`);
  if (addrs.some(isBlockedIp)) throw new UnsafeUrlError("That host resolves to a private or internal address.");
  return url;
}

/** dns.lookup replacement used at connect time, so the address we validate is the address we connect to. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedIp(a.address))) return cb(new UnsafeUrlError("Blocked address."));
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

// ---------- Transport ----------

export type RawResponse = { status: number; headers: Record<string, string | undefined>; body: AsyncIterable<Uint8Array> };
export type Transport = (url: URL, opts: { signal: AbortSignal; accept: string }) => Promise<RawResponse>;

/** Real transport: node http(s) with a guarded lookup. No keep-alive, no compression. */
export const nodeTransport: Transport = (url, { signal, accept }) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup as never,
        agent: false,
        signal,
        headers: { accept, "accept-encoding": "identity", "user-agent": "QuoteloomIngest/0.1 (+hackathon demo; respects ownership notice)" },
      },
      (res) => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
        resolve({ status: res.statusCode ?? 0, headers, body: res });
      },
    );
    req.on("error", (e) => reject(e));
    req.end();
  });

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  resolve?: Resolver;
  transport?: Transport;
};

export const DEFAULT_MAX_BYTES = 1_500_000;
export const DEFAULT_TIMEOUT_MS = 8000;
const TEXT_TYPE = /^(text\/|application\/(json|ld\+json|xhtml\+xml|xml|csv))/i;

export type FetchedText = { url: string; status: number; contentType: string; text: string };

/** Fetch a text document safely. Throws UnsafeUrlError or FetchError. */
export async function safeFetchText(input: string, opts: SafeFetchOptions = {}): Promise<FetchedText> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? 4;
  const transport = opts.transport ?? nodeTransport;
  const resolve = opts.resolve ?? defaultResolver;
  const accept = opts.accept ?? "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs); // one budget for the whole chain, redirects included
  const timedOut = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener("abort", () => reject(new FetchError("timeout", `Timed out after ${timeoutMs / 1000}s.`)));
  });
  timedOut.catch(() => {}); // avoid an unhandled rejection when nothing is racing
  try {
    let url = await assertPublicUrl(input, resolve);
    for (let hop = 0; ; hop++) {
      let res: RawResponse;
      try {
        res = await Promise.race([transport(url, { signal: ctrl.signal, accept }), timedOut]);
      } catch (e) {
        if (e instanceof UnsafeUrlError || e instanceof FetchError) throw e;
        if (ctrl.signal.aborted) throw new FetchError("timeout", `Timed out after ${timeoutMs / 1000}s.`);
        const inner = (e as { cause?: unknown; code?: string }).cause ?? e;
        if (inner instanceof UnsafeUrlError) throw inner;
        throw new FetchError("network", `Could not reach ${url.hostname}.`);
      }

      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        drain(res.body);
        if (hop >= maxRedirects) throw new FetchError("too_many_redirects", "Too many redirects.");
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          throw new FetchError("bad_status", "Bad redirect.");
        }
        url = await assertPublicUrl(next, resolve); // validate every hop, by syntax and by DNS
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        drain(res.body);
        throw new FetchError("bad_status", `The site answered with HTTP ${res.status}.`);
      }
      const contentType = res.headers["content-type"] ?? "";
      if (contentType && !TEXT_TYPE.test(contentType)) {
        drain(res.body);
        throw new FetchError("bad_content_type", "That URL is not a web page, JSON or CSV file.");
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        drain(res.body);
        throw new FetchError("too_large", `The page is larger than ${Math.round(maxBytes / 1000)} KB.`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        const it = res.body[Symbol.asyncIterator]();
        for (;;) {
          const next = await Promise.race([it.next(), timedOut]);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBytes) {
            drain(res.body);
            throw new FetchError("too_large", `The page is larger than ${Math.round(maxBytes / 1000)} KB.`);
          }
          chunks.push(next.value);
        }
      } catch (e) {
        if (e instanceof FetchError) throw e;
        if (ctrl.signal.aborted) throw new FetchError("timeout", `Timed out after ${timeoutMs / 1000}s.`);
        throw new FetchError("network", "The connection dropped while reading the page.");
      }
      return { url: url.href, status: res.status, contentType, text: Buffer.concat(chunks).toString("utf8") };
    }
  } finally {
    clearTimeout(timer);
  }
}

function drain(body: AsyncIterable<Uint8Array>): void {
  const b = body as unknown as { destroy?: () => void };
  try {
    b.destroy?.();
  } catch {
    /* ignore */
  }
}
