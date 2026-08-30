import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { codexAuthAccounts, repoPods } from "../db/schema.js";
import { createSession, getSession } from "./interactive-session-service.js";
import { getRuntime } from "./container-service.js";
import { retrieveSecretWithFallback, storeSecret } from "./secret-service.js";
import type { ContainerHandle, ExecSession } from "@optio/shared";

const CODEX_AUTH_PATH = "/home/agent/.codex/auth.json";
const CODEX_LOGIN_LOG_PATH = "/tmp/optio-codex-login.log";

function workspaceCondition(workspaceId?: string | null) {
  return workspaceId ? eq(codexAuthAccounts.workspaceId, workspaceId) : isNull(codexAuthAccounts.workspaceId);
}

async function collectExecOutput(session: ExecSession): Promise<{ stdout: string; stderr: string }> {
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
  instructions: string[];
  sessionId: string | null;
  repoUrl: string | null;
  loginUrl: string | null;
  userCode: string | null;
  lastError: string | null;
  logExcerpt: string | null;
}

type CodexAuthAccountRecord = NonNullable<Awaited<ReturnType<typeof getCodexAuthAccount>>>;

function buildInstructions(state: CodexAuthLoginStatus["state"], loginUrl: string | null) {
  switch (state) {
    case "connected":
      return ["Codex auth is connected and ready for future repo pods."];
    case "ready_to_import":
      return ["Codex login completed in the managed session.", "Import will finalize the shared login in Optio."];
    case "waiting_for_login":
      return loginUrl
        ? [
            "Open the managed login session tab and complete the Codex device flow.",
            "Use the detected login URL below if the terminal already printed it.",
            "Optio will import the login automatically once auth.json appears.",
          ]
        : [
            "Open the managed login session tab and complete `codex login` there.",
            "Wait for the terminal to finish the browser/device flow.",
            "Optio will import the login automatically once auth.json appears.",
          ];
    case "starting":
      return [
        "The managed login session is starting.",
        "Open or reopen the session tab and wait for the Codex login prompt to appear.",
      ];
    case "error":
      return [
        "The managed login session hit an error before Optio could import auth.",
        "Review the error below, then restart or reopen the login session.",
      ];
    case "not_started":
    default:
      return [
        "Start a managed Codex login session to authenticate through the shared pod home.",
        "Optio will guide the flow here and import the shared auth when it is ready.",
      ];
  }
}

