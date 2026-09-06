/** Durable, review-only input carried by legacy review subtasks. */
export interface ReviewTaskOverride {
  renderedPrompt: string;
  taskFileContent: string;
  taskFilePath: string;
  model?: string;
  claudeModel?: string;
}

export type ReviewTaskVerdict = "approve" | "request_changes" | "comment";

/**
 * Review agents emit this marker after publishing their GitHub review.  It is
 * intentionally independent of GitHub's review state: an author reviewing
 * their own PR must submit a COMMENTED review even when changes are required.
 */
export function parseReviewTaskVerdict(output: string): ReviewTaskVerdict | null {
  // App-server streaming can split the marker across many text deltas. Remove
  // whitespace only for marker recognition so the review's explicit verdict
  // survives those transport boundaries without inferring prose as a verdict.
  const compactOutput = output.replace(/\s+/g, "");
  const matches = [
    ...compactOutput.matchAll(/OPTIO_REVIEW_VERDICT:(approve|request_changes|comment)/gi),
  ];
  const explicitVerdict = matches.at(-1)?.[1] as ReviewTaskVerdict | undefined;
  if (explicitVerdict) return explicitVerdict;

  // A same-author review can recover from a rejected `gh pr comment` by
  // posting through GitHub's API. That completed fallback is an unambiguous
  // internal request-changes outcome even if the agent's subsequent marker is
  // lost with the failed shell command's turn result.
  if (/Submitted a changes-requested comment on PR #\d+/i.test(output)) {
    return "request_changes";
  }

  return null;
}

export function getStoredReviewTaskVerdict(
  metadata: Record<string, unknown> | null,
): ReviewTaskVerdict | null {
  const verdict = metadata?.reviewVerdict;
  return verdict === "approve" || verdict === "request_changes" || verdict === "comment"
    ? verdict
    : null;
}

/**
 * BullMQ jobs are disposable. A retry must recover its dedicated review
 * prompt/context from durable task metadata instead of accidentally running a
 * coding prompt. Legacy review rows without that context fail closed.
 */
export function resolveReviewTaskInput({
  taskType,
  metadata,
  queuedOverride,
}: {
  taskType: string;
  metadata: Record<string, unknown> | null;
  queuedOverride?: ReviewTaskOverride;
}): ReviewTaskOverride | undefined {
  if (queuedOverride) return queuedOverride;
  const stored = metadata?.reviewOverride;
  if (stored && typeof stored === "object") {
    const candidate = stored as Partial<ReviewTaskOverride>;
    if (
      typeof candidate.renderedPrompt === "string" &&
      typeof candidate.taskFileContent === "string" &&
      typeof candidate.taskFilePath === "string"
    ) {
      return candidate as ReviewTaskOverride;
    }
  }
  if (taskType === "review") {
    throw new Error(
      "Review task has no durable review context and cannot safely run a coding prompt. Relaunch the review from its parent task.",
    );
  }
  return undefined;
}
