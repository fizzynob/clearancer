import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface GoogleStatus {
  connected: boolean;
  email: string | null;
}

export interface CourseSummary {
  id: string;
  name: string;
}

export interface SyncedItem {
  sourceId: string;
  title: string;
  maxPoints: number;
  assignedGrade: number | null;
  state: string;
  dueDate: string | null;
  updated: string | null;
}

interface AuthCompletePayload {
  ok: boolean;
  email?: string;
  error?: string;
}

export function googleStatus(): Promise<GoogleStatus> {
  return invoke("google_status");
}

export function googleDisconnect(): Promise<void> {
  return invoke("google_disconnect");
}

export function googleListCourses(): Promise<CourseSummary[]> {
  return invoke("google_list_courses");
}

export function googleSyncCourse(courseId: string): Promise<SyncedItem[]> {
  return invoke("google_sync_course", { courseId });
}

/**
 * Kicks off the OAuth loopback flow: opens the Google consent screen in the
 * system browser, then resolves once the background exchange finishes
 * (success or failure) via the `google-auth-complete` event.
 */
export async function googleConnect(
  clientId: string,
  clientSecret: string
): Promise<{ email: string | null }> {
  let resolveDone!: (p: AuthCompletePayload) => void;
  const done = new Promise<AuthCompletePayload>((resolve) => {
    resolveDone = resolve;
  });
  // Registered before opening the browser so we can't miss a fast completion.
  const unlisten = await listen<AuthCompletePayload>("google-auth-complete", (event) => {
    resolveDone(event.payload);
  });

  try {
    const { authUrl } = await invoke<{ authUrl: string }>("google_begin_auth", {
      clientId,
      clientSecret,
    });
    await openUrl(authUrl);
    const result = await done;
    if (!result.ok) throw new Error(result.error ?? "Google sign-in failed.");
    return { email: result.email ?? null };
  } finally {
    unlisten();
  }
}
