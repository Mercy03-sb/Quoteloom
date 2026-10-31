import type { ReactNode } from "react";

export const metadata = {
  title: "Quoteloom",
  description: "Agent-ready storefronts with signed quotes and PayPal checkout (sandbox demo).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 880, margin: "2rem auto", padding: "0 1rem" }}>
        {children}
      </body>
    </html>
  );
}
