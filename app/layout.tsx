import "@fontsource-variable/fraunces";
import "@fontsource-variable/hanken-grotesk";
import "./globals.css";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { ModeBadges } from "@/components/shell/ModeBadges";
import { themeInitScript } from "@/components/shell/theme-init";
import { themeCss } from "@/lib/design/tokens";

export const metadata = {
  title: { default: "Quoteloom", template: "%s · Quoteloom" },
  description: "Agent-ready storefronts with signed quotes and PayPal checkout (sandbox demo).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style dangerouslySetInnerHTML={{ __html: themeCss() }} />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <AppShell badges={<ModeBadges />}>{children}</AppShell>
      </body>
    </html>
  );
}
