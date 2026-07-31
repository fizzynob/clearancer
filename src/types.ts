export type EntryStatus = "pending" | "submitted" | "graded";

export interface LasEntry {
  id: string;
  date: string; // ISO yyyy-mm-dd, "" = pending/no date yet
  number: string; // e.g. "01"
  title: string;
  cdScore: number | null;
  cdMax: number;
  wwScore: number | null;
  wwMax: number;
  status: EntryStatus;
  /** Google Classroom courseWork id, when this entry was synced in. Used to upsert on re-sync. */
  sourceId?: string;
}

export interface QuizEntry {
  id: string;
  date: string;
  number: string;
  title: string;
  score: number | null;
  max: number;
  status: EntryStatus;
}

export interface Subject {
  id: string;
  name: string;
  icon: string; // material symbol name
  gradeLevel: string;
  section: string;
  academicYear: string;
  quarter: string;
  status: string;
  adviser: string;
  las: LasEntry[];
  quizzes: QuizEntry[];
}

export interface AppData {
  version: 1;
  activeSubjectId: string;
  showTitles: boolean;
  /** LAS table sort order. false (default) = highest number first. */
  lasSortAscending: boolean;
  subjects: Subject[];
}
