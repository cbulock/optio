import { describe, expect, it } from "vitest";
import { extractCodexDeviceAuth } from "./codex-auth-service.js";

describe("extractCodexDeviceAuth", () => {
  it("extracts a device verification URL and code from Codex output", () => {
    expect(
      extractCodexDeviceAuth("Open https://auth.openai.com/codex/device and enter code ABCD-EFGH"),
    ).toEqual({ loginUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" });
  });

  it("does not expose loopback callback URLs", () => {
    expect(extractCodexDeviceAuth("Open http://localhost:1455/callback")).toEqual({
      loginUrl: null,
      userCode: null,
    });
  });
});
