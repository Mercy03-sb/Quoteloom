// @vitest-environment happy-dom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewGrid, type DraftRow } from "@/components/setup/ReviewGrid";

afterEach(cleanup);

const rows: DraftRow[] = [
  { _id: "r1", sku: "A-1", title: "Stoneware mug", description: "Nice", price_cents: 2400, currency: "USD", stock: 5 },
  { _id: "r2", sku: "A-2", title: "Mystery item", description: "", price_cents: 0, currency: "USD", stock: 5 },
];

describe("ReviewGrid (real AG Grid)", () => {
  it("mounts the editable grid and unmounts with no console errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container, unmount } = render(<ReviewGrid rows={rows} onChange={() => {}} onDelete={() => {}} />);
    await waitFor(() => expect(container.querySelector(".ag-root-wrapper")).toBeTruthy());
    // happy-dom has a zero-size viewport, so AG Grid virtualises away headers and cells: editing, cell
    // outlines and the Delete buttons can only be checked in a real browser. This guards mounting and unmounting.
    expect(() => unmount()).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("renders without rows (all deleted) without crashing", async () => {
    const { container } = render(<ReviewGrid rows={[]} onChange={() => {}} onDelete={() => {}} />);
    await waitFor(() => expect(container.querySelector(".ag-root-wrapper")).toBeTruthy());
  });
});
