// "Likely goal" badge rule for the review strip. The refiner confidence
// is a RECORDED SIGNAL (spike gate PASS — freeze-OOF P@4 0.673 vs
// span-alone 0.492; scripts/event-tagging/refiner/PROTOCOL.md): it badges
// cards, accumulates reviewer-agreement data, and NEVER filters or
// reorders the chronological complete-pass strip. Approve stays human.

// Floor from the auto-approve precision curve (freeze OOF, medium band:
// conf >= 0.85 -> precision 0.855 — RESULTS.md §"Auto-approve precision
// curve"). One constant to retune; UI-only.
export const LIKELY_GOAL_MIN = 0.85

/** Whether a candidate's confidence earns the "likely goal" badge.
 *  null = row predates the refiner (no badge, never a fake 0). */
export function showLikelyGoal(confidence: number | null): boolean {
  return confidence !== null && confidence >= LIKELY_GOAL_MIN
}
