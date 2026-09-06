import { describe, it, expect } from "vitest";
import {
  determineCheckStatus,
  determineReviewStatus,
  resolveEffectiveReviewStatus,
  shouldPreserveInternalReviewVerdict,
} from "./pr-watcher-worker.js";

describe("determineCheckStatus", () => {
  it("returns none for empty check runs", () => {
    expect(determineCheckStatus([])).toBe("none");
  });

  it("returns pending when some checks are still running", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ]),
    ).toBe("pending");
  });

  it("returns passing when all checks succeed", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ]),
    ).toBe("passing");
  });

  it("treats skipped as passing", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ]),
    ).toBe("passing");
  });

  it("treats neutral informational checks as passing", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "neutral" },
      ]),
    ).toBe("passing");
  });

  it("returns failing when any check fails", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ]),
    ).toBe("failing");
  });
});

describe("determineReviewStatus", () => {
  it("returns none for no reviews", () => {
    expect(determineReviewStatus([])).toEqual({ status: "none", comments: "" });
  });

  it("returns approved for APPROVED review", () => {
    expect(determineReviewStatus([{ state: "APPROVED", body: "LGTM" }])).toEqual({
      status: "approved",
      comments: "",
    });
  });

  it("returns changes_requested with body", () => {
    expect(determineReviewStatus([{ state: "CHANGES_REQUESTED", body: "Fix the tests" }])).toEqual({
      status: "changes_requested",
      comments: "Fix the tests",
    });
  });

  it("ignores COMMENTED and DISMISSED reviews for status", () => {
    expect(
      determineReviewStatus([{ state: "COMMENTED", body: "Nice work" }, { state: "DISMISSED" }]),
    ).toEqual({ status: "pending", comments: "" });
  });

  it("uses latest substantive review", () => {
    expect(
      determineReviewStatus([
        { state: "CHANGES_REQUESTED", body: "Fix X" },
        { state: "APPROVED", body: "Fixed" },
      ]),
    ).toEqual({ status: "approved", comments: "" });
  });
});

describe("resolveEffectiveReviewStatus", () => {
  it("preserves Optio changes-requested verdicts when self-reviews appear as comments", () => {
    expect(resolveEffectiveReviewStatus("changes_requested", "pending")).toBe("changes_requested");
    expect(resolveEffectiveReviewStatus("changes_requested", "none")).toBe("changes_requested");
  });

  it("accepts a substantive platform approval after Optio requested changes", () => {
    expect(resolveEffectiveReviewStatus("changes_requested", "approved")).toBe("approved");
    expect(resolveEffectiveReviewStatus("changes_requested", "changes_requested")).toBe(
      "changes_requested",
    );
  });

  it("preserves Optio approval verdicts when an author's review is a comment", () => {
    expect(resolveEffectiveReviewStatus("approved", "pending")).toBe("approved");
    expect(resolveEffectiveReviewStatus("approved", "none")).toBe("approved");
    expect(resolveEffectiveReviewStatus("approved", "changes_requested")).toBe("approved");
  });
});

describe("shouldPreserveInternalReviewVerdict", () => {
  it("uses the atomic update path for non-substantive platform feedback", () => {
    expect(shouldPreserveInternalReviewVerdict("pending")).toBe(true);
    expect(shouldPreserveInternalReviewVerdict("none")).toBe(true);
    expect(shouldPreserveInternalReviewVerdict("changes_requested")).toBe(false);
  });
});
