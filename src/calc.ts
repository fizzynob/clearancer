import type { Subject } from "./types";

export interface CompletionResult {
  earned: number;
  possible: number;
  percent: number; // 0-100, rounded
}

/** Weighted completion based on graded LAS + quiz entries only. */
export function computeCompletion(subject: Subject): CompletionResult {
  let earned = 0;
  let possible = 0;

  for (const las of subject.las) {
    if (las.status !== "graded") continue;
    earned += (las.cdScore ?? 0) + (las.wwScore ?? 0);
    possible += las.cdMax + las.wwMax;
  }
  for (const quiz of subject.quizzes) {
    if (quiz.status !== "graded") continue;
    earned += quiz.score ?? 0;
    possible += quiz.max;
  }

  const percent = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  return { earned, possible, percent };
}
