/** Durable, review-only input carried by legacy review subtasks. */
export interface ReviewTaskOverride {
  renderedPrompt: string;
  taskFileContent: string;
  taskFilePath: string;
  model?: string;
  claudeModel?: string;
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
