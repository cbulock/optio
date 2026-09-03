import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optio-status-hook-"));
process.env.OPTIO_STATUS_HOOK_STATE_DIR = tempDir;

const modulePath = new URL("./optio-status.mjs", import.meta.url);
const hookModule = await import(modulePath);

const {
  buildDiscordMessage,
  shouldNotify,
  summarizePayload,
  default: transform,
} = hookModule;

const completed = summarizePayload({
  event: "task.completed",
  taskId: "task-123",
  title: "Add webhook endpoint",
  summary: "PR opened successfully",
  taskUrl: "http://10.0.0.54:30310/tasks/task-123",
  prUrl: "https://github.com/cbulock/openclaw-memory-tooling/pull/99",
  to: "channel:1541845096746590258",
});

assert.equal(completed.event, "task_completed");
assert.equal(completed.state, "");
assert.equal(shouldNotify(completed), true);
assert.match(buildDiscordMessage(completed), /Optio: Add webhook endpoint completed\./);
assert.match(buildDiscordMessage(completed), /Task <http:\/\/10\.0\.0\.54:30310\/tasks\/task-123>/);
assert.match(buildDiscordMessage(completed), /PR <https:\/\/github\.com\/cbulock\/openclaw-memory-tooling\/pull\/99>/);

const ignored = summarizePayload({
  event: "task.state_changed",
  state: "waiting_for_capacity",
  taskId: "task-123",
  title: "Add webhook endpoint",
});

assert.equal(shouldNotify(ignored), false);
assert.deepEqual(await transform({ payload: ignored }), { kind: "none" });

const delivered = await transform({
  payload: {
    event: "task.pr_opened",
    taskId: "task-456",
    title: "Wire Optio hook",
    summary: "ready for review",
    taskUrl: "http://10.0.0.54:30310/tasks/task-456",
    prUrl: "https://github.com/cbulock/openclaw-memory-tooling/pull/100",
    to: "channel:1541845096746590258",
  },
});

assert.equal(delivered.kind, "agent");
assert.equal(delivered.agentId, "main");
assert.equal(delivered.channel, "discord");
assert.equal(delivered.to, "channel:1541845096746590258");
assert.match(delivered.message, /Reply with exactly the Discord message provided below and nothing else\./);
assert.match(delivered.message, /opened a PR/);
assert.match(delivered.message, /PR <https:\/\/github\.com\/cbulock\/openclaw-memory-tooling\/pull\/100>/);

console.log("optio status hook tests passed");
