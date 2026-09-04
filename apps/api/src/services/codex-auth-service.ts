import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  parseIntEnv,
  DEFAULT_AGENT_IMAGE,
  type ContainerHandle,
  type ContainerSpec,
} from "@optio/shared";
import { db } from "../db/client.js";
import { codexAuthAccounts, repoPods } from "../db/schema.js";
import { getSession } from "./interactive-session-service.js";
import { getRuntime } from "./container-service.js";
import { retrieveSecretWithFallback, storeSecret } from "./secret-service.js";

const CODEX_AUTH_PATH = "/home/agent/.codex/auth.json";
const CODEX_LOGIN_LOG_PATH = "/tmp/optio-codex-login.log";
const CODEX_LOGIN_EXIT_CODE_PATH = "/tmp/optio-codex-login.exit";
const CODEX_LOGIN_DONE_PATH = "/tmp/optio-codex-login.done";
const CODEX_AUTH_POD_TIMEOUT_MS = parseIntEnv("OPTIO_CODEX_AUTH_POD_TIMEOUT_MS", 15 * 60 * 1000);
const CODEX_DEVICE_CODE_WAIT_MS = 8_000;
const CODEX_DEVICE_CODE_POLL_MS = 250;

function workspaceCondition(workspaceId?: string | null) {
  return workspaceId
    ? eq(codexAuthAccounts.workspaceId, workspaceId)
    : isNull(codexAuthAccounts.workspaceId);
}

