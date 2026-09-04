import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

let currentAccount: any = null;
let currentRepoPod: any = null;

const {
  codexAuthAccounts,
  repoPods,
  mockGetSession,
  mockStoreSecret,
  mockRetrieveSecretWithFallback,
  mockRuntime,
} = vi.hoisted(() => ({
  codexAuthAccounts: {
    __table: "codexAuthAccounts",
    id: "id",
    name: "name",
    workspaceId: "workspaceId",
  },
  repoPods: {
    __table: "repoPods",
    id: "id",
  },
  mockGetSession: vi.fn(),
  mockStoreSecret: vi.fn(),
  mockRetrieveSecretWithFallback: vi.fn(),
  mockRuntime: {
    create: vi.fn(),
    status: vi.fn(),
    exec: vi.fn(),
    destroy: vi.fn(),
  },
}));

function makeUpdateChain(table: any, values: Record<string, unknown>) {
  if (table === codexAuthAccounts) {
    currentAccount = { ...currentAccount, ...values };
  }
  if (table === repoPods) {
    currentRepoPod = { ...currentRepoPod, ...values };
  }
  return {
    returning: vi.fn(async () => {
      if (table === codexAuthAccounts) return [currentAccount];
      if (table === repoPods) return [currentRepoPod];
      return [];
    }),
  };
}

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(async () => {
          if (table === codexAuthAccounts) return currentAccount ? [currentAccount] : [];
          if (table === repoPods) return currentRepoPod ? [currentRepoPod] : [];
          return [];
        }),
      })),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          if (table === codexAuthAccounts) {
            currentAccount = { id: "acct-1", ...values };
            return [currentAccount];
          }
          if (table === repoPods) {
            currentRepoPod = { id: "pod-row-1", ...values };
            return [currentRepoPod];
          }
          return [];
        }),
      })),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => makeUpdateChain(table, values)),
      })),
    })),
  },
}));

vi.mock("../db/schema.js", () => ({
  codexAuthAccounts,
  repoPods,
}));

