"use client";

import { AgStudioAiModule, type AgDataSourcesDefinition, type AgReportState } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useEffect, useMemo } from "react";
import { DEFAULT_REPORT } from "@/lib/studio-report";
import { STUDIO_FIELDS, STUDIO_TABLES, STUDIO_TABLE_NAMES } from "@/lib/studio-fields";
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
  useEffect(() => {
    if (!licence.ok) onUnavailable(licence.reason);
  }, [licence, onUnavailable]);
  if (!licence.ok) return null;

  return (
    <div className="studio-box" data-testid="studio-box">
      <AgStudioProvider modules={MODULES} licenseKey={licenceKey}>
        <AgStudio style={{ height: "100%", width: "100%" }} data={data} mode="edit" initialState={initialState} />
      </AgStudioProvider>
    </div>
  );
}
