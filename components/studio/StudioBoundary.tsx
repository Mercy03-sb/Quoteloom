"use client";

import { Component, type ReactNode } from "react";

/** Catches a crash while Studio renders and hands control back to the fallback. Logs only the message. */
export class StudioBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("[studio] AG Studio crashed, showing the Community view:", error instanceof Error ? error.message : "unknown error");
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
