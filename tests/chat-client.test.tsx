// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatClient } from "@/components/chat/ChatClient";

afterEach(cleanup);

describe("ChatClient", () => {
  it("renders and its effects return only cleanup functions", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // A scrollIntoView that returns a value must not leak out of useEffect.
    const scroll = vi.fn(() => Promise.resolve("not-a-cleanup"));
    Element.prototype.scrollIntoView = scroll as unknown as Element["scrollIntoView"];

    const { unmount } = render(<ChatClient />);
    expect(screen.getByRole("log")).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
    expect(() => unmount()).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
