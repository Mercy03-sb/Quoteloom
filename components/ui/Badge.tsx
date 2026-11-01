import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export function Badge({ tone = "neutral", dot, children }: { tone?: BadgeTone; dot?: boolean; children: ReactNode }) {
  return <span className={cx("badge", tone !== "neutral" && `badge-${tone}`, dot && "badge-dot")}>{children}</span>;
}