vi.mock("./interactive-session-service.js", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock("./container-service.js", () => ({
  getRuntime: () => mockRuntime,
}));

vi.mock("./secret-service.js", () => ({
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
  retrieveSecretWithFallback: (...args: unknown[]) => mockRetrieveSecretWithFallback(...args),
}));

import {
  buildCodexAuthPodSpec,
  cancelCodexAuthSession,
  extractCodexDeviceAuth,
  getCodexAuthLoginStatus,
  startCodexAuthSession,
  syncCodexAuthFromRepoPod,
} from "./codex-auth-service.js";

function execResult(stdoutText: string, stderrText = "") {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  queueMicrotask(() => {
    stdout.end(stdoutText);
    stderr.end(stderrText);
  });
  return {
    stdout,
    stderr,
  };
}

describe("codex-auth-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentAccount = null;
    currentRepoPod = null;
    mockRetrieveSecretWithFallback.mockResolvedValue(null);
    mockRuntime.destroy.mockResolvedValue(undefined);
  });

  it("extracts a device verification URL and code from Codex output", () => {
    expect(
      extractCodexDeviceAuth("Open https://auth.openai.com/codex/device and enter code ABCD-EFGH"),
    ).toEqual({ loginUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" });
  });

  it("builds a repo-free auth pod spec with no git or repo mounts", () => {
    const spec = buildCodexAuthPodSpec();

    expect(spec.workDir).toBe("/home/agent");
    expect(spec.command).toEqual(["bash", "-lc", "sleep infinity"]);
    expect(spec.env).toEqual({});
    expect(spec.volumes).toBeUndefined();
    expect(spec.labels["optio.type"]).toBe("codex-auth-pod");
  });

  it("starts a temporary auth pod without repo or git credential env", async () => {
    mockRuntime.create.mockResolvedValue({
      id: "pod-handle-1",
      name: "optio-codex-auth-abcd1234",
    });
    mockRuntime.exec
      .mockResolvedValueOnce(execResult("started\n"))
      .mockResolvedValueOnce(
        execResult(
          "Open https://auth.openai.com/codex/device and enter code ABCD-EFGH\n__OPTIO_CODEX_AUTH__AUTH=0;DONE=0;EXIT=\n",
        ),
      );

    const result = await startCodexAuthSession({
      workspaceId: "ws-1",
      userId: "u1",
      appServerUrl: "ws://localhost:3900/v1/connect",
    });

    const spec = mockRuntime.create.mock.calls[0][0];
    expect(spec.env).toEqual({});
    expect(spec.volumes).toBeUndefined();
    expect(spec.labels["optio.type"]).toBe("codex-auth-pod");
    expect(spec.env.OPTIO_REPO_URL).toBeUndefined();
    expect(spec.env.OPTIO_GIT_CREDENTIAL_URL).toBeUndefined();
    expect(spec.env.GITHUB_TOKEN).toBeUndefined();
    expect(result.authPod.name).toBe("optio-codex-auth-abcd1234");
    expect(result.deviceAuth).toEqual({
      loginUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    expect(currentAccount.loginPodId).toBe("pod-handle-1");
    expect(currentAccount.loginPodName).toBe("optio-codex-auth-abcd1234");
    expect(currentAccount.loginSessionId).toBeNull();
    expect(currentAccount.loginSessionRepoUrl).toBeNull();
  });

  it("copies refreshed repo-pod auth back to the shared credential", async () => {
    mockRuntime.exec.mockResolvedValue(execResult('{"access_token":"fresh"}'));

    await expect(
      syncCodexAuthFromRepoPod({ handle: { id: "pod-1", name: "pod-1" } }),
    ).resolves.toBe(true);

    expect(mockStoreSecret).toHaveBeenCalledWith(
      "CODEX_AUTH_JSON",
      '{"access_token":"fresh"}',
      "global",
    );
  });

  it("auto-imports auth.json from the pod and destroys it on success", async () => {
    currentAccount = {
      id: "acct-1",
      name: "default",
      workspaceId: "ws-1",
      status: "pending",
      appServerUrl: "ws://localhost:3900/v1/connect",
      loginSessionId: null,
      loginSessionRepoUrl: null,
      loginPodId: "pod-handle-1",
      loginPodName: "optio-codex-auth-abcd1234",
      loginExpiresAt: new Date(Date.now() + 60_000),
      lastError: null,
      lastImportedAt: null,
      lastValidatedAt: null,
    };
    mockRuntime.status.mockResolvedValue({ state: "running" });
    mockRuntime.exec
      .mockResolvedValueOnce(
        execResult(
          "Open https://auth.openai.com/codex/device and enter code ABCD-EFGH\n__OPTIO_CODEX_AUTH__AUTH=1;DONE=0;EXIT=\n",
        ),
      )
      .mockResolvedValueOnce(execResult('{"access_token":"abc"}'));

    const result = await getCodexAuthLoginStatus({ workspaceId: "ws-1" });

    expect(result.login.state).toBe("connected");
    expect(result.account?.status).toBe("connected");
    expect(result.account?.loginPodName).toBeNull();
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "CODEX_AUTH_JSON",
      '{"access_token":"abc"}',
      "global",
    );
    expect(mockRuntime.destroy).toHaveBeenCalledWith({
      id: "pod-handle-1",
      name: "optio-codex-auth-abcd1234",
    });
  });

  it("cleans up expired auth pods and reports timeout", async () => {
    currentAccount = {
      id: "acct-1",
      name: "default",
      workspaceId: "ws-1",
      status: "pending",
      appServerUrl: "ws://localhost:3900/v1/connect",
      loginPodId: "pod-handle-1",
      loginPodName: "optio-codex-auth-abcd1234",
      loginExpiresAt: new Date(Date.now() - 1_000),
      lastError: null,
    };

    const result = await getCodexAuthLoginStatus({ workspaceId: "ws-1" });

    expect(result.login.state).toBe("error");
    expect(result.login.lastError).toContain("timed out");
    expect(result.account?.loginPodName).toBeNull();
    expect(result.account?.status).toBe("error");
    expect(mockRuntime.destroy).toHaveBeenCalled();
  });

  it("cleans up terminal login failures that never produce auth.json", async () => {
    currentAccount = {
      id: "acct-1",
      name: "default",
      workspaceId: "ws-1",
      status: "pending",
      appServerUrl: "ws://localhost:3900/v1/connect",
      loginPodId: "pod-handle-1",
      loginPodName: "optio-codex-auth-abcd1234",
      loginExpiresAt: new Date(Date.now() + 60_000),
      lastError: null,
    };
    mockRuntime.status.mockResolvedValue({ state: "running" });
    mockRuntime.exec.mockResolvedValue(
      execResult(
        "Open https://auth.openai.com/codex/device and enter code ABCD-EFGH\n__OPTIO_CODEX_AUTH__AUTH=0;DONE=1;EXIT=7\n",
      ),
    );

    const result = await getCodexAuthLoginStatus({ workspaceId: "ws-1" });

    expect(result.login.state).toBe("error");
    expect(result.login.lastError).toContain("status 7");
    expect(result.account?.loginPodName).toBeNull();
    expect(result.account?.status).toBe("error");
    expect(mockRuntime.destroy).toHaveBeenCalled();
  });

  it("cancels the auth pod and clears its handle", async () => {
    currentAccount = {
      id: "acct-1",
      name: "default",
      workspaceId: "ws-1",
      status: "pending",
      appServerUrl: "ws://localhost:3900/v1/connect",
      loginPodId: "pod-handle-1",
      loginPodName: "optio-codex-auth-abcd1234",
      loginExpiresAt: new Date(Date.now() + 60_000),
      lastError: null,
    };

    const result = await cancelCodexAuthSession({ workspaceId: "ws-1" });

    expect(result).toEqual({ canceled: true });
    expect(currentAccount.loginPodName).toBeNull();
    expect(currentAccount.loginPodId).toBeNull();
    expect(currentAccount.status).toBe("pending");
    expect(mockRuntime.destroy).toHaveBeenCalledWith({
      id: "pod-handle-1",
      name: "optio-codex-auth-abcd1234",
    });
  });
});
