import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { codexAuthAccounts, repoPods } from "../db/schema.js";
import { createSession, getSession } from "./interactive-session-service.js";
import { getRuntime } from "./container-service.js";
import { retrieveSecretWithFallback, storeSecret } from "./secret-service.js";
import type { ContainerHandle, ExecSession } from "@optio/shared";

const CODEX_AUTH_PATH = "/home/agent/.codex/auth.json";
const CODEX_LOGIN_LOG_PATH = "/tmp/optio-codex-login.log";

function buildCodexLoginScript() {
  return [
    "set -euo pipefail",
    'export CODEX_HOME="/home/agent/.codex"',
    'mkdir -p "$CODEX_HOME"',
    'printf \'cli_auth_credentials_store = "file"\\n\' > "$CODEX_HOME/config.toml"',
    'chmod 700 "$CODEX_HOME"',
    'chmod 600 "$CODEX_HOME/config.toml"',
    `rm -f ${JSON.stringify(CODEX_LOGIN_LOG_PATH)}`,
    `codex login --device-auth 2>&1 | tee ${JSON.stringify(CODEX_LOGIN_LOG_PATH)}`,
  ].join("\n");
}

async function startCodexLoginInSession(sessionId: string, userId?: string) {
  const { handle } = await resolveSessionPodHandle(sessionId, userId);
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
  loginUrl: string | null;
  userCode: string | null;
  lastError: string | null;
}

function workspaceCondition(workspaceId?: string | null) {
  return workspaceId
    ? eq(codexAuthAccounts.workspaceId, workspaceId)
    : isNull(codexAuthAccounts.workspaceId);
}

async function collectExecOutput(
  session: ExecSession,
): Promise<{ stdout: string; stderr: string }> {
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

export async function getCodexAuthAccount(workspaceId?: string | null) {
  const [account] = await db
    .select()
    .from(codexAuthAccounts)
    .where(and(eq(codexAuthAccounts.name, "default"), workspaceCondition(workspaceId)));
  return account ?? null;
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

  const values = {
    workspaceId: input.workspaceId ?? null,
    name: "default",
    appServerUrl: input.appServerUrl,
    status: (trimmedAuthJson ? "connected" : (existing?.status ?? "pending")) as
      | "pending"
      | "connected"
      | "error",
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
  const account = await getCodexAuthAccount(opts.workspaceId);
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

export async function startCodexAuthSession(input: {
  workspaceId?: string | null;
  userId?: string;
  repoUrl: string;
  appServerUrl: string;
}) {
  const session = await createSession({
    repoUrl: input.repoUrl,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });

  const existing = await getCodexAuthAccount(input.workspaceId);
  const values = {
    workspaceId: input.workspaceId ?? null,
    name: "default",
    appServerUrl: input.appServerUrl,
    status: "pending" as const,
    loginSessionId: session.id,
    loginSessionRepoUrl: input.repoUrl,
    createdBy: input.userId ?? null,
    lastError: null,
    updatedAt: new Date(),
  };

  if (existing) {
    const [updated] = await db
      .update(codexAuthAccounts)
      .set(values)
      .where(eq(codexAuthAccounts.id, existing.id))
      .returning();
    await startCodexLoginInSession(session.id, input.userId);
    return { account: updated, session };
  }

  const [created] = await db.insert(codexAuthAccounts).values(values).returning();
  await startCodexLoginInSession(session.id, input.userId);
  return { account: created, session };
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

export async function getCodexAuthLoginStatus(input: {
  workspaceId?: string | null;
  userId?: string;
}): Promise<{
  account: Awaited<ReturnType<typeof getCodexAuthAccount>> | null;
  login: CodexAuthLoginStatus;
}> {
  const account = await getCodexAuthAccount(input.workspaceId);
  const sessionId = account?.loginSessionId ?? null;
  const repoUrl = account?.loginSessionRepoUrl ?? null;
  const base = {
    sessionId,
    repoUrl,
    loginUrl: null,
    userCode: null,
    lastError: account?.lastError ?? null,
  };
  if (!account)
    return {
      account: null,
      login: { ...base, state: "not_started", canImport: false, authDetected: false },
    };
  if (account.status === "connected")
    return {
      account,
      login: { ...base, state: "connected", canImport: false, authDetected: true },
    };
  if (!sessionId)
    return {
      account,
      login: {
        ...base,
        state: account.lastError ? "error" : "not_started",
        canImport: false,
        authDetected: false,
      },
    };
  try {
    const { session, handle } = await resolveSessionPodHandle(sessionId, input.userId);
    if (session.state !== "active") {
      return {
        account,
        login: {
          ...base,
          state: "error",
          canImport: false,
          authDetected: false,
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
    return {
      account,
      login: {
        ...base,
        state: authDetected
          ? "ready_to_import"
          : logOutput.trim()
            ? "waiting_for_login"
            : "starting",
        canImport: authDetected,
        authDetected,
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
        state: "starting",
        canImport: false,
        authDetected: false,
        lastError: message,
      },
    };
  }
}

export async function importCodexAuthFromSession(input: {
  workspaceId?: string | null;
  userId?: string;
  sessionId?: string;
}) {
  const account = await getCodexAuthAccount(input.workspaceId);
  const sessionId = input.sessionId ?? account?.loginSessionId ?? undefined;
  if (!sessionId) {
    throw new Error("No Codex login session is registered");
  }

  const { handle } = await resolveSessionPodHandle(sessionId, input.userId);
  const exec = await getRuntime().exec(
    handle,
    [
      "bash",
      "-lc",
      [
        "set -euo pipefail",
        `test -s ${CODEX_AUTH_PATH} || { echo "Codex login has not completed in this session yet." >&2; exit 44; }`,
        `cat ${CODEX_AUTH_PATH}`,
      ].join("\n"),
    ],
    { tty: false },
  );

  const result = await collectExecOutput(exec);
  if (!result.stdout.trim()) {
    throw new Error(result.stderr.trim() || "Failed to read Codex auth from session");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Session produced an invalid Codex auth.json");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Session produced an invalid Codex auth.json");
  }

  await storeSecret("CODEX_AUTH_JSON", JSON.stringify(parsed), "global");

  if (account) {
    await db
      .update(codexAuthAccounts)
      .set({
        status: "connected",
        lastImportedAt: new Date(),
        lastValidatedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(codexAuthAccounts.id, account.id));
  }
}
