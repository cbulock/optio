import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  codexAuthAccounts: {},
  repoPods: {},
}));

vi.mock("./interactive-session-service.js", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("./container-service.js", () => ({
  getRuntime: vi.fn(),
}));

vi.mock("./secret-service.js", () => ({
  retrieveSecretWithFallback: vi.fn(),
  storeSecret: vi.fn(),
}));

describe("extractLoginDetails", () => {
  it("prefers the real OpenAI login URL over a localhost callback URL", async () => {
    const { extractLoginDetails } = await import("./codex-auth-service.js");

    const details = extractLoginDetails(`
Open this URL to continue:
https://auth.openai.com/device?user_code=ABCD-EFGH
Waiting for callback on http://localhost:1455/auth/callback?code=secret
    `);

    expect(details.loginUrl).toBe("https://auth.openai.com/device?user_code=ABCD-EFGH");
    expect(details.userCode).toBe("ABCD-EFGH");
  });

  it("returns null when only loopback callback URLs are present", async () => {
    const { extractLoginDetails } = await import("./codex-auth-service.js");

    const details = extractLoginDetails(`
Browser redirect complete.
http://localhost:1455/auth/callback?code=secret
http://127.0.0.1:1455/auth/callback?code=secret
http://[::1]:1455/auth/callback?code=secret
    `);

    expect(details.loginUrl).toBeNull();
    expect(details.logExcerpt).toContain("auth/callback");
  });

  it("keeps the device code even when loopback URLs are ignored", async () => {
    const { extractLoginDetails } = await import("./codex-auth-service.js");

    const details = extractLoginDetails(`
Go to https://chatgpt.com/device and enter code WXYZ-1234
Callback server: http://localhost:1455/auth/callback?ok=true
    `);

    expect(details.loginUrl).toBe("https://chatgpt.com/device");
    expect(details.userCode).toBe("WXYZ-1234");
  });
});
