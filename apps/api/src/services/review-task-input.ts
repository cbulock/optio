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
  const matches = [
    ...output.matchAll(/^OPTIO_REVIEW_VERDICT:\s*(approve|request_changes|comment)\s*$/gim),
  ];
  return (matches.at(-1)?.[1] as ReviewTaskVerdict | undefined) ?? null;
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
