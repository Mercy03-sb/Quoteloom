"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ToastTone = "info" | "success" | "danger";
export type ToastItem = { id: number; message: string; tone: ToastTone };

/** Pure helpers so the queue behaviour is testable without a DOM. */
export const MAX_TOASTS = 4;
export function addToast(list: ToastItem[], item: ToastItem): ToastItem[] {
  return [...list, item].slice(-MAX_TOASTS);
}
export function removeToast(list: ToastItem[], id: number): ToastItem[] {
  return list.filter((t) => t.id !== id);
}

type Push = (message: string, tone?: ToastTone) => void;
const ToastContext = createContext<Push>(() => {});

export function useToast(): Push {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => setItems((l) => removeToast(l, id)), []);
  const push = useCallback<Push>(
    (message, tone = "info") => {
      const id = Date.now() + Math.random();
      setItems((l) => addToast(l, { id, message, tone }));
      setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast" data-tone={t.tone} role="status">
            <span>{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
