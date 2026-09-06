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

  it("recognizes a verdict split across app-server streaming chunks", () => {
    expect(
      parseReviewTaskVerdict("Review complete\nOPT\nIO_RE\nVIEW_VER\nDICT: request\n_changes\n"),
    ).toBe("request_changes");
  });

  it("recognizes a verdict split across Codex NDJSON message events", () => {
    const event = (content: string) =>
      JSON.stringify({ type: "message", role: "assistant", content });
    expect(
      parseReviewTaskVerdict(
        [
          event("Submitted a changes"),
          event("\n\nOPT"),
          event("IO_RE"),
          event("VIEW_VER"),
          event("DICT: request"),
          event("_changes"),
        ].join("\n"),
      ),
    ).toBe("request_changes");
  });

  it("recognizes a completed same-author fallback comment", () => {
    expect(
      parseReviewTaskVerdict(
        "https://github.com/cbulock/music-studio/pull/22#issuecomment-1\n" +
          "Submitted a changes-requested comment on PR #22",
      ),
    ).toBe("request_changes");
  });

  it("does not infer a verdict from ordinary review prose", () => {
    expect(parseReviewTaskVerdict("I would request changes, but GitHub rejected it.")).toBeNull();
  });
});
