import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SetupCheck, SETUP_DISMISSED_STORAGE_KEY } from "./setup-check";

const replace = vi.fn();
const getSetupStatus = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace }),
}));

vi.mock("@/lib/api-client", () => ({
  api: { getSetupStatus: () => getSetupStatus() },
}));

describe("SetupCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(cleanup);

  it("redirects to setup when setup is incomplete and has not been dismissed", async () => {
    getSetupStatus.mockResolvedValue({ isSetUp: false });

    render(<SetupCheck />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/setup"));
  });

  it("allows dashboard access and shows a warning after setup is dismissed", async () => {
    window.localStorage.setItem(SETUP_DISMISSED_STORAGE_KEY, "true");
    getSetupStatus.mockResolvedValue({ isSetUp: false });

    render(<SetupCheck />);

    expect(await screen.findByText("Setup is incomplete.")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Resume setup" })).toHaveAttribute("href", "/setup");
  });

  it("clears a previous dismissal once setup is complete", async () => {
    window.localStorage.setItem(SETUP_DISMISSED_STORAGE_KEY, "true");
    getSetupStatus.mockResolvedValue({ isSetUp: true });

    render(<SetupCheck />);

    await waitFor(() =>
      expect(window.localStorage.getItem(SETUP_DISMISSED_STORAGE_KEY)).toBeNull(),
    );
    expect(replace).not.toHaveBeenCalled();
  });
});