function parseOptionalJsonEnv<T>(name: string, raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getServiceAccountName(): string | undefined {
  return process.env.OPTIO_SERVICE_ACCOUNT_NAME;
}

function buildCodexLoginScript() {
  return [
    "set -u",
    'export CODEX_HOME="/home/agent/.codex"',
    'mkdir -p "$CODEX_HOME"',
    'printf \'cli_auth_credentials_store = "file"\\n\' > "$CODEX_HOME/config.toml"',
    'chmod 700 "$CODEX_HOME"',
    'chmod 600 "$CODEX_HOME/config.toml"',
    `rm -f ${JSON.stringify(CODEX_LOGIN_LOG_PATH)} ${JSON.stringify(CODEX_LOGIN_EXIT_CODE_PATH)} ${JSON.stringify(CODEX_LOGIN_DONE_PATH)}`,
    "set +e",
    `codex login --device-auth 2>&1 | tee ${JSON.stringify(CODEX_LOGIN_LOG_PATH)}`,
    'status="$?"',
    `printf '%s\\n' "$status" > ${JSON.stringify(CODEX_LOGIN_EXIT_CODE_PATH)}`,
    `touch ${JSON.stringify(CODEX_LOGIN_DONE_PATH)}`,
    "exit 0",
  ].join("\n");
}

export function buildCodexAuthPodSpec(): ContainerSpec {
  return {
    name: `optio-codex-auth-${randomUUID().slice(0, 8)}`,
    image: process.env.OPTIO_AGENT_IMAGE ?? DEFAULT_AGENT_IMAGE,
    imagePullPolicy:
      (process.env.OPTIO_IMAGE_PULL_POLICY as "Always" | "Never" | "IfNotPresent" | undefined) ??
      "IfNotPresent",
    command: ["bash", "-lc", "sleep infinity"],
    env: {},
    workDir: "/home/agent",
    labels: {
      "managed-by": "optio",
      "optio.type": "codex-auth-pod",
      "optio.codex-auth": "true",
    },
    ...(process.env.OPTIO_AGENT_NODE_SELECTOR
      ? {
          nodeSelector: parseOptionalJsonEnv<Record<string, string>>(
            "OPTIO_AGENT_NODE_SELECTOR",
            process.env.OPTIO_AGENT_NODE_SELECTOR,
          ),
        }
      : {}),
    ...(process.env.OPTIO_AGENT_TOLERATIONS
      ? {
          tolerations: parseOptionalJsonEnv<unknown[]>(
            "OPTIO_AGENT_TOLERATIONS",
            process.env.OPTIO_AGENT_TOLERATIONS,
          ),
        }
      : {}),
    ...(getServiceAccountName() ? { serviceAccountName: getServiceAccountName() } : {}),
  };
}

export function extractCodexDeviceAuth(logOutput: string) {
  const sanitized = logOutput.replace(/\u001b\[[0-9;]*m/g, "");
  const urls = Array.from(sanitized.matchAll(/https?:\/\/[^\s)<>'\"]+/g), (match) => match[0]);
  const loginUrl =
    urls.find(
      (url) =>
        /auth|login|device|openai|chatgpt/i.test(url) &&
        !/localhost|127\.0\.0\.1|\[::1\]/i.test(url),
    ) ?? null;
  const userCode = sanitized.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/)?.at(-1) ?? null;
  return { loginUrl, userCode };
}

export interface CodexAuthLoginStatus {
  state:
    | "not_started"
    | "starting"
    | "waiting_for_login"
    | "ready_to_import"
    | "connected"
    | "error";
  canImport: boolean;
  authDetected: boolean;
  sessionId: string | null;
  repoUrl: string | null;
  podName: string | null;
  expiresAt: string | null;
  loginUrl: string | null;
  userCode: string | null;
  lastError: string | null;
}

async function collectExecOutput(session: {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
}): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdoutDone = new Promise<void>((resolve) => {
    session.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    session.stdout.on("end", resolve);
  });

  const stderrDone = new Promise<void>((resolve) => {
    session.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    session.stderr.on("end", resolve);
  });

  await Promise.all([stdoutDone, stderrDone]);
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

type CodexAuthAccount = Awaited<ReturnType<typeof getCodexAuthAccount>>;

function buildBaseLoginStatus(
  account: CodexAuthAccount,
): Omit<CodexAuthLoginStatus, "state" | "canImport" | "authDetected" | "loginUrl" | "userCode"> {
  return {
    sessionId: account?.loginSessionId ?? null,
    repoUrl: account?.loginSessionRepoUrl ?? null,
    podName: account?.loginPodName ?? null,
    expiresAt: account?.loginExpiresAt?.toISOString() ?? null,
    lastError: account?.lastError ?? null,
  };
}

export async function getCodexAuthAccount(workspaceId?: string | null) {
  const [account] = await db
    .select()
    .from(codexAuthAccounts)
    .where(and(eq(codexAuthAccounts.name, "default"), workspaceCondition(workspaceId)));
  return account ?? null;
}

async function destroyHandle(handle: ContainerHandle | null | undefined) {
  if (!handle) return;
  await getRuntime()
    .destroy(handle)
    .catch(() => {});
}

async function clearLoginHandle(
  accountId: string,
  updates: {
    status?: "pending" | "connected" | "error";
    lastError?: string | null;
    lastImportedAt?: Date | null;
    lastValidatedAt?: Date | null;
  } = {},
) {
  const values: Record<string, unknown> = {
    loginSessionId: null,
    loginSessionRepoUrl: null,
    loginPodId: null,
    loginPodName: null,
    loginExpiresAt: null,
    lastError: updates.lastError ?? null,
    updatedAt: new Date(),
  };
  if ("lastImportedAt" in updates) values.lastImportedAt = updates.lastImportedAt;
  if ("lastValidatedAt" in updates) values.lastValidatedAt = updates.lastValidatedAt;
  if (updates.status) values.status = updates.status;
  await db.update(codexAuthAccounts).set(values).where(eq(codexAuthAccounts.id, accountId));
}

function resolveAuthPodHandle(account: NonNullable<CodexAuthAccount>): ContainerHandle | null {
  if (!account.loginPodName) return null;
  return {
    id: account.loginPodId ?? account.loginPodName,
    name: account.loginPodName,
  };
}

async function cleanupAuthPod(
  account: NonNullable<CodexAuthAccount>,
  updates: Parameters<typeof clearLoginHandle>[1] = {},
) {
  await destroyHandle(resolveAuthPodHandle(account));
  await clearLoginHandle(account.id, updates);
}

async function startCodexLoginInPod(handle: ContainerHandle) {
  const launchScript = [
    "set -euo pipefail",
    "cat > /tmp/optio-start-codex-login.sh <<'EOF'",
    buildCodexLoginScript(),
    "EOF",
    "chmod 700 /tmp/optio-start-codex-login.sh",
    "nohup bash /tmp/optio-start-codex-login.sh >/tmp/optio-start-codex-login.nohup 2>&1 </dev/null &",
    "echo started",
  ].join("\n");
  const exec = await getRuntime().exec(handle, ["bash", "-lc", launchScript], { tty: false });
  const result = await collectExecOutput(exec);
  if (!result.stdout.includes("started")) {
    throw new Error(result.stderr.trim() || "Failed to start managed Codex login");
  }
}

function parsePodProbe(stdout: string) {
  const marker = "__OPTIO_CODEX_AUTH__";
  const [logOutput, trailer = ""] = stdout.split(marker);
  const parts = new URLSearchParams(trailer.trim().replaceAll(";", "&"));
  return {
    logOutput,
    authDetected: parts.get("AUTH") === "1",
    done: parts.get("DONE") === "1",
    exitCode: parts.get("EXIT")?.trim() || null,
  };
}

async function probeAuthPod(handle: ContainerHandle) {
  const exec = await getRuntime().exec(
    handle,
    [
      "bash",
      "-lc",
      [
        `AUTH=0; test -s ${CODEX_AUTH_PATH} && AUTH=1`,
        `DONE=0; test -f ${CODEX_LOGIN_DONE_PATH} && DONE=1`,
        `EXIT_CODE="$(cat ${CODEX_LOGIN_EXIT_CODE_PATH} 2>/dev/null || true)"`,
        `tail -c 12000 ${CODEX_LOGIN_LOG_PATH} 2>/dev/null || true`,
        `printf '\\n__OPTIO_CODEX_AUTH__AUTH=%s;DONE=%s;EXIT=%s\\n' "$AUTH" "$DONE" "$EXIT_CODE"`,
      ].join("\n"),
    ],
    { tty: false },
  );
  return parsePodProbe((await collectExecOutput(exec)).stdout);
}

async function waitForCodexDeviceAuth(handle: ContainerHandle) {
  const deadline = Date.now() + CODEX_DEVICE_CODE_WAIT_MS;
  let details = { loginUrl: null, userCode: null };
  while (Date.now() < deadline) {
    const probe = await probeAuthPod(handle);
    details = extractCodexDeviceAuth(probe.logOutput);
    if (details.userCode || probe.authDetected || probe.done) return details;
    await new Promise((resolve) => setTimeout(resolve, CODEX_DEVICE_CODE_POLL_MS));
  }
  return details;
}

async function readAndValidateAuthJson(handle: ContainerHandle, sourceLabel: string) {
  const exec = await getRuntime().exec(
    handle,
    [
      "bash",
      "-lc",
      [
        "set -euo pipefail",
        `test -s ${CODEX_AUTH_PATH} || { echo "Codex login has not completed yet." >&2; exit 44; }`,
        `cat ${CODEX_AUTH_PATH}`,
      ].join("\n"),
    ],
    { tty: false },
  );
  const result = await collectExecOutput(exec);
  if (!result.stdout.trim()) {
    throw new Error(result.stderr.trim() || `Failed to read Codex auth from ${sourceLabel}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${sourceLabel} produced an invalid Codex auth.json`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${sourceLabel} produced an invalid Codex auth.json`);
  }

  return JSON.stringify(parsed);
}

async function importCodexAuthFromPodAccount(account: NonNullable<CodexAuthAccount>) {
  const handle = resolveAuthPodHandle(account);
  if (!handle) {
    throw new Error("No Codex auth pod is registered");
  }

  const authJson = await readAndValidateAuthJson(handle, "Auth pod");
  const now = new Date();
  await storeSecret("CODEX_AUTH_JSON", authJson, "global");
  await cleanupAuthPod(account, {
    status: "connected",
    lastError: null,
    lastImportedAt: now,
    lastValidatedAt: now,
  });
}

async function resolveSessionPodHandle(sessionId: string, userId?: string) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.userId && userId && session.userId !== userId) throw new Error("Session not found");
  if (!session.podId) throw new Error("Session has no pod assigned");

  const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, session.podId));
  if (!pod?.podName) throw new Error("Session pod is no longer available");

  const handle: ContainerHandle = {
    id: pod.podId ?? pod.podName,
    name: pod.podName,
  };
  return { session, handle };
}

async function importCodexAuthFromLegacySessionAccount(
  account: NonNullable<CodexAuthAccount>,
  userId?: string,
  sessionId?: string,
) {
  const targetSessionId = sessionId ?? account.loginSessionId ?? undefined;
  if (!targetSessionId) {
    throw new Error("No Codex login session is registered");
  }

  const { handle } = await resolveSessionPodHandle(targetSessionId, userId);
  const authJson = await readAndValidateAuthJson(handle, "Session");
  const now = new Date();
  await storeSecret("CODEX_AUTH_JSON", authJson, "global");
  await clearLoginHandle(account.id, {
    status: "connected",
    lastError: null,
    lastImportedAt: now,
    lastValidatedAt: now,
  });
}

export async function upsertCodexAuthAccount(input: {
  workspaceId?: string | null;
  userId?: string | null;
  appServerUrl: string;
  authJson?: string;
}) {
  const existing = await getCodexAuthAccount(input.workspaceId);
  const now = new Date();
  const trimmedAuthJson = input.authJson?.trim();

  if (trimmedAuthJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedAuthJson);
    } catch {
      throw new Error("Codex auth JSON must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Codex auth JSON must be a JSON object");
    }
    await storeSecret("CODEX_AUTH_JSON", JSON.stringify(parsed), "global");
  }

  if (existing?.loginPodName) {
    await cleanupAuthPod(existing, {
      status: trimmedAuthJson ? "connected" : existing.status,
      lastError: null,
    });
  }

  const values = {
    workspaceId: input.workspaceId ?? null,
    name: "default",
    appServerUrl: input.appServerUrl,
    status: (trimmedAuthJson ? "connected" : (existing?.status ?? "pending")) as
      | "pending"
      | "connected"
      | "error",
    loginSessionId: null,
    loginSessionRepoUrl: null,
    loginPodId: null,
    loginPodName: null,
    loginExpiresAt: null,
    createdBy: input.userId ?? existing?.createdBy ?? null,
    lastImportedAt: trimmedAuthJson ? now : (existing?.lastImportedAt ?? null),
    lastValidatedAt: trimmedAuthJson ? now : (existing?.lastValidatedAt ?? null),
    lastError: null,
    updatedAt: now,
  };

  if (existing) {
    const [updated] = await db
      .update(codexAuthAccounts)
      .set(values)
      .where(eq(codexAuthAccounts.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db.insert(codexAuthAccounts).values(values).returning();
  return created;
}

export async function getCodexAppServerConfig(opts: {
  workspaceId?: string | null;
  userId?: string | null;
}) {
  // Codex login is deliberately shared across all repo pods, not scoped to
  // the workspace that happened to start a task.
  const account = await getCodexAuthAccount();
  const codexAuthJson = (await retrieveSecretWithFallback(
    "CODEX_AUTH_JSON",
    "global",
    opts.workspaceId,
    opts.userId,
  ).catch(() => null)) as string | null;
  const legacyUrl = (await retrieveSecretWithFallback(
    "CODEX_APP_SERVER_URL",
    "global",
    opts.workspaceId,
    opts.userId,
  ).catch(() => null)) as string | null;

  return {
    appServerUrl: account?.appServerUrl ?? legacyUrl ?? undefined,
    codexAuthJson: codexAuthJson ?? undefined,
    account,
  };
}

/**
 * Codex app-server writes its refreshed credentials to the standard Codex
 * home. Copy that state back to Optio's one shared credential after a run so
 * later pods never receive a rotated, stale refresh token.
 */
export async function syncCodexAuthFromRepoPod(input: {
  handle: ContainerHandle;
}): Promise<boolean> {
  const exec = await getRuntime().exec(
    input.handle,
    ["bash", "-lc", `test -s ${CODEX_AUTH_PATH} && cat ${CODEX_AUTH_PATH} || true`],
    { tty: false },
  );
  const result = await collectExecOutput(exec);
  if (!result.stdout.trim()) return false;

  const authJson = JSON.stringify(JSON.parse(result.stdout));
  await storeSecret("CODEX_AUTH_JSON", authJson, "global");
  return true;
}

export async function startCodexAuthSession(input: {
  workspaceId?: string | null;
  userId?: string;
  appServerUrl: string;
}) {
  const existing = await getCodexAuthAccount(input.workspaceId);
  if (existing?.loginPodName) {
    await cleanupAuthPod(existing, { status: "pending", lastError: null });
  }

  const handle = await getRuntime().create(buildCodexAuthPodSpec());
  const expiresAt = new Date(Date.now() + CODEX_AUTH_POD_TIMEOUT_MS);
  const values = {
    workspaceId: input.workspaceId ?? null,
    name: "default",
    appServerUrl: input.appServerUrl,
    status: "pending" as const,
    loginSessionId: null,
    loginSessionRepoUrl: null,
    loginPodId: handle.id,
    loginPodName: handle.name,
    loginExpiresAt: expiresAt,
    createdBy: input.userId ?? existing?.createdBy ?? null,
    lastError: null,
    updatedAt: new Date(),
  };

  let account: NonNullable<CodexAuthAccount> | null = null;
  try {
    if (existing) {
      [account] = await db
        .update(codexAuthAccounts)
        .set(values)
        .where(eq(codexAuthAccounts.id, existing.id))
        .returning();
    } else {
      [account] = await db.insert(codexAuthAccounts).values(values).returning();
    }
    await startCodexLoginInPod(handle);
    const deviceAuth = await waitForCodexDeviceAuth(handle);
    return { account, authPod: { name: handle.name }, deviceAuth };
  } catch (error) {
    await destroyHandle(handle);
    if (account?.id) {
      await clearLoginHandle(account.id, {
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
    } else if (existing) {
      await clearLoginHandle(existing.id, {
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

export async function cancelCodexAuthSession(input: { workspaceId?: string | null }) {
  const account = await getCodexAuthAccount(input.workspaceId);
  if (!account) return { canceled: false as const };
  if (account.loginPodName) {
    await cleanupAuthPod(account, { status: "pending", lastError: null });
  } else if (account.loginSessionId || account.loginSessionRepoUrl) {
    await clearLoginHandle(account.id, { status: "pending", lastError: null });
  }
  return { canceled: true as const };
}

export async function getCodexAuthLoginStatus(input: {
  workspaceId?: string | null;
  userId?: string;
}): Promise<{
  account: Awaited<ReturnType<typeof getCodexAuthAccount>> | null;
  login: CodexAuthLoginStatus;
}> {
  // The managed Codex login is shared by every pod, so Settings must report
  // the global account rather than a stale workspace-specific record.
  let account = await getCodexAuthAccount();
  const base = buildBaseLoginStatus(account);

  if (!account) {
    return {
      account: null,
      login: {
        ...base,
        state: "not_started",
        canImport: false,
        authDetected: false,
        loginUrl: null,
        userCode: null,
      },
    };
  }

  if (account.status === "connected") {
    return {
      account,
      login: {
        ...base,
        state: "connected",
        canImport: false,
        authDetected: true,
        loginUrl: null,
        userCode: null,
      },
    };
  }

  if (account.loginPodName) {
    const handle = resolveAuthPodHandle(account);
    if (!handle) {
      return {
        account,
        login: {
          ...base,
          state: "error",
          canImport: false,
          authDetected: false,
          loginUrl: null,
          userCode: null,
          lastError: "The managed Codex auth pod is missing its handle.",
        },
      };
    }

    if (account.loginExpiresAt && account.loginExpiresAt.getTime() <= Date.now()) {
      const message = "The managed Codex auth pod timed out before login completed.";
      await cleanupAuthPod(account, { status: "error", lastError: message });
      account = await getCodexAuthAccount(input.workspaceId);
      return {
        account,
        login: {
          ...buildBaseLoginStatus(account),
          state: "error",
          canImport: false,
          authDetected: false,
          loginUrl: null,
          userCode: null,
          lastError: message,
        },
      };
    }

    try {
      const podStatus = await getRuntime().status(handle);
      if (podStatus.state === "pending") {
        return {
          account,
          login: {
            ...base,
            state: "starting",
            canImport: false,
            authDetected: false,
            loginUrl: null,
            userCode: null,
          },
        };
      }
      if (podStatus.state !== "running") {
        const message =
          podStatus.reason ??
          `The managed Codex auth pod entered terminal state ${podStatus.state}.`;
        await cleanupAuthPod(account, { status: "error", lastError: message });
        account = await getCodexAuthAccount(input.workspaceId);
        return {
          account,
          login: {
            ...buildBaseLoginStatus(account),
            state: "error",
            canImport: false,
            authDetected: false,
            loginUrl: null,
            userCode: null,
            lastError: message,
          },
        };
      }

      const probe = await probeAuthPod(handle);
      const { loginUrl, userCode } = extractCodexDeviceAuth(probe.logOutput);

      if (probe.authDetected) {
        try {
          await importCodexAuthFromPodAccount(account);
          account = await getCodexAuthAccount(input.workspaceId);
          return {
            account,
            login: {
              ...buildBaseLoginStatus(account),
              state: "connected",
              canImport: false,
              authDetected: true,
              loginUrl: null,
              userCode: null,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await cleanupAuthPod(account, { status: "error", lastError: message });
          account = await getCodexAuthAccount(input.workspaceId);
          return {
            account,
            login: {
              ...buildBaseLoginStatus(account),
              state: "error",
              canImport: false,
              authDetected: false,
              loginUrl,
              userCode,
              lastError: message,
            },
          };
        }
      }

      if (probe.done) {
        const message =
          probe.exitCode && probe.exitCode !== "0"
            ? `Codex login exited with status ${probe.exitCode} before auth.json was created.`
            : "Codex login ended without producing auth.json.";
        await cleanupAuthPod(account, { status: "error", lastError: message });
        account = await getCodexAuthAccount(input.workspaceId);
        return {
          account,
          login: {
            ...buildBaseLoginStatus(account),
            state: "error",
            canImport: false,
            authDetected: false,
            loginUrl,
            userCode,
            lastError: message,
          },
        };
      }

      return {
        account,
        login: {
          ...base,
          state: probe.logOutput.trim() ? "waiting_for_login" : "starting",
          canImport: false,
          authDetected: false,
          loginUrl,
          userCode,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await cleanupAuthPod(account, { status: "error", lastError: message });
      account = await getCodexAuthAccount(input.workspaceId);
      return {
        account,
        login: {
          ...buildBaseLoginStatus(account),
          state: "error",
          canImport: false,
          authDetected: false,
          loginUrl: null,
          userCode: null,
          lastError: message,
        },
      };
    }
  }

  if (account.loginSessionId) {
    try {
      const { session, handle } = await resolveSessionPodHandle(
        account.loginSessionId,
        input.userId,
      );
      if (session.state !== "active") {
        return {
          account,
          login: {
            ...base,
            state: "error",
            canImport: false,
            authDetected: false,
            loginUrl: null,
            userCode: null,
            lastError: "The managed Codex login session has ended.",
          },
        };
      }
      const exec = await getRuntime().exec(
        handle,
        [
          "bash",
          "-lc",
          `test -f ${CODEX_AUTH_PATH} && AUTH=1 || AUTH=0; tail -c 12000 ${CODEX_LOGIN_LOG_PATH} 2>/dev/null || true; printf '\\n__OPTIO_AUTH_EXISTS__%s\\n' "$AUTH"`,
        ],
        { tty: false },
      );
      const result = await collectExecOutput(exec);
      const marker = "__OPTIO_AUTH_EXISTS__";
      const [logOutput, authMarker = "0"] = result.stdout.split(marker);
      const authDetected = authMarker.trim() === "1";
      const { loginUrl, userCode } = extractCodexDeviceAuth(logOutput);
      if (authDetected) {
        await importCodexAuthFromLegacySessionAccount(account, input.userId);
        account = await getCodexAuthAccount(input.workspaceId);
        return {
          account,
          login: {
            ...buildBaseLoginStatus(account),
            state: "connected",
            canImport: false,
            authDetected: true,
            loginUrl: null,
            userCode: null,
          },
        };
      }
      return {
        account,
        login: {
          ...base,
          state: logOutput.trim() ? "waiting_for_login" : "starting",
          canImport: false,
          authDetected: false,
          loginUrl,
          userCode,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        account,
        login: {
          ...base,
          state: "error",
          canImport: false,
          authDetected: false,
          loginUrl: null,
          userCode: null,
          lastError: message,
        },
      };
    }
  }

  return {
    account,
    login: {
      ...base,
      state: account.lastError ? "error" : "not_started",
      canImport: false,
      authDetected: false,
      loginUrl: null,
      userCode: null,
    },
  };
}

export async function importCodexAuthFromSession(input: {
  workspaceId?: string | null;
  userId?: string;
  sessionId?: string;
}) {
  const account = await getCodexAuthAccount(input.workspaceId);
  if (!account) {
    throw new Error("No managed Codex account exists");
  }

  if (account.loginPodName) {
    await importCodexAuthFromPodAccount(account);
    return;
  }

  await importCodexAuthFromLegacySessionAccount(account, input.userId, input.sessionId);
}
