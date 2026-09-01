import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { codexAuthAccounts, repoPods } from "../db/schema.js";
import { createSession, getSession } from "./interactive-session-service.js";
import { getRuntime } from "./container-service.js";
import { deleteSecret, retrieveSecretWithFallback, storeSecret } from "./secret-service.js";
import type { ContainerHandle, ExecSession } from "@optio/shared";

const CODEX_AUTH_PATH = "/home/agent/.codex/auth.json";
const CODEX_LOGIN_LOG_PATH = "/tmp/optio-codex-login.log";
const CODEX_TASK_HOME_ROOT = "/home/agent/.optio-codex";
const CODEX_AUTH_LEASE_TTL_MS = 60 * 60 * 1000;
const CODEX_AUTH_LEASE_WAIT_MS = 2 * 60 * 1000;

function buildSessionWorktreeSetupScript(session: { worktreePath: string | null; branch: string }) {
  const worktreePath = session.worktreePath ?? "/workspace/repo";
  const branch = session.branch;

  return [
    "set -euo pipefail",
    "for i in $(seq 1 60); do [ -f /workspace/.ready ] && break; sleep 1; done",
    '[ -f /workspace/.ready ] || { echo "Repo not ready" >&2; exit 1; }',
    "exec 9>/workspace/.repo-lock",
    "flock 9",
    "cd /workspace/repo",
    "git fetch origin 2>/dev/null || true",
    `if [ ! -d ${JSON.stringify(worktreePath)} ]; then`,
    `  git branch -D ${JSON.stringify(branch)} 2>/dev/null || true`,
    `  git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)} origin/$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main) 2>/dev/null || git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)} HEAD`,
    "fi",
    "flock -u 9",
    "exec 9>&-",
  ].join("\n");
}

function buildCodexLoginRunnerScript(worktreePath: string) {
  return [
    "set -euo pipefail",
    `cd ${JSON.stringify(worktreePath)}`,
    'export CODEX_HOME="/home/agent/.codex"',
    'mkdir -p "$CODEX_HOME"',
    'printf \'cli_auth_credentials_store = "file"\\n\' > "$CODEX_HOME/config.toml"',
    'chmod 700 "$CODEX_HOME"',
    'chmod 600 "$CODEX_HOME/config.toml"',
    'rm -f "$CODEX_HOME/auth.json"',
    `rm -f ${JSON.stringify(CODEX_LOGIN_LOG_PATH)}`,
    `printf 'Optio managed Codex login\\nStarting device-auth flow.\\nUse the verification URL and device code below.\\n\\n' | tee -a ${JSON.stringify(CODEX_LOGIN_LOG_PATH)}`,
    `codex login --device-auth 2>&1 | tee -a ${JSON.stringify(CODEX_LOGIN_LOG_PATH)}`,
  ].join("\n");
}