function extractLoginDetails(logOutput: string) {
  const trimmed = logOutput.trim();
  const urls = Array.from(trimmed.matchAll(/https?:\/\/[^\s)<>"']+/g), (match) => match[0]);
  const uniqueUrls = Array.from(new Set(urls));
  const userCodeMatch =
    trimmed.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/) ??
    trimmed.match(/(?:code|enter code)[^A-Z0-9]*([A-Z0-9-]{4,})/i);
  const loginUrl =
    uniqueUrls.find((url) => /auth|login|device|openai|chatgpt/i.test(url)) ?? uniqueUrls[0] ?? null;

  return {
    loginUrl,
    userCode: userCodeMatch ? userCodeMatch[userCodeMatch.length - 1] : null,
    logExcerpt: trimmed ? trimmed.slice(-4000) : null,
  };
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
  const codexAuthJson = (
    await retrieveSecretWithFallback("CODEX_AUTH_JSON", "global", opts.workspaceId, opts.userId).catch(
      () => null,
    )
  ) as string | null;
  const legacyUrl = (
    await retrieveSecretWithFallback("CODEX_APP_SERVER_URL", "global", opts.workspaceId, opts.userId).catch(
      () => null,
    )
  ) as string | null;

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
    return { account: updated, session };
  }

  const [created] = await db.insert(codexAuthAccounts).values(values).returning();
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
}): Promise<{ account: CodexAuthAccountRecord | null; login: CodexAuthLoginStatus }> {
  const account = await getCodexAuthAccount(input.workspaceId);
  const sessionId = account?.loginSessionId ?? null;
  const repoUrl = account?.loginSessionRepoUrl ?? null;

  if (!account) {
    return {
      account: null,
      login: {
        state: "not_started",
        canImport: false,
        authDetected: false,
        instructions: buildInstructions("not_started", null),
        sessionId: null,
        repoUrl: null,
        loginUrl: null,
        userCode: null,
        lastError: null,
        logExcerpt: null,
      },
    };
  }

  if (account.status === "connected") {
    return {
      account,
      login: {
        state: "connected",
        canImport: false,
        authDetected: true,
        instructions: buildInstructions("connected", null),
        sessionId,
        repoUrl,
        loginUrl: null,
        userCode: null,
        lastError: null,
        logExcerpt: null,
      },
    };
  }

  if (!sessionId) {
    const state = account.lastError ? "error" : "not_started";
    return {
      account,
      login: {
        state,
        canImport: false,
        authDetected: false,
        instructions: buildInstructions(state, null),
        sessionId: null,
        repoUrl,
        loginUrl: null,
        userCode: null,
        lastError: account.lastError ?? null,
        logExcerpt: null,
      },
    };
  }

  try {
    const { session, handle } = await resolveSessionPodHandle(sessionId, input.userId);

    if (session.state !== "active") {
      return {
        account,
        login: {
          state: "error",
          canImport: false,
          authDetected: false,
          instructions: buildInstructions("error", null),
          sessionId,
          repoUrl,
          loginUrl: null,
          userCode: null,
          lastError: "The managed Codex login session has already ended.",
          logExcerpt: null,
        },
      };
    }

    const exec = await getRuntime().exec(
      handle,
      [
        "bash",
        "-lc",
        [
          "set -euo pipefail",
          `export AUTH_PATH=${JSON.stringify(CODEX_AUTH_PATH)}`,
          `export LOG_PATH=${JSON.stringify(CODEX_LOGIN_LOG_PATH)}`,
          "python3 <<'PY'",
          "import json, os",
          "auth_path = os.environ['AUTH_PATH']",
          "log_path = os.environ['LOG_PATH']",
          "auth_exists = os.path.exists(auth_path)",
          "auth_non_empty = auth_exists and os.path.getsize(auth_path) > 0",
          "log_text = ''",
          "if os.path.exists(log_path):",
          "    with open(log_path, 'r', encoding='utf-8', errors='replace') as fh:",
          "        log_text = fh.read()[-12000:]",
          "print(json.dumps({",
          "    'authExists': auth_exists,",
          "    'authNonEmpty': auth_non_empty,",
          "    'logText': log_text,",
          "}))",
          "PY",
        ].join("\n"),
      ],
      { tty: false },
    );

    const result = await collectExecOutput(exec);
    if (!result.stdout.trim()) {
      throw new Error(result.stderr.trim() || "Failed to inspect Codex login status");
    }

    const parsed = JSON.parse(result.stdout) as {
      authExists?: boolean;
      authNonEmpty?: boolean;
      logText?: string;
    };
    const loginDetails = extractLoginDetails(parsed.logText ?? "");
    const authDetected = Boolean(parsed.authExists && parsed.authNonEmpty);
    const state: CodexAuthLoginStatus["state"] = authDetected
      ? "ready_to_import"
      : loginDetails.logExcerpt
        ? "waiting_for_login"
        : "starting";

    return {
      account,
      login: {
        state,
        canImport: authDetected,
        authDetected,
        instructions: buildInstructions(state, loginDetails.loginUrl),
        sessionId,
        repoUrl,
        loginUrl: loginDetails.loginUrl,
        userCode: loginDetails.userCode,
        lastError: account.lastError ?? null,
        logExcerpt: loginDetails.logExcerpt,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = /no pod assigned|pod is no longer available/i.test(message) ? "starting" : "error";

    return {
      account,
      login: {
        state,
        canImport: false,
        authDetected: false,
        instructions: buildInstructions(state, null),
        sessionId,
        repoUrl,
        loginUrl: null,
        userCode: null,
        lastError: message,
        logExcerpt: null,
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
        `test -s ${CODEX_AUTH_PATH} || { echo "Codex login has not completed in this session yet. Keep the managed login session open until the browser/device flow finishes." >&2; exit 44; }`,
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
