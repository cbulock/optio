import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = resolve(root, "scripts/review-exec-guard.c");
const dockerfile = resolve(root, "images/base.Dockerfile");
const ghWrapper = resolve(root, "scripts/review-guard-gh");
const gitWrapper = resolve(root, "scripts/review-guard-git");
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Codex review execution guard", () => {
  it("blocks workspace writes from a shell child", () => {
    const temp = mkdtempSync(`${tmpdir()}/optio-review-guard-`);
    cleanup.push(temp);
    const library = `${temp}/guard.so`;
    execFileSync("gcc", ["-shared", "-fPIC", "-O2", "-o", library, source, "-ldl"]);

    const workspace = `/workspace/optio-review-guard-${process.pid}-${Date.now()}`;
    cleanup.push(workspace);
    execFileSync("mkdir", ["-p", workspace]);
    const result = spawnSync("/bin/sh", ["-c", `echo blocked > ${workspace}/attempt.txt`], {
      env: { ...process.env, LD_PRELOAD: library },
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(`${workspace}/attempt.txt`)).toBe(false);
  });

  it("keeps canonical /usr/bin git and gh paths guarded for review descendants", () => {
    const image = readFileSync(dockerfile, "utf8");
    expect(image).toContain("mv /usr/bin/git /opt/optio/git");
    expect(image).not.toContain("mv /usr/bin/git /opt/optio/git-real");
    expect(image).toContain("ln -s /opt/optio/review-guard-git /usr/bin/git");
    expect(image).toContain("ln -s /opt/optio/review-guard-gh /usr/bin/gh");
    expect(readFileSync(ghWrapper, "utf8")).toContain('"${2:-}" != "review"');
    expect(readFileSync(ghWrapper, "utf8")).toContain("exec /opt/optio/gh-real");
    expect(readFileSync(gitWrapper, "utf8")).toContain("exec /opt/optio/git");
  });

  it("permits the minimal GitHub review submission command", () => {
    const wrapper = readFileSync(ghWrapper, "utf8");
    expect(wrapper).toContain('"${1:-}" != "pr"');
    expect(wrapper).toContain('"${2:-}" != "diff"');
    expect(wrapper).toContain('"${2:-}" != "view"');
    expect(wrapper).toContain('"${2:-}" != "review"');
  });
});
