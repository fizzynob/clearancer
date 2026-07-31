import { invoke } from "@tauri-apps/api/core";
import type { AppData, Subject } from "./types";

export function makeId(): string {
  return crypto.randomUUID();
}

const DEFAULT_SUBJECTS: Array<Pick<Subject, "name" | "icon">> = [
  { name: "Science", icon: "science" },
  { name: "Filipino", icon: "language" },
  { name: "Araling Pan.", icon: "public" },
  { name: "TLE", icon: "handyman" },
  { name: "CommArts", icon: "menu_book" },
  { name: "Math", icon: "functions" },
];

function makeDefaultSubject(name: string, icon: string): Subject {
  return {
    id: makeId(),
    name,
    icon,
    gradeLevel: "",
    section: "",
    academicYear: `${new Date().getFullYear()} - ${new Date().getFullYear() + 1}`,
    quarter: "Quarter 1",
    status: "ENROLLED",
    adviser: "",
    las: [],
    quizzes: [],
  };
}

export function makeDefaultData(): AppData {
  const subjects = DEFAULT_SUBJECTS.map((s) => makeDefaultSubject(s.name, s.icon));
  return {
    version: 1,
    activeSubjectId: subjects[0].id,
    showTitles: true,
    lasSortAscending: false,
    subjects,
  };
}

function migrate(raw: unknown): AppData {
  const fallback = makeDefaultData();
  if (!raw || typeof raw !== "object") return fallback;
  const data = raw as Partial<AppData>;
  if (!Array.isArray(data.subjects) || data.subjects.length === 0) return fallback;
  return {
    version: 1,
    activeSubjectId:
      typeof data.activeSubjectId === "string" ? data.activeSubjectId : data.subjects[0].id,
    showTitles: data.showTitles !== false,
    lasSortAscending: data.lasSortAscending === true,
    subjects: data.subjects,
  };
}

export async function loadData(): Promise<AppData> {
  try {
    const raw = await invoke<string | null>("load_data");
    if (!raw) return makeDefaultData();
    return migrate(JSON.parse(raw));
  } catch (err) {
    console.error("Failed to load saved data, starting fresh:", err);
    return makeDefaultData();
  }
}

export async function persistData(data: AppData): Promise<void> {
  await invoke("save_data", { json: JSON.stringify(data) });
}

export interface NowPlaying {
  title: string;
  artist: string;
  playing: boolean;
}

/** Reads the OS's current System Media Transport Controls session, if any. */
export async function getNowPlaying(): Promise<NowPlaying | null> {
  try {
    return await invoke<NowPlaying | null>("get_now_playing");
  } catch {
    return null;
  }
}
