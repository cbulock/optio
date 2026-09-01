"use client";

import { use, useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import Link from "next/link";
import { cn, formatRelativeTime, formatDuration } from "@/lib/utils";
import {
  ArrowLeft,
  Terminal,
  Loader2,
  FolderGit2,
  StopCircle,
  GitPullRequest,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  DollarSign,
  ChevronDown,
  Bot,
} from "lucide-react";
import dynamic from "next/dynamic";

const SessionTerminal = dynamic(
  () => import("@/components/session-terminal").then((m) => m.SessionTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="h-full bg-[#09090b] flex items-center justify-center text-text-muted text-sm">
        Loading terminal...
      </div>
    ),
  },
);
import { SessionChat } from "@/components/session-chat";
import { SplitPane } from "@/components/split-pane";
import { ErrorBoundary } from "@/components/error-boundary";

interface CodexLoginStatusResponse {
  account: {
    id: string;
    status: string;
    appServerUrl: string;
    loginSessionId: string | null;
    loginSessionRepoUrl: string | null;
    lastImportedAt: string | null;
    lastValidatedAt: string | null;
    lastError: string | null;
  } | null;
  login: {
    state: string;
    canImport: boolean;
    authDetected: boolean;
    instructions: string[];
    sessionId: string | null;
    repoUrl: string | null;
    loginUrl: string | null;
    userCode: string | null;
    lastError: string | null;
    logExcerpt: string | null;
  };
}

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const [session, setSession] = useState<any>(null);
  const [modelConfig, setModelConfig] = useState<{
    claudeModel: string;
    availableModels: string[];
  } | null>(null);
  const [prs, setPrs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [showEndWarning, setShowEndWarning] = useState(false);
  const [liveCost, setLiveCost] = useState<number>(0);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [codexAuthStatus, setCodexAuthStatus] = useState<CodexLoginStatusResponse | null>(null);
  const [codexAuthStatusLoading, setCodexAuthStatusLoading] = useState(false);
  const [codexImportLoading, setCodexImportLoading] = useState(false);
  const codexAutoImportAttemptedRef = useRef<string | null>(null);

  // Ref for "send to agent" handler
  const sendToAgentRef = useRef<((text: string) => void) | null>(null);

  const fetchSession = async () => {
    try {
      const [sessionRes, prsRes] = await Promise.all([api.getSession(id), api.getSessionPrs(id)]);
      setSession(sessionRes.session);
      if ((sessionRes as any).modelConfig) {
        setModelConfig((sessionRes as any).modelConfig);
        if (!selectedModel) {
          setSelectedModel((sessionRes as any).modelConfig.claudeModel ?? "sonnet");
        }
      }
      setPrs(prsRes.prs);
      // Initialize live cost from session record
      if (sessionRes.session.costUsd) {
        setLiveCost(parseFloat(sessionRes.session.costUsd));
      }
    } catch {
      toast.error("Failed to load session");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSession();
  }, [id]);

  // Poll for PR updates while session is active
  useEffect(() => {
    if (!session || session.state !== "active") return;
    const interval = setInterval(() => {
      api
        .getSessionPrs(id)
        .then((res) => setPrs(res.prs))
        .catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, [session?.state, id]);

  const handleEnd = async () => {
    setEnding(true);
    try {
      const res = await api.endSession(id);
      setSession(res.session);
      setShowEndWarning(false);
      toast.success("Session ended");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to end session");
    }
    setEnding(false);
  };

  const handleCostUpdate = useCallback((cost: number) => {
    setLiveCost(cost);
  }, []);

  const handleSendToAgentRegister = useCallback((handler: (text: string) => void) => {
    sendToAgentRef.current = handler;
  }, []);
  const codexLoginMode = searchParams.get("setup") === "codex-login";
  const sessionRepoUrl = session?.repoUrl ?? null;
  const codexLoginCommand = codexLoginMode
    ? 'export CODEX_HOME="/home/agent/.codex"\nmkdir -p "$CODEX_HOME"\nprintf \'cli_auth_credentials_store = "file"\\n\' > "$CODEX_HOME/config.toml"\nchmod 700 "$CODEX_HOME"\nchmod 600 "$CODEX_HOME/config.toml"\nrm -f /tmp/optio-codex-login.log\nprintf \'Optio managed Codex login\\nStarting device-auth flow.\\nUse the verification URL and device code below.\\nLeave this session open until setup says the login was imported.\\n\\n\' | tee -a /tmp/optio-codex-login.log\ncodex login --device-auth 2>&1 | tee -a /tmp/optio-codex-login.log\n'
    : undefined;

  const fetchCodexAuthStatus = useCallback(async () => {
    if (!codexLoginMode) return;

    setCodexAuthStatusLoading(true);
    try {
      const res = await api.getCodexAuthAccount();
      setCodexAuthStatus(res);
    } catch (err) {
      setCodexAuthStatus({
        account: null,
        login: {
          state: "error",
          canImport: false,
          authDetected: false,
          instructions: [
            "Optio could not load the managed Codex login state.",
            "Reload the page or return to Settings to retry.",
          ],
          sessionId: id,
          repoUrl: sessionRepoUrl,
          loginUrl: null,
          userCode: null,
          lastError: err instanceof Error ? err.message : "Failed to load Codex login status",
          logExcerpt: null,
        },
      });
    } finally {
      setCodexAuthStatusLoading(false);
    }
  }, [codexLoginMode, id, sessionRepoUrl]);

  const importCodexLogin = useCallback(async () => {
    setCodexImportLoading(true);
    try {
      await api.importCodexAuthFromSession(id);
      toast.success("Imported shared Codex login");
      await fetchCodexAuthStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import Codex login");
      throw err;
    } finally {
      setCodexImportLoading(false);
    }
  }, [fetchCodexAuthStatus, id]);

  useEffect(() => {
    if (!codexLoginMode) return;

    fetchCodexAuthStatus();
    const interval = setInterval(() => {
      fetchCodexAuthStatus().catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [codexLoginMode, fetchCodexAuthStatus]);

  useEffect(() => {
    if (!codexLoginMode || !codexAuthStatus?.login.canImport || codexImportLoading) return;
    if (codexAutoImportAttemptedRef.current === id) return;

    codexAutoImportAttemptedRef.current = id;
    importCodexLogin().catch(() => {
      codexAutoImportAttemptedRef.current = null;
    });
  }, [codexAuthStatus?.login.canImport, codexImportLoading, codexLoginMode, id, importCodexLogin]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading session...
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        Session not found
      </div>
    );
  }

  const isActive = session.state === "active";
  const repoName = session.repoUrl?.replace("https://github.com/", "") ?? "Unknown";
  const displayCost = liveCost > 0 ? liveCost : session.costUsd ? parseFloat(session.costUsd) : 0;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-border bg-bg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/sessions" className="text-text-muted hover:text-text transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-primary" />
              <div>
                <h1 className="text-lg font-semibold tracking-tight">
                  {session.branch ?? `Session ${session.id.slice(0, 8)}`}
                </h1>
                <div className="flex items-center gap-3 text-xs text-text-muted">
                  <span className="flex items-center gap-1">
                    <FolderGit2 className="w-3 h-3" />
                    {repoName}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1",
                      isActive ? "text-primary" : "text-text-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        isActive ? "bg-primary animate-pulse" : "bg-text-muted",
                      )}
                    />
                    {session.state}
                  </span>
                  <span>Started {formatRelativeTime(session.createdAt)}</span>
                  {isActive && (
                    <span className="text-primary">{formatDuration(session.createdAt)}</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Live cost counter */}
            {displayCost > 0 && (
              <span className="flex items-center gap-1 text-xs text-text-muted px-2 py-1 bg-bg-card rounded-md border border-border">
                <DollarSign className="w-3 h-3" />
                {displayCost.toFixed(4)}
              </span>
            )}

            {/* Model selector */}
            {isActive && modelConfig && (
              <div className="relative">
                <button
                  onClick={() => setShowModelDropdown(!showModelDropdown)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-bg-card border border-border text-text-muted hover:text-text transition-colors"
                >
                  <Bot className="w-3 h-3" />
                  {selectedModel}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showModelDropdown && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setShowModelDropdown(false)}
                    />
                    <div className="absolute right-0 top-full mt-1 z-50 bg-bg-card border border-border rounded-lg shadow-lg py-1 min-w-[120px]">
                      {modelConfig.availableModels.map((m) => (
                        <button
                          key={m}
                          onClick={() => {
                            setSelectedModel(m);
                            setShowModelDropdown(false);
                          }}
                          className={cn(
                            "w-full text-left px-3 py-1.5 text-xs hover:bg-bg transition-colors",
                            m === selectedModel && "text-primary font-medium",
                          )}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* PR indicator in header */}
            {prs.length > 0 && (
              <span className="flex items-center gap-1 text-xs text-text-muted px-2 py-1 bg-bg-card rounded-md border border-border">
                <GitPullRequest className="w-3 h-3" />
                {prs.length} PR{prs.length > 1 ? "s" : ""}
              </span>
            )}

            {isActive && (
              <button
                onClick={() => setShowEndWarning(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-bg-card border border-border text-text-muted hover:text-error hover:border-error/30 transition-colors"
              >
                <StopCircle className="w-3.5 h-3.5" />
                End Session
              </button>
            )}
          </div>
        </div>
      </div>

      {codexLoginMode && (
        <>
          <div className="shrink-0 px-6 py-3 border-b border-primary/20 bg-primary/5 text-sm">
            This session is set up for managed Codex login. The terminal auto-starts{" "}
            <code>codex login</code>, keeps a login transcript for Setup/Settings to read, and
            should stay open until Optio reports that the shared auth was imported.
          </div>
          <div className="shrink-0 px-6 py-4 border-b border-border bg-bg-card/60">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Guided Codex login</p>
                <p className="text-xs text-text-muted mt-1">
                  Status:{" "}
                  <code>
                    {codexAuthStatus?.login.state ??
                      (codexAuthStatusLoading ? "loading" : "starting")}
                  </code>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => fetchCodexAuthStatus()}
                  disabled={codexAuthStatusLoading}
                  className="px-3 py-2 rounded-md border border-border text-sm font-medium hover:border-primary disabled:opacity-50"
                >
                  {codexAuthStatusLoading ? "Refreshing..." : "Refresh Status"}
                </button>
                <button
                  type="button"
                  onClick={() => importCodexLogin()}
                  disabled={!codexAuthStatus?.login.canImport || codexImportLoading}
                  className="px-3 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {codexImportLoading ? "Importing..." : "Import Login"}
                </button>
                <Link
                  href="/settings"
                  className="px-3 py-2 rounded-md border border-border text-sm font-medium hover:border-primary"
                >
                  Open Settings
                </Link>
              </div>
            </div>

            {codexAuthStatus?.login.instructions?.length ? (
              <ul className="mt-3 text-xs text-text-muted space-y-1 list-disc pl-4">
                {codexAuthStatus.login.instructions.map((instruction) => (
                  <li key={instruction}>{instruction}</li>
                ))}
              </ul>
            ) : null}

            {codexAuthStatus?.login.loginUrl && (
              <p className="mt-3 text-xs">
                <a
                  href={codexAuthStatus.login.loginUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  Open device verification page <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            )}

            {codexAuthStatus?.login.userCode && (
              <p className="mt-2 text-xs text-text-muted">
                Device code: <code>{codexAuthStatus.login.userCode}</code>
              </p>
            )}

            {codexAuthStatus?.login.lastError && (
              <p className="mt-2 text-xs text-error flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>{codexAuthStatus.login.lastError}</span>
              </p>
            )}

            {codexAuthStatus?.login.logExcerpt && !codexAuthStatus.login.loginUrl && (
              <pre className="mt-3 max-h-40 overflow-auto rounded border border-border bg-bg px-2 py-1 text-[11px] text-text-muted whitespace-pre-wrap">
                {codexAuthStatus.login.logExcerpt}
              </pre>
            )}

            {codexAuthStatus?.account && (
              <p className="mt-3 text-xs text-text-muted">
                Managed account: <code>{codexAuthStatus.account.id}</code>
              </p>
            )}
          </div>
        </>
      )}

      {/* End session warning dialog */}
      {showEndWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-bg-card border border-border rounded-xl p-6 max-w-md mx-4 shadow-xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-sm">End this session?</h3>
                <p className="text-xs text-text-muted mt-2">
                  The worktree will be cleaned up. Any un-pushed commits or changes will be lost.
                  Make sure you have pushed all work before ending.
                </p>
                <div className="flex items-center gap-2 mt-4">
                  <button
                    onClick={handleEnd}
                    disabled={ending}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-error text-white text-xs font-medium hover:bg-error/90 disabled:opacity-50"
                  >
                    {ending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    End Session
                  </button>
                  <button
                    onClick={() => setShowEndWarning(false)}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-bg border border-border text-text-muted hover:text-text transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main content — split pane for active sessions */}
      <div className="flex-1 min-h-0">
        {isActive ? (
          <SplitPane
            leftLabel="Agent Chat"
            rightLabel="Terminal"
            left={
              <ErrorBoundary label="Session chat">
                <SessionChat
                  sessionId={id}
                  onCostUpdate={handleCostUpdate}
                  onSendToAgent={handleSendToAgentRegister}
                />
              </ErrorBoundary>
            }
            right={
              <div className="h-full flex flex-col">
                <ErrorBoundary label="Terminal">
                  <SessionTerminal sessionId={id} initialCommand={codexLoginCommand} />
                </ErrorBoundary>
                {/* PR cards inline below terminal when present */}
                {prs.length > 0 && (
                  <div className="shrink-0 border-t border-border bg-bg px-3 py-2">
                    <div className="flex items-center gap-2 overflow-x-auto">
                      {prs.map((pr: any) => (
                        <PrBadge key={pr.id} pr={pr} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            }
          />
        ) : (
          <div className="h-full flex items-center justify-center text-text-muted bg-[#09090b]">
            <div className="text-center">
              <Terminal className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Session ended</p>
              {session.endedAt && (
                <p className="text-xs mt-1">
                  Duration: {formatDuration(session.createdAt, session.endedAt)}
                </p>
              )}
              {displayCost > 0 && <p className="text-xs mt-1">Cost: ${displayCost.toFixed(4)}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact inline PR badge for the terminal footer */
function PrBadge({ pr }: { pr: any }) {
  const checksIcon =
    {
      passing: <CheckCircle2 className="w-3 h-3 text-success" />,
      failing: <XCircle className="w-3 h-3 text-error" />,
      pending: <Clock className="w-3 h-3 text-warning" />,
    }[pr.prChecksStatus as string] ?? null;

  const reviewIcon =
    {
      approved: <CheckCircle2 className="w-3 h-3 text-success" />,
      changes_requested: <AlertTriangle className="w-3 h-3 text-warning" />,
      pending: <Clock className="w-3 h-3 text-text-muted" />,
    }[pr.prReviewStatus as string] ?? null;

  return (
    <a
      href={pr.prUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-bg-card text-xs hover:border-primary/30 transition-colors"
    >
      <GitPullRequest className="w-3 h-3 text-text-muted" />
      <span className="font-medium">#{pr.prNumber}</span>
      <span
        className={cn(
          "text-[10px] font-medium uppercase px-1 py-0.5 rounded",
          pr.prState === "merged"
            ? "bg-purple-500/10 text-purple-400"
            : pr.prState === "closed"
              ? "bg-error/10 text-error"
              : "bg-success/10 text-success",
        )}
      >
        {pr.prState ?? "open"}
      </span>
      {checksIcon}
      {reviewIcon}
      <ExternalLink className="w-3 h-3 text-text-muted" />
    </a>
  );
}
