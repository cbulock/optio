import { describe, expect, it } from "vitest";
import { resolveReviewTaskInput } from "./review-task-input.js";

const review = {
  renderedPrompt: "Review only PR #42.",
  taskFileContent: "# Review Context\nPR #42",
  taskFilePath: ".optio/review-context.md",
};

describe("resolveReviewTaskInput", () => {
  it("recovers the dedicated review prompt after a retry drops the queue payload", () => {
    expect(
      resolveReviewTaskInput({
        taskType: "review",
        metadata: { reviewOverride: review },
      }),
    ).toEqual(review);
  });

  it("fails closed rather than using stale coding task.md input", () => {
    expect(() => resolveReviewTaskInput({ taskType: "review", metadata: null })).toThrow(
      "cannot safely run a coding prompt",
    );
  });
});
