"use client";

import { AgStudioAiModule, createAiHarness, type AgAiHarnessSetup, type AgDataSourcesDefinition, type AgReportState, type AgStudioApi } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_REPORT, PROMPT_STARTERS } from "@/lib/studio-report";
import { STUDIO_FIELDS, STUDIO_TABLES, STUDIO_TABLE_NAMES } from "@/lib/studio-fields";
import { createStudioAdapter } from "./adapter";
import { checkLicence } from "./licence";

const MODULES = [AgStudioAiModule];

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

  // The chat is a normal Studio chat whose model is Gemini, reached through our own route (the key stays on the server).
  const ai = useMemo<AgAiHarnessSetup>(
    () =>
      ({ api }) =>
        // The setup callback's typing says AgCoreStudioApi; at runtime it is the full Studio API (as in the docs' examples).
        createAiHarness(api as AgStudioApi, {
          adapter: createStudioAdapter({ getApi: () => apiRef.current }),
          promptStarters: PROMPT_STARTERS.map(({ label, prompt }) => ({ label, prompt })),
        }),
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
