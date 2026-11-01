import { resolveBaseUrl } from "@/lib/base-url";
import { getDb } from "@/lib/db";
import { draftFromCsv, MAX_CSV_BYTES } from "@/lib/ingest/csv";
import { finalizeDraft, ingestUrl, makeFetcher, type IngestResult, type StepEvent } from "@/lib/ingest/pipeline";
import { FetchError, UnsafeUrlError } from "@/lib/ingest/safe-fetch";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { resolveWorkspace, withWorkspaceCookie } from "@/lib/workspace";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.union([z.object({ url: z.string().min(1).max(2048) }), z.object({ csv: z.string().min(1).max(MAX_CSV_BYTES) })]);

export type IngestEvent =
  | ({ type: "step" } & StepEvent)
  | { type: "result"; result: IngestResult }
  | { type: "error"; message: string };

/**
 * Build a draft catalog from a URL or CSV text. Answers as newline-delimited JSON so the Setup screen can
 * show each step as it happens: {type:"step"}..., then {type:"result"} or {type:"error"}.
 */
export async function POST(req: Request): Promise<Response> {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", message: "Send a url or csv." }, { status: 400 });
  const db = getDb();
  const ws = resolveWorkspace(db, req.headers);
  const limited = limitResponse(limiter().check("ingest", { workspace: ws.id, ip: clientIp(req.headers) }));
  if (limited) return withWorkspaceCookie(limited, ws);

  const body = parsed.data;
  const selfOrigin = new URL(resolveBaseUrl(req.headers)).origin;
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: IngestEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      const step = (e: StepEvent) => send({ type: "step", ...e });
      try {
        if ("url" in body) {
          send({ type: "result", result: await ingestUrl(db, body.url, { fetchPage: makeFetcher(selfOrigin), selfOrigin, onStep: step }) });
        } else {
          step({ id: "fetch", label: "Reading the CSV", status: "running" });
          const csv = draftFromCsv(body.csv);
          if (csv.error) {
            step({ id: "fetch", label: "Reading the CSV", status: "error", detail: csv.error });
            send({ type: "error", message: csv.error });
          } else {
            step({ id: "fetch", label: "Reading the CSV", status: "done", detail: `${csv.products.length} rows` });
            step({ id: "draft", label: "Building the draft catalog", status: "running" });
            const products = finalizeDraft(csv.products);
            const warnings = [...csv.warnings];
            const noPrice = products.filter((p) => p.price_cents === 0).length;
            if (noPrice) warnings.push(`${noPrice} product${noPrice === 1 ? " has" : "s have"} no valid price. Fix them in the table.`);
            step({ id: "draft", label: "Building the draft catalog", status: "done", detail: `${products.length} products` });
            send({
              type: "result",
              result: { shopName: "My CSV shop", sourceUrl: "", products, methods: { jsonld: 0, opengraph: 0, llm: 0, rules: 0 }, warnings },
            });
          }
        }
      } catch (e) {
        const message = e instanceof UnsafeUrlError || e instanceof FetchError ? e.message : "Something went wrong while reading that site.";
        if (!(e instanceof UnsafeUrlError || e instanceof FetchError)) console.error("[ingest] unexpected error:", (e as Error).message);
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return withWorkspaceCookie(
    new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } }),
    ws,
  );
}
