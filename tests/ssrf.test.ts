import { describe, expect, it, vi } from "vitest";
import {
  assertPublicUrl,
  FetchError,
  guardedLookup,
  isBlockedIp,
  parseSafeUrl,
  safeFetchText,
  UnsafeUrlError,
  type RawResponse,
  type Resolver,
  type Transport,
} from "@/lib/ingest/safe-fetch";

const PUBLIC = "93.184.216.34";
const publicDns: Resolver = async () => [PUBLIC];

async function* body(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}
const page = (text: string, headers: Record<string, string> = {}): RawResponse => ({
  status: 200,
  headers: { "content-type": "text/html", ...headers },
  body: body(text),
});
const redirect = (to: string): RawResponse => ({ status: 302, headers: { location: to }, body: body("") });

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.1.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "0.0.0.0", "100.64.0.1", "192.0.0.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5", "::ffff:7f00:1",
    "64:ff9b::7f00:1", "2002:7f00:1::1", "2001:db8::1", "not-an-ip", "",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "11.0.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "allows public %s",
    (ip) => expect(isBlockedIp(ip)).toBe(false),
  );
});

describe("parseSafeUrl", () => {
  it.each([
    "file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "javascript:alert(1)", "data:text/html,hi", "ws://example.com/", "not a url", "",
  ])("rejects non-http(s) or invalid: %s", (u) => expect(() => parseSafeUrl(u)).toThrow(UnsafeUrlError));

  it.each([
    "http://localhost/", "http://localhost:8080/", "http://foo.localhost/", "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/",
    "http://0177.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.1/", "http://192.168.0.10/", "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/", "http://printer.local/", "http://db.internal/", "http://[fe80::1]/", "http://[fd00::1]/",
  ])("rejects loopback, private and link-local host: %s", (u) => expect(() => parseSafeUrl(u)).toThrow(UnsafeUrlError));

  it("rejects credentials in the URL and unusual ports", () => {
    expect(() => parseSafeUrl("http://user:pass@example.com/")).toThrow(UnsafeUrlError);
    expect(() => parseSafeUrl("http://example.com:22/")).toThrow(UnsafeUrlError);
    expect(() => parseSafeUrl("http://example.com:6379/")).toThrow(UnsafeUrlError);
  });

  it("accepts ordinary public URLs", () => {
    expect(parseSafeUrl("https://example.com/shop").hostname).toBe("example.com");
    expect(parseSafeUrl("http://example.com:8080/").port).toBe("8080");
  });
});

describe("assertPublicUrl (DNS)", () => {
  it("blocks a public-looking name that resolves to a private address", async () => {
    await expect(assertPublicUrl("https://evil.example/", async () => ["10.0.0.7"])).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicUrl("https://evil.example/", async () => ["127.0.0.1"])).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicUrl("https://evil.example/", async () => ["::1"])).rejects.toBeInstanceOf(UnsafeUrlError);
  });
  it("blocks when ANY resolved address is private (mixed answers)", async () => {
    await expect(assertPublicUrl("https://evil.example/", async () => [PUBLIC, "169.254.169.254"])).rejects.toBeInstanceOf(UnsafeUrlError);
  });
  it("fails closed when resolution fails", async () => {
    await expect(assertPublicUrl("https://nx.example/", async () => { throw new Error("ENOTFOUND"); })).rejects.toBeInstanceOf(FetchError);
  });
  it("allows a name that resolves only to public addresses", async () => {
    await expect(assertPublicUrl("https://ok.example/", publicDns)).resolves.toBeInstanceOf(URL);
  });
});

describe("guardedLookup (connect time)", () => {
  it("refuses a hostname that resolves to loopback", async () => {
    const err = await new Promise<unknown>((resolve) => {
      guardedLookup("localhost", {}, (e: unknown) => resolve(e));
    });
    expect(err).toBeInstanceOf(UnsafeUrlError);
  });
});

describe("safeFetchText", () => {
  it("fetches a public page", async () => {
    const transport: Transport = async () => page("<h1>hi</h1>");
    const r = await safeFetchText("https://shop.example/", { resolve: publicDns, transport });
    expect(r.text).toBe("<h1>hi</h1>");
  });

  it("never calls the transport for a blocked URL", async () => {
    const transport = vi.fn<Transport>(async () => page("x"));
    await expect(safeFetchText("http://127.0.0.1/", { resolve: publicDns, transport })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetchText("http://localhost/admin", { resolve: publicDns, transport })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetchText("file:///etc/passwd", { resolve: publicDns, transport })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("blocks a redirect to a private IP literal", async () => {
    const transport = vi.fn<Transport>(async (u) => (u.hostname === "shop.example" ? redirect("http://169.254.169.254/latest/meta-data/") : page("secret")));
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to localhost and to a relative-to-loopback host", async () => {
    const t1: Transport = async () => redirect("http://localhost:8080/");
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport: t1 })).rejects.toBeInstanceOf(UnsafeUrlError);
    const t2: Transport = async () => redirect("http://[::1]/");
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport: t2 })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("blocks a redirect to a hostname that resolves to a private IP (checked after DNS)", async () => {
    const resolve: Resolver = async (h) => (h === "internal.shop.example" ? ["10.1.2.3"] : [PUBLIC]);
    const transport = vi.fn<Transport>(async (u) => (u.hostname === "shop.example" ? redirect("https://internal.shop.example/") : page("secret")));
    await expect(safeFetchText("https://shop.example/", { resolve, transport })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to a non-http scheme", async () => {
    const transport: Transport = async () => redirect("file:///etc/passwd");
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("follows a safe redirect, resolving relative locations", async () => {
    const seen: string[] = [];
    const transport: Transport = async (u) => {
      seen.push(u.href);
      return u.pathname === "/old" ? redirect("/new") : page("final");
    };
    const r = await safeFetchText("https://shop.example/old", { resolve: publicDns, transport });
    expect(r.text).toBe("final");
    expect(seen).toEqual(["https://shop.example/old", "https://shop.example/new"]);
  });

  it("stops redirect loops", async () => {
    const transport: Transport = async () => redirect("/again");
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport, maxRedirects: 3 })).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("caps the response size while streaming", async () => {
    const transport: Transport = async () => ({ status: 200, headers: { "content-type": "text/html" }, body: body("a".repeat(600), "b".repeat(600)) });
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport, maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects early on an oversized content-length", async () => {
    const transport: Transport = async () => page("x", { "content-length": "99999999" });
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport, maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
  });

  it("times out a server that never answers", async () => {
    const transport: Transport = () => new Promise<RawResponse>(() => {});
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport, timeoutMs: 40 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("times out a server that stalls mid-body", async () => {
    async function* slow(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("start");
      await new Promise(() => {});
    }
    const transport: Transport = async () => ({ status: 200, headers: { "content-type": "text/html" }, body: slow() });
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport, timeoutMs: 40 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects binary content types and error statuses", async () => {
    const png: Transport = async () => ({ status: 200, headers: { "content-type": "image/png" }, body: body("x") });
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport: png })).rejects.toMatchObject({ code: "bad_content_type" });
    const nf: Transport = async () => ({ status: 404, headers: {}, body: body("") });
    await expect(safeFetchText("https://shop.example/", { resolve: publicDns, transport: nf })).rejects.toMatchObject({ code: "bad_status" });
  });
});
