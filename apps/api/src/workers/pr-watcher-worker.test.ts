import { describe, it, expect } from "vitest";
import { determineCheckStatus, determineReviewStatus } from "./pr-watcher-worker.js";

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
