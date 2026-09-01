import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexDeviceCode } from "./codex-device-code";

describe("CodexDeviceCode", () => {
  afterEach(() => cleanup());

  it("does not render when no real device code is available", () => {
    const { container, rerender } = render(<CodexDeviceCode deviceCode={null} />);

    expect(container).toBeEmptyDOMElement();

    rerender(<CodexDeviceCode deviceCode="   " />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a selectable device code in a distinct box", () => {
    render(<CodexDeviceCode deviceCode="  ABCD-EFGH  " />);

    const code = screen.getByText("ABCD-EFGH");
    expect(code).toHaveClass("select-all");
    expect(code.closest("div")).toHaveClass("border-primary/30");
  });

  it("copies the device code with the explicit copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<CodexDeviceCode deviceCode="ABCD-EFGH" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy device code" }));

    expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
  });
});