async function startCodexLoginInSession(sessionId: string, userId?: string) {
  const { session, handle } = await resolveSessionPodHandle(sessionId, userId);
  const worktreePath = session.worktreePath ?? "/workspace/repo";
  const runnerScript = buildCodexLoginRunnerScript(worktreePath);
  const launchScript = [
    buildSessionWorktreeSetupScript(session),
    "cat > /tmp/optio-start-codex-login.sh <<'EOF'",
    runnerScript,
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

export interface CodexAuthLease {
  workspaceId: string | null;
  owner: string;
}

function codexAuthAccountCondition(workspaceId?: string | null) {
  return and(eq(codexAuthAccounts.name, "default"), workspaceCondition(workspaceId));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeCodexAuthAtPath(input: {
  handle: ContainerHandle;
  authPath: string;
}): Promise<{ valid: boolean; error: string | null }> {
  const exec = await getRuntime().exec(
    input.handle,
    [
      "bash",
      "-lc",
      [
        "set -euo pipefail",
        `export AUTH_PATH=${JSON.stringify(input.authPath)}`,
        "PORT=$(python3 <<'PY'\nimport socket\nsock = socket.socket()\nsock.bind(('127.0.0.1', 0))\nprint(sock.getsockname()[1])\nsock.close()\nPY\n)",
        "TMPDIR=$(mktemp -d)",
        "export APP_STDERR=$(mktemp)",
        "APP_PID=",
        "cleanup() {",
        '  if [ -n "$APP_PID" ]; then kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; fi',
        '  rm -rf "$TMPDIR" "$APP_STDERR" /tmp/optio-codex-auth-probe.js /tmp/optio-codex-auth-probe.json',
        "}",
        "trap cleanup EXIT",
        'test -s "$AUTH_PATH" || { echo \'{"valid":false,"error":"Codex auth.json is missing"}\'; exit 0; }',
        'cp "$AUTH_PATH" "$TMPDIR/auth.json"',
        'printf \'cli_auth_credentials_store = "file"\\n\' > "$TMPDIR/config.toml"',
        'chmod 700 "$TMPDIR"',
        'chmod 600 "$TMPDIR/auth.json" "$TMPDIR/config.toml"',
        'CODEX_HOME="$TMPDIR" codex app-server --listen "ws://127.0.0.1:$PORT" >/dev/null 2>"$APP_STDERR" &',
        "APP_PID=$!",
        'for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null && break; sleep 1; done',
        "cat > /tmp/optio-codex-auth-probe.js <<'JS'",
        "const port = process.env.PORT;",
        "const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/connect`);",
        "let done = false;",
        "const finish = (payload) => {",
        "  if (done) return;",
        "  done = true;",
        "  process.stdout.write(JSON.stringify(payload));",
        "  process.exit(0);",
        "};",
        "ws.addEventListener('open', () => {",
        "  ws.send(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'initialize', params: { clientInfo: { name: 'optio-auth-probe', version: '1' }, capabilities: {} } }) + '\\n');",
        "});",
        "ws.addEventListener('message', (event) => {",
        "  for (const line of String(event.data).split('\\n')) {",
        "    if (!line.trim()) continue;",
        "    const message = JSON.parse(line);",
        "    if (message.id === '1') {",
        "      ws.send(JSON.stringify({ jsonrpc: '2.0', id: '2', method: 'account/read', params: { refreshToken: true } }) + '\\n');",
        "      continue;",
        "    }",
        "    if (message.id === '2') {",
        "      finish({ account: message.result?.account ?? null, rpcError: message.error ?? null });",
        "      return;",
        "    }",
        "  }",
        "});",
        "ws.addEventListener('error', (event) => finish({ account: null, rpcError: event.error?.message ?? 'websocket_error' }));",
        "setTimeout(() => finish({ account: null, rpcError: 'timeout' }), 5000);",
        "JS",
        'PORT="$PORT" node /tmp/optio-codex-auth-probe.js > /tmp/optio-codex-auth-probe.json',
        "python3 <<'PY'",
        "import json, os",
        "payload = json.load(open('/tmp/optio-codex-auth-probe.json', 'r', encoding='utf-8'))",
        "stderr_text = ''",
        "stderr_path = os.environ.get('APP_STDERR')",
        "if stderr_path and os.path.exists(stderr_path):",
        "    stderr_text = open(stderr_path, 'r', encoding='utf-8', errors='replace').read()[-4000:]",
        "error = None",
        "if payload.get('account'):",
        "    print(json.dumps({'valid': True, 'error': None}))",
        "else:",
        "    rpc_error = payload.get('rpcError')",
        "    if isinstance(rpc_error, dict):",
        "        error = rpc_error.get('message') or json.dumps(rpc_error)",
        "    elif rpc_error:",
        "        error = str(rpc_error)",
        "    if not error and 'refresh_token_reused' in stderr_text:",
        "        error = 'refresh_token_reused'",
        "    if not error and '401 Unauthorized' in stderr_text:",
        "        error = '401 Unauthorized during Codex auth refresh'",
        "    if not error and stderr_text.strip():",
        "        error = stderr_text.strip().splitlines()[-1]",
        "    if not error:",
        "        error = 'Codex app-server could not load the provided auth.json'",
        "    print(json.dumps({'valid': False, 'error': error}))",
        "PY",
      ].join("\n"),
    ],
    { tty: false },
  );

  const result = await collectExecOutput(exec);
  if (!result.stdout.trim()) {
    throw new Error(result.stderr.trim() || "Failed to validate Codex auth in pod");
  }
  const payload = JSON.parse(result.stdout) as { valid?: boolean; error?: string | null };
  return {
    valid: payload.valid === true,
    error: payload.error ?? null,
  };
}

export function getCodexTaskHome(taskId: string) {
  return `${CODEX_TASK_HOME_ROOT}/${taskId}`;
}

export function getCodexTaskAuthPath(taskId: string) {
  return `${getCodexTaskHome(taskId)}/auth.json`;
}

export async function acquireCodexAuthLease(input: {
  workspaceId?: string | null;
  owner: string;
  waitMs?: number;
  leaseMs?: number;
}): Promise<CodexAuthLease> {
  const account = await getCodexAuthAccount(input.workspaceId);
  if (!account) {
    throw new Error("Codex app-server mode is not configured for this workspace");
  }

  const waitMs = input.waitMs ?? CODEX_AUTH_LEASE_WAIT_MS;
  const leaseMs = input.leaseMs ?? CODEX_AUTH_LEASE_TTL_MS;
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs);
    const claimed = await db
      .update(codexAuthAccounts)
      .set({
        leaseOwner: input.owner,
        leaseExpiresAt: expiresAt,
        updatedAt: now,
      })
      .where(
        and(
          codexAuthAccountCondition(input.workspaceId),
          or(
            isNull(codexAuthAccounts.leaseExpiresAt),
            lte(codexAuthAccounts.leaseExpiresAt, now),
            eq(codexAuthAccounts.leaseOwner, input.owner),
          )!,
        ),
      )
      .returning({ id: codexAuthAccounts.id });

    if (claimed.length > 0) {
      return { workspaceId: input.workspaceId ?? null, owner: input.owner };
    }

    await sleep(1000);
  }

  throw new Error("Timed out waiting for exclusive Codex auth access");
}

export async function releaseCodexAuthLease(lease: CodexAuthLease): Promise<void> {
  await db
    .update(codexAuthAccounts)
    .set({
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        codexAuthAccountCondition(lease.workspaceId),
        eq(codexAuthAccounts.leaseOwner, lease.owner),
      ),
    );
}

export async function noteCodexAuthFailure(input: {
  workspaceId?: string | null;
  message: string;
  clearStoredAuth?: boolean;
}) {
  if (input.clearStoredAuth) {
    await deleteSecret("CODEX_AUTH_JSON", "global").catch(() => {});
  }
  await db
    .update(codexAuthAccounts)
    .set({
      status: "error",
      lastError: input.message,
      updatedAt: new Date(),
    })
    .where(codexAuthAccountCondition(input.workspaceId));
}

export async function resetCodexAuthAccount(input: {
  workspaceId?: string | null;
  preserveAppServerUrl?: boolean;
}) {
  await deleteSecret("CODEX_AUTH_JSON", "global").catch(() => {});

  const existing = await getCodexAuthAccount(input.workspaceId);
  if (!existing) return null;

  const now = new Date();
  const [updated] = await db
    .update(codexAuthAccounts)
    .set({
      status: "pending",
      loginSessionId: null,
      loginSessionRepoUrl: null,
      lastImportedAt: null,
      lastValidatedAt: null,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      appServerUrl: input.preserveAppServerUrl === false ? "" : existing.appServerUrl,
      updatedAt: now,
    })
    .where(eq(codexAuthAccounts.id, existing.id))
    .returning();

  return updated ?? null;
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
      return [
        "Codex login completed in the managed session.",
        "Import will finalize the shared login in Optio.",
      ];
    case "waiting_for_login":
      return loginUrl
        ? [
            "Complete the Codex device flow from Settings or Setup.",
            "Use the device verification page below if the terminal already printed it.",
            "Optio will import the login automatically once auth.json appears.",
          ]
        : [
            "Wait here for Optio to detect the device verification page and code.",
            "If detection stalls, open the raw managed session as a fallback.",
            "Optio will import the login automatically once auth.json appears.",
          ];
    case "starting":
      return [
        "The managed login session is starting.",
        "Stay on this page while Optio waits for the device flow to initialize.",
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

function isLoopbackLoginUrl(url: string) {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return false;

    const normalizedHost = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      normalizedHost === "localhost" ||
      normalizedHost === "::1" ||
      normalizedHost === "0.0.0.0" ||
      normalizedHost.startsWith("127.")
    );
  } catch {
    return false;
  }
}

export function extractLoginDetails(logOutput: string) {
  const sanitized = logOutput.replace(/\u001b\[[0-9;]*m/g, "");
  const trimmed = sanitized.trim();
  const urls = Array.from(trimmed.matchAll(/https?:\/\/[^\s)<>"']+/g), (match) => match[0]);
  const uniqueUrls = Array.from(new Set(urls));
  const safeUrls = uniqueUrls.filter((url) => !isLoopbackLoginUrl(url));
  const userCodeMatch =
    trimmed.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/) ??
    trimmed.match(
      /(?:^|\b)(?:enter|use|device)\s+code[^A-Z0-9]*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/m,
    );
  const loginUrl =
    safeUrls.find((url) => /auth|login|device|openai|chatgpt/i.test(url)) ?? safeUrls[0] ?? null;

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
  await deleteSecret("CODEX_AUTH_JSON", "global").catch(() => {});

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

    if (authDetected) {
      try {
        await importCodexAuthFromSession({
          workspaceId: input.workspaceId,
          userId: input.userId,
          sessionId,
        });

        const connectedAccount = await getCodexAuthAccount(input.workspaceId);
        return {
          account: connectedAccount,
          login: {
            state: "connected",
            canImport: false,
            authDetected: true,
            instructions: buildInstructions("connected", null),
            sessionId,
            repoUrl,
            loginUrl: loginDetails.loginUrl,
            userCode: loginDetails.userCode,
            lastError: null,
            logExcerpt: loginDetails.logExcerpt,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          account,
          login: {
            state: "ready_to_import",
            canImport: true,
            authDetected: true,
            instructions: buildInstructions("ready_to_import", loginDetails.loginUrl),
            sessionId,
            repoUrl,
            loginUrl: loginDetails.loginUrl,
            userCode: loginDetails.userCode,
            lastError: message,
            logExcerpt: loginDetails.logExcerpt,
          },
        };
      }
    }

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
    const state = /no pod assigned|pod is no longer available/i.test(message)
      ? "starting"
      : "error";

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
  const probe = await probeCodexAuthAtPath({ handle, authPath: CODEX_AUTH_PATH });
  if (!probe.valid) {
    await noteCodexAuthFailure({
      workspaceId: input.workspaceId,
      message: probe.error ?? "Codex session auth validation failed",
    }).catch(() => {});
    throw new Error(
      `Managed Codex login is not usable yet: ${probe.error ?? "auth validation failed"}`,
    );
  }
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

export async function syncCodexAuthFromRepoPod(input: {
  handle: ContainerHandle;
  taskId: string;
  workspaceId?: string | null;
}) {
  const authPath = getCodexTaskAuthPath(input.taskId);
  const exec = await getRuntime().exec(
    input.handle,
    [
      "bash",
      "-lc",
      [
        "set -euo pipefail",
        `export AUTH_PATH=${JSON.stringify(authPath)}`,
        "python3 <<'PY'",
        "import json, os",
        "auth_path = os.environ['AUTH_PATH']",
        "if not os.path.exists(auth_path) or os.path.getsize(auth_path) <= 0:",
        "    print(json.dumps({'exists': False}))",
        "else:",
        "    with open(auth_path, 'r', encoding='utf-8', errors='strict') as fh:",
        "        print(json.dumps({'exists': True, 'auth': fh.read()}))",
        "PY",
      ].join("\n"),
    ],
    { tty: false },
  );

  const result = await collectExecOutput(exec);
  if (!result.stdout.trim()) {
    throw new Error(result.stderr.trim() || "Failed to inspect Codex auth in repo pod");
  }

  const payload = JSON.parse(result.stdout) as { exists?: boolean; auth?: string };
  if (!payload.exists || !payload.auth?.trim()) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.auth);
  } catch {
    throw new Error("Repo pod produced an invalid Codex auth.json");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Repo pod produced an invalid Codex auth.json");
  }

  await storeSecret("CODEX_AUTH_JSON", JSON.stringify(parsed), "global");
  await db
    .update(codexAuthAccounts)
    .set({
      status: "connected",
      lastImportedAt: new Date(),
      lastValidatedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(codexAuthAccountCondition(input.workspaceId));

  return true;
}
