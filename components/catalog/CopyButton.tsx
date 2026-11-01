"use client";

import { Button, useToast } from "@/components/ui";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard", "success");
    } catch {
      toast("Could not copy. Select the text and copy it manually.", "danger");
    }
  }
  return (
    <Button variant="secondary" size="sm" onClick={copy}>
      {label}
    </Button>
  );
}
