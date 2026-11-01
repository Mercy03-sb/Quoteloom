"use client";

import { Button } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page">
      <div className="error-box" role="alert">
        <h2>Something snagged the thread</h2>
        <p>{error.message || "An unexpected error occurred."}</p>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
