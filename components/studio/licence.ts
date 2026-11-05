// Licence guard for AG Studio. Runs in the browser, inside the lazily loaded Studio chunk.
// Uses AgStudioLicenseManager.getLicenseDetails (marked @internal in the typings), so every call is wrapped:
// anything unexpected counts as "invalid" and /studio shows the AG Grid Community version instead.
import { AgStudioLicenseManager } from "ag-studio";

export type LicenceCheck = { ok: true; ai: boolean } | { ok: false; reason: "invalid" | "expired" };

const usable = (key: string, level: "PRO-AI" | "PRO" | "CORE"): "ok" | "expired" | "no" => {
  const d = AgStudioLicenseManager.getLicenseDetails(key, new Set([level]));
  if (!d.valid) return "no";
  return d.expired ? "expired" : "ok";
};

/** ai is true only when the key includes the AI feature (STUDIO-PRO-AI). */
export function checkLicence(key: string): LicenceCheck {
  try {
    let sawExpired = false;
    for (const level of ["PRO-AI", "PRO", "CORE"] as const) {
      const r = usable(key, level);
      if (r === "ok") return { ok: true, ai: level === "PRO-AI" };
      if (r === "expired") sawExpired = true;
    }
    return { ok: false, reason: sawExpired ? "expired" : "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
