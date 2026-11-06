"use client";

import { AgStudioAiModule, createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgDataSourcesDefinition, type AgReportState, type AgStudioApi } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_REPORT, PROMPT_STARTERS } from "@/lib/studio-report";
import { STUDIO_FIELDS, STUDIO_TABLES, STUDIO_TABLE_NAMES } from "@/lib/studio-fields";
import { MAX_TURNS_PER_PROMPT } from "@/lib/studio-limits";
import { analystInstructions } from "@/lib/studio-instructions";
import { createStudioAdapter } from "./adapter";
import { checkLicence } from "./licence";

const MODULES = [AgStudioAiModule];

/** The single agent: no delegation, no planning tools, at most MAX_TURNS_PER_PROMPT rounds (the route enforces the same cap). The schema and the open page
 *  are in its instructions (read from the Studio API on each request), so it acts on turn 1: no default tool calls, no view_schema / view_page. */
const ANALYST = {
  id: "analyst",
  name: "Analyst",
  maxTurns: MAX_TURNS_PER_PROMPT,
};

/** Data source: every table is fetched from our own route, which scopes it to this workspace and shop. */
function dataFor(shop: string): AgDataSourcesDefinition {
  return {
    sources: [
      {
        id: "quoteloom",
        name: "Quoteloom",
        dataShape: "row",
        getData: async (tableId: string) => {
          const res = await fetch(`/api/studio/data?table=${encodeURIComponent(tableId)}&shop=${encodeURIComponent(shop)}`, { credentials: "same-origin" });
          if (!res.ok) throw new Error(`Data request failed (${res.status})`);
          const body = (await res.json()) as { rows: Record<string, string | number | null>[] };
          return { data: body.rows };
        },
        tables: STUDIO_TABLES.map((id) => ({
          id,
          name: STUDIO_TABLE_NAMES[id],
          description: "Seeded demo history is included and marked Demo in the Data column.",
          fields: STUDIO_FIELDS[id].map((f) => ({ ...f })),
        })),
      },
    ],
  } as AgDataSourcesDefinition;
}

export type StudioViewProps = { shop: string; licenceKey: string; onUnavailable: (reason: "invalid" | "expired" | "failed") => void };

export default function StudioView({ shop, licenceKey, onUnavailable }: StudioViewProps) {
  const licence = useMemo(() => checkLicence(licenceKey), [licenceKey]);
  const data = useMemo(() => dataFor(shop), [shop]);
  const initialState = useMemo<AgReportState>(() => DEFAULT_REPORT, []);
  const apiRef = useRef<AgStudioApi | undefined>(undefined);
  const [modelOn, setModelOn] = useState<boolean | null>(null);

  // The chat is a Studio chat whose model is Gemini, reached through our own route (the key stays on the server).
  // One agent replaces the five built-ins (lead, data, page, planning, widget): they delegate to each other, which cost about 10 model
  // calls per prompt. This one has only query, widget and filter tools, is handed the schema up front, and may take 4 rounds at most (the last without tools).
  const ai = useMemo<AgAiHarnessSetup>(
    () =>
      ({ api }) => {
        const studioApi = api as AgStudioApi;
        return (
        // The setup callback's typing says AgCoreStudioApi; at runtime it is the full Studio API (as in the docs' examples).
        createAiHarness(studioApi, ({ tools: { studio } }) => ({
          agents: [
            directLlmRunner({
              ...ANALYST,
              instructions: () => analystInstructions(studioApi.getAiContext().schema().tables as never, studioApi.getState() as never),
              schema: (s) => s.undefined(), // a primary agent runs with no parameters
              adapter: createStudioAdapter({ getApi: () => apiRef.current }),
              tools: () => [studio.executeQuery(), studio.addWidget(), studio.addPageFilter(), studio.addWidgetFilter()],
            }),
          ],
          primary: ANALYST.id,
          promptStarters: PROMPT_STARTERS.map(({ label, prompt }) => ({ label, prompt })),
        }))
        );
      },
    [],
  );

  useEffect(() => {
    if (!licence.ok) onUnavailable(licence.reason);
  }, [licence, onUnavailable]);
  useEffect(() => {
    let live = true;
    fetch("/api/studio/ai", { credentials: "same-origin" })
      .then((r) => r.json() as Promise<{ available?: boolean }>)
      .then((b) => live && setModelOn(Boolean(b.available)))
      .catch(() => live && setModelOn(false));
    return () => {
      live = false;
    };
  }, []);
  if (!licence.ok) return null;

  return (
    <div className="stack">
      {licence.ai && modelOn === false && (
        <div className="notice" data-tone="warning" role="status" data-testid="studio-ai-off">
          The AI assistant is off because the Gemini model is not configured here. The chat panel will say so, and its prompt starters still load prebuilt reports.
        </div>
      )}
      {!licence.ai && (
        <div className="notice" data-tone="warning" role="status">The licence key does not include the AI feature, so the chat panel is hidden. Editing the dashboard works as normal.</div>
      )}
      <div className="studio-box" data-testid="studio-box">
        <AgStudioProvider modules={licence.ai ? MODULES : undefined} licenseKey={licenceKey}>
          <AgStudio style={{ height: "100%", width: "100%" }} data={data} mode="edit" initialState={initialState} ai={licence.ai ? ai : undefined} onApiReady={(e) => { apiRef.current = e.api; }} />
        </AgStudioProvider>
      </div>
    </div>
  );
}
