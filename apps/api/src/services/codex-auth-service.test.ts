import { describe, expect, it } from "vitest";
import { extractLoginDetails } from "./codex-auth-service.js";

describe("extractLoginDetails", () => {
  it("prefers the real login URL over a localhost callback", () => {
    const details = extractLoginDetails(`
Optio managed Codex login
Open this URL to continue:
https://auth.openai.com/device
Callback will arrive at http://localhost:1455/auth/callback?code=abc123
Enter code ABCD-EFGH
`);

    expect(details.loginUrl).toBe("https://auth.openai.com/device");
    expect(details.userCode).toBe("ABCD-EFGH");
  });

  it("ignores loopback callback URLs when another safe login URL is present", () => {
    const details = extractLoginDetails(`
1. Visit https://chatgpt.com/codex/login
2. Ignore http://127.0.0.1:1455/auth/callback?code=abc123
3. Ignore http://[::1]:1455/auth/callback?code=def456
`);

    expect(details.loginUrl).toBe("https://chatgpt.com/codex/login");
  });

  it("does not surface a login URL when the log only contains local callbacks", () => {
    const details = extractLoginDetails(`
Waiting for browser callback...
http://localhost:1455/auth/callback?code=abc123
http://0.0.0.0:1455/auth/callback?code=def456
Enter code WXYZ-1234
`);

    expect(details.loginUrl).toBeNull();
    expect(details.userCode).toBe("WXYZ-1234");
  });

  it("does not mistake helper copy for a device code", () => {
    const details = extractLoginDetails(`
Optio managed Codex login
Use the verification URL and device code below.
Waiting for login to continue...
`);

    expect(details.userCode).toBeNull();
  });

  it("strips ANSI color codes before extracting the device URL and code", () => {
    const details = extractLoginDetails(`
1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m
   \u001b[94mN8L6-RP9IF\u001b[0m
`);

    expect(details.loginUrl).toBe("https://auth.openai.com/codex/device");
    expect(details.userCode).toBe("N8L6-RP9IF");
  });
});
