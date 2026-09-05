import { describe, expect, it } from "vitest";
import { parseReviewTaskVerdict, resolveReviewTaskInput } from "./review-task-input.js";

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

describe("parseReviewTaskVerdict", () => {
  it("uses the final structured verdict emitted by a review agent", () => {
    expect(
      parseReviewTaskVerdict(
        "review complete\nOPTIO_REVIEW_VERDICT: comment\nOPTIO_REVIEW_VERDICT: request_changes\n",
      ),
    ).toBe("request_changes");
  });

  it("does not infer a verdict from ordinary review prose", () => {
    expect(parseReviewTaskVerdict("I would request changes, but GitHub rejected it.")).toBeNull();
  });
});
