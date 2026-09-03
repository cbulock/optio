import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TARGET = "channel:1541845096746590258";
const DEFAULT_STATE_DIR = process.env.OPTIO_STATUS_HOOK_STATE_DIR || "/root/.openclaw/state/optio-status";
const EVENT_LOG_PATH = path.join(DEFAULT_STATE_DIR, "events.jsonl");
const DEDUPE_PATH = path.join(DEFAULT_STATE_DIR, "dedupe.json");
const DEDUPE_MS = 5 * 60 * 1000;
const MAX_TEXT = 400;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/https?:\/\/\S+/gi, "[url-redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email-redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeUrl(value) {
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  if (!/^https?:\/\//i.test(text)) return "";
  return text.replace(/\s+/g, "").slice(0, 2048);
}

function normalizeName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function normalizeTarget(value) {
  const target = String(value || "").trim();
  if (/^(channel|direct):\d+$/.test(target)) return target;
  return DEFAULT_TARGET;
}

function normalizeEvent(payload) {
  return (
    normalizeName(
      payload.event ||
        payload.type ||
        payload.kind ||
        payload.statusEvent ||
        payload.notificationType
    ) || "task_state_changed"
  );
}

function normalizeState(payload) {
  return normalizeName(
    payload.state ||
      payload.toState ||
      payload.taskState ||
      payload.status ||
      payload.reviewState ||
      payload.prState
  );
}

export function summarizePayload(payload) {
  const envelope = asObject(payload);
  const body = asObject(envelope.data);
  const merged = { ...envelope, ...body };
  const taskId = firstText(merged.taskId, merged.id, merged.optioTaskId) || "unknown-task";
  const state = normalizeState(merged);
  const event = normalizeEvent(merged);
  return {
    source: "optio",
    event,
    state,
    taskId,
    parentTaskId: firstText(merged.parentTaskId),
    title: firstText(merged.title, merged.taskTitle, merged.name) || taskId,
    summary: firstText(
      merged.summary,
      merged.resultSummary,
      merged.message,
      merged.error,
      merged.errorMessage
    ),
    taskUrl: normalizeUrl(merged.taskUrl) || normalizeUrl(merged.url),
    prUrl: normalizeUrl(merged.prUrl),
    reviewUrl: normalizeUrl(merged.reviewUrl),
    repoUrl: normalizeUrl(merged.repoUrl),
    to: normalizeTarget(merged.to || merged.target || merged.discordTarget),
    sessionKey:
      firstText(merged.sessionKey) ||
      `hook:optio:${taskId.replace(/[^a-zA-Z0-9:_-]+/g, "-")}`,
    receivedAt: new Date().toISOString(),
  };
}

export function shouldNotify(event) {
  if (!event.taskId || event.taskId === "unknown-task") return false;
  if (event.event === "task_state_changed") {
    return [
      "pr_opened",
      "review_completed",
      "completed",
      "failed",
      "blocked",
      "needs_attention",
    ].includes(event.state);
  }
  return [
    "task_pr_opened",
    "task_review_completed",
    "task_completed",
    "task_failed",
    "task_blocked",
    "task_needs_attention",
    "review_completed",
    "workflow_run_completed",
    "workflow_run_failed",
  ].includes(event.event);
}

function readDedupe() {
  try {
    return asObject(JSON.parse(fs.readFileSync(DEDUPE_PATH, "utf8")));
  } catch {
    return {};
  }
}

function writeDedupe(state) {
  fs.mkdirSync(DEFAULT_STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(DEDUPE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function appendEvent(event) {
  fs.mkdirSync(DEFAULT_STATE_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(EVENT_LOG_PATH, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function dedupeKey(event) {
  return [
    event.taskId,
    event.event || "event",
    event.state || "state",
    event.prUrl || "",
    event.reviewUrl || "",
    event.summary || "",
  ].join("|");
}

function allowOncePerWindow(event) {
  const key = dedupeKey(event);
  const now = Date.now();
  const dedupe = readDedupe();
  if (Number.isFinite(dedupe[key]) && now - dedupe[key] < DEDUPE_MS) return false;
  dedupe[key] = now;
  for (const [candidate, timestamp] of Object.entries(dedupe)) {
    if (!Number.isFinite(timestamp) || now - timestamp > 24 * 60 * 60 * 1000) delete dedupe[candidate];
  }
  writeDedupe(dedupe);
  return true;
}

function verb(event) {
  if (event.event === "task_pr_opened" || event.state === "pr_opened") return "opened a PR";
  if (event.event === "task_review_requested" || event.state === "pending_review") {
    return "is pending review";
  }
  if (
    event.event === "task_review_completed" ||
    event.event === "review_completed" ||
    event.state === "review_completed"
  ) {
    return "finished review";
  }
  if (event.event === "task_completed" || event.state === "completed") return "completed";
  if (event.event === "task_failed" || event.state === "failed") return "failed";
  if (event.event === "task_blocked" || event.state === "blocked") return "is blocked";
  if (event.event === "task_needs_attention" || event.state === "needs_attention") {
    return "needs attention";
  }
  if (event.event === "task_started" || event.event === "task_running" || event.state === "running") {
    return "is running";
  }
  return "is queued";
}

export function buildDiscordMessage(event) {
  const links = [];
  if (event.taskUrl) links.push(`Task <${event.taskUrl}>`);
  if (event.prUrl) links.push(`PR <${event.prUrl}>`);
  if (event.reviewUrl) links.push(`Review <${event.reviewUrl}>`);
  const summary = event.summary ? ` ${event.summary}` : "";
  const linkText = links.length ? ` ${links.join(" ")}` : "";
  return `Optio: ${event.title} ${verb(event)}.${summary}${linkText}`.trim();
}

export default async function transform(ctx) {
  const event = summarizePayload(ctx.payload);
  appendEvent(event);

  if (!shouldNotify(event)) return { kind: "none" };
  if (!allowOncePerWindow(event)) return { kind: "none" };

  const notice = buildDiscordMessage(event);
  const lines = [
    "You are the OpenClaw code-channel front door handling an Optio status webhook.",
    "Treat the sanitized event below as the only trusted input.",
    "Reply with exactly the Discord message provided below and nothing else.",
    "",
    `Discord message: ${notice}`,
    "",
    "Sanitized event:",
    JSON.stringify(event, null, 2),
    "",
    `Host: ${cleanText(os.hostname())}`,
  ];

  return {
    kind: "agent",
    name: `Optio status: ${event.taskId}`,
    agentId: "main",
    sessionKey: event.sessionKey,
    message: lines.join("\n"),
    deliver: true,
    channel: "discord",
    to: event.to,
    model: "openai/gpt-5.4-mini",
    thinking: "low",
    timeoutSeconds: 180,
    allowUnsafeExternalContent: false,
  };
}

