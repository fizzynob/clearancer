import { getCurrentWindow } from "@tauri-apps/api/window";
import { appDataDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { loadData, persistData, makeId, getNowPlaying, type NowPlaying } from "./data";
import { computeCompletion } from "./calc";
import {
  googleStatus,
  googleDisconnect,
  googleListCourses,
  googleSyncCourse,
  googleConnect,
  type CourseSummary,
  type SyncedItem,
} from "./google";
import type { AppData, EntryStatus, LasEntry, QuizEntry, Subject } from "./types";

const PAGE_SIZE = 6;
const AUTOSAVE_INTERVAL_MS = 10_000;
const NOW_PLAYING_POLL_MS = 1_500;
// A student has exactly one grade level, section, and quarter regardless of
// subject, so editing these in any tab mirrors the change to every subject.
const SHARED_SUBJECT_FIELDS = new Set(["gradeLevel", "section", "quarter"]);

let data: AppData;
let dirty = false;
let lasSearch = "";
let lasPage: Record<string, number> = {};
let quizPage: Record<string, number> = {};
let confirmCallback: (() => void) | null = null;

// Drag-to-paint status: shift+left drags "graded", ctrl+left drags "pending",
// shift+right drags "submitted" across whichever status cells the pointer
// passes over while the button stays down.
let paintStatus: EntryStatus | null = null;
let paintTable: "las" | "quiz" | null = null;
let suppressNextClick = false;

let lastNowPlaying: NowPlaying | null = null;

const $ = <T extends Element = Element>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);
const $all = <T extends Element = Element>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

function activeSubject(): Subject {
  const found = data.subjects.find((s) => s.id === data.activeSubjectId);
  return found ?? data.subjects[0];
}

function markDirty() {
  dirty = true;
  setSaveIndicator("unsaved");
}

function setSaveIndicator(state: "saved" | "saving" | "unsaved") {
  const el = $("#save-indicator");
  if (!el) return;
  el.classList.remove("saved", "saving", "unsaved");
  el.classList.add(state);
  el.textContent = state === "saved" ? "saved" : state === "saving" ? "saving..." : "unsaved changes";
}

async function flushSave(force = false) {
  if (!dirty && !force) return;
  setSaveIndicator("saving");
  try {
    await persistData(data);
    dirty = false;
    setSaveIndicator("saved");
  } catch (err) {
    console.error("Save failed:", err);
    setSaveIndicator("unsaved");
  }
}

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ---------------------------- formatting ---------------------------- */

function formatDate(iso: string): string {
  if (!iso) return "pending";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "pending";
  return d
    .toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })
    .toUpperCase()
    .replace(",", ",");
}

function scoreChip(score: number | null, max: number): string {
  if (score === null) return `<span class="score-chip empty">--/${max}</span>`;
  return `<span class="score-chip">${score}/${max}</span>`;
}

function statusTag(status: EntryStatus): string {
  const icon = status === "graded" ? "done_all" : status === "submitted" ? "history" : "schedule";
  return `<span class="status-tag ${status}"><span class="material-symbols-outlined">${icon}</span>${status}</span>`;
}

function sortByDate<T extends { date: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });
}

// LAS numbers can carry a decimal sub-number and/or a trailing quarter
// letter (e.g. "2.1", "5A") — only the leading numeric part decides order.
function lasNumberSortKey(number: string): number {
  const match = number.match(/^(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

// Descending (default): highest LAS number first, lowest last.
// Ascending: flipped via the sort-order toggle button.
function sortByLasNumber(entries: LasEntry[], ascending: boolean): LasEntry[] {
  const dir = ascending ? 1 : -1;
  return [...entries].sort((a, b) => dir * (lasNumberSortKey(a.number) - lasNumberSortKey(b.number)));
}

/* ------------------------------ tabs -------------------------------- */

function renderTabs() {
  const nav = $("#subject-tabs")!;
  nav.innerHTML = data.subjects
    .map(
      (s) => `
      <button class="tab ${s.id === data.activeSubjectId ? "active" : ""}" data-subject-id="${s.id}">
        <span class="material-symbols-outlined icon-sm">${s.icon}</span>
        <span>${escapeHtml(s.name)}</span>
      </button>`
    )
    .join("");
}

/* ---------------------------- subject view --------------------------- */

function renderSubject() {
  const subject = activeSubject();
  const container = $("#subject-content")! as HTMLElement;
  container.innerHTML = `
    <div class="header-grid">
      <div class="student-record">
        <div class="record-top">
          <div>
            <p class="label-mono">student record</p>
          </div>
          <div style="text-align: right">
            <p class="label-mono">academic year</p>
            <input class="year-input" data-field="academicYear" value="${escapeAttr(subject.academicYear)}" />
          </div>
        </div>
        <div class="record-fields">
          <div>
            <span class="field-mini-label">grade level</span>
            <input data-field="gradeLevel" value="${escapeAttr(subject.gradeLevel)}" placeholder="Grade 10" />
            <div class="now-playing" id="now-playing" hidden>
              <div class="now-playing-bars">
                <span></span><span></span><span></span><span></span>
              </div>
              <div class="now-playing-text">
                <span class="now-playing-title" id="now-playing-title"></span>
                <span class="now-playing-artist" id="now-playing-artist"></span>
              </div>
            </div>
          </div>
          <div>
            <span class="field-mini-label">section</span>
            <input data-field="section" value="${escapeAttr(subject.section)}" placeholder="Section" />
          </div>
          <div>
            <span class="field-mini-label">quarter</span>
            <input data-field="quarter" value="${escapeAttr(subject.quarter)}" placeholder="Quarter 1" />
          </div>
          <div>
            <span class="field-mini-label">status</span>
            <select data-field="status">
              ${["ENROLLED", "COMPLETED", "DROPPED"]
                .map((v) => `<option value="${v}" ${subject.status === v ? "selected" : ""}>${v}</option>`)
                .join("")}
            </select>
          </div>
        </div>
      </div>
      <div class="perf-card">
        <div>
          <p class="perf-label">subject completion</p>
          <div class="perf-score">
            <span class="big" id="perf-percent">0</span>
            <span class="small">/ 100</span>
          </div>
        </div>
        <div>
          <div class="perf-bar-track"><div class="perf-bar-fill" id="perf-fill" style="width: 0%"></div></div>
          <div class="perf-meta">
            <span>progress</span>
            <span id="perf-earned">0/0 pts graded</span>
          </div>
        </div>
      </div>
    </div>

    <div class="section" id="las-section">
      <div class="section-header">
        <div>
          <h3>learning activity sheets</h3>
          <p class="subtitle">${escapeHtml(subject.name)} &middot; ${escapeHtml(subject.quarter)}</p>
        </div>
        <div class="section-tools">
          <div class="search-box">
            <span class="material-symbols-outlined">search</span>
            <input type="text" id="las-search" placeholder="Search LAS..." value="${escapeAttr(lasSearch)}" />
          </div>
          <button class="btn btn-outline" id="toggle-titles">
            <span class="material-symbols-outlined icon-sm">${data.showTitles ? "visibility_off" : "visibility"}</span>
            ${data.showTitles ? "hide" : "show"} titles
          </button>
          <button
            class="icon-btn"
            id="toggle-las-sort"
            title="${data.lasSortAscending ? "Lowest LAS number first" : "Highest LAS number first"}"
          >
            <span class="material-symbols-outlined icon-sm">${data.lasSortAscending ? "arrow_upward" : "arrow_downward"}</span>
          </button>
        </div>
      </div>
      <div class="table-wrap ${data.showTitles ? "" : "title-hide"}" id="las-table-wrap">
        <table>
          <thead>
            <tr>
              <th>date</th>
              <th>las number &amp; title</th>
              <th class="center">cd</th>
              <th class="center">ww</th>
              <th>status</th>
              <th class="right">action</th>
            </tr>
          </thead>
          <tbody id="las-tbody"></tbody>
        </table>
      </div>
      <button class="add-row-btn" id="add-las-row">
        <span class="material-symbols-outlined icon-sm">add</span> add learning activity sheet
      </button>
      <div class="table-footer" id="las-table-footer"></div>
    </div>

    <div class="section" id="quiz-section">
      <div class="section-header">
        <div>
          <h3>quizzes</h3>
          <p class="subtitle">${escapeHtml(subject.name)} &middot; ${escapeHtml(subject.quarter)} Assessment Portfolio</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>date</th>
              <th>quiz number &amp; title</th>
              <th class="center">score</th>
              <th>status</th>
              <th class="right">action</th>
            </tr>
          </thead>
          <tbody id="quiz-tbody"></tbody>
        </table>
      </div>
      <button class="add-row-btn" id="add-quiz-row">
        <span class="material-symbols-outlined icon-sm">add</span> add quiz
      </button>
      <div class="table-footer" id="quiz-table-footer"></div>
    </div>

    <div class="sheet-footer">
      <div class="adviser-block">
        <div class="dotted-leader-row">
          <span class="label-mono" style="font-size: 10px">validated by adviser</span>
          <div class="dotted-leader"></div>
        </div>
        <input class="adviser-name-input" data-field="adviser" value="${escapeAttr(subject.adviser)}" placeholder="Adviser name" />
      </div>
    </div>
  `;

  renderLasRows();
  renderQuizRows();
  updatePerfCard();
  renderNowPlayingWidget();

  container.classList.remove("subject-anim");
  void container.offsetWidth; // restart animation even if switching repeatedly
  container.classList.add("subject-anim");
}

function updatePerfCard() {
  const subject = activeSubject();
  const { percent, earned, possible } = computeCompletion(subject);
  const fill = $("#perf-fill") as HTMLElement | null;
  const pct = $("#perf-percent");
  const meta = $("#perf-earned");
  if (fill) fill.style.width = `${percent}%`;
  if (pct) pct.textContent = String(percent);
  if (meta) meta.textContent = `${earned}/${possible} pts graded`;
}

/* ------------------------------ LAS rows ------------------------------ */

function filteredLas(subject: Subject): LasEntry[] {
  const q = lasSearch.trim().toLowerCase();
  let list = sortByLasNumber(subject.las, data.lasSortAscending);
  if (q) {
    list = list.filter(
      (l) => l.number.toLowerCase().includes(q) || l.title.toLowerCase().includes(q)
    );
  }
  return list;
}

function renderLasRows() {
  const subject = activeSubject();
  const tbody = $("#las-tbody")!;
  const list = filteredLas(subject);
  const page = lasPage[subject.id] ?? 1;
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  lasPage[subject.id] = clampedPage;
  const pageItems = list.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  if (pageItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
      <span class="material-symbols-outlined">description</span>
      ${list.length === 0 ? "No learning activity sheets yet." : "No LAS match your search."}
    </div></td></tr>`;
  } else {
    tbody.innerHTML = pageItems
      .map(
        (l) => `
      <tr data-las-id="${l.id}">
        <td class="cell-date ${l.date ? "" : "pending"}">${formatDate(l.date)}</td>
        <td>
          <div class="cell-title-main">
            <span class="num">LAS #${escapeHtml(l.number)}</span>
            <span class="desc">${escapeHtml(l.title || "Untitled")}</span>
          </div>
        </td>
        <td class="center cell-score" data-role="score" data-table="las" data-field="cdScore" data-entry-id="${l.id}" data-max="${l.cdMax}">${scoreChip(l.cdScore, l.cdMax)}</td>
        <td class="center cell-score" data-role="score" data-table="las" data-field="wwScore" data-entry-id="${l.id}" data-max="${l.wwMax}">${scoreChip(l.wwScore, l.wwMax)}</td>
        <td class="cell-status" data-role="status" data-table="las" data-entry-id="${l.id}">${statusTag(l.status)}</td>
        <td class="right"><button class="row-more-btn material-symbols-outlined">more_vert</button></td>
      </tr>`
      )
      .join("");
  }

  renderTableFooter($("#las-table-footer")!, clampedPage, totalPages, "las");
}

function renderQuizRows() {
  const subject = activeSubject();
  const tbody = $("#quiz-tbody")!;
  const list = sortByDate(subject.quizzes);
  const page = quizPage[subject.id] ?? 1;
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  quizPage[subject.id] = clampedPage;
  const pageItems = list.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  if (pageItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">
      <span class="material-symbols-outlined">quiz</span>
      No quizzes yet.
    </div></td></tr>`;
  } else {
    tbody.innerHTML = pageItems
      .map(
        (q) => `
      <tr data-quiz-id="${q.id}">
        <td class="cell-date ${q.date ? "" : "pending"}">${formatDate(q.date)}</td>
        <td>
          <div class="cell-title-main">
            <span class="num">Quiz #${escapeHtml(q.number)}</span>
            <span class="desc">${escapeHtml(q.title || "Untitled")}</span>
          </div>
        </td>
        <td class="center cell-score" data-role="score" data-table="quiz" data-field="score" data-entry-id="${q.id}" data-max="${q.max}">${scoreChip(q.score, q.max)}</td>
        <td class="cell-status" data-role="status" data-table="quiz" data-entry-id="${q.id}">${statusTag(q.status)}</td>
        <td class="right"><button class="row-more-btn material-symbols-outlined">more_vert</button></td>
      </tr>`
      )
      .join("");
  }

  renderTableFooter($("#quiz-table-footer")!, clampedPage, totalPages, "quiz");
}

function renderTableFooter(el: HTMLElement, page: number, totalPages: number, table: "las" | "quiz") {
  el.innerHTML = `
    <p class="page-label">page ${page} of ${totalPages}</p>
    <div style="display:flex; gap:8px">
      <button class="btn btn-outline btn-xs" data-page-action="prev" data-table="${table}" ${page <= 1 ? "disabled" : ""}>prev</button>
      <button class="btn btn-outline btn-xs" data-page-action="next" data-table="${table}" ${page >= totalPages ? "disabled" : ""}>next</button>
    </div>
  `;
}

/* --------------------------- inline quick-edit -------------------------- */

function findEntry(table: "las" | "quiz", entryId: string): LasEntry | QuizEntry | undefined {
  const subject = activeSubject();
  return table === "las"
    ? subject.las.find((l) => l.id === entryId)
    : subject.quizzes.find((q) => q.id === entryId);
}

function rerenderTable(table: "las" | "quiz") {
  if (table === "las") renderLasRows();
  else renderQuizRows();
}

function applyPaintStatus(cell: HTMLElement) {
  if (!paintStatus || !paintTable) return;
  if (cell.dataset.table !== paintTable) return;
  const entryId = cell.dataset.entryId;
  if (!entryId) return;
  const entry = findEntry(paintTable, entryId);
  if (!entry || entry.status === paintStatus) return;
  entry.status = paintStatus;
  markDirty();
  rerenderTable(paintTable);
  updatePerfCard();
  flashCell(paintTable, entryId, "status");
}

function flashCell(table: "las" | "quiz", entryId: string, role: "score" | "status", field?: string) {
  const selector =
    role === "score"
      ? `td[data-role="score"][data-table="${table}"][data-entry-id="${entryId}"][data-field="${field}"]`
      : `td[data-role="status"][data-table="${table}"][data-entry-id="${entryId}"]`;
  $(selector)?.classList.add("flash-save");
}

const MAX_FIELD: Record<"cdScore" | "wwScore" | "score", "cdMax" | "wwMax" | "max"> = {
  cdScore: "cdMax",
  wwScore: "wwMax",
  score: "max",
};

function beginScoreEdit(td: HTMLElement) {
  const table = td.dataset.table as "las" | "quiz";
  const field = td.dataset.field as "cdScore" | "wwScore" | "score";
  const maxField = MAX_FIELD[field];
  const entryId = td.dataset.entryId!;
  const entry = findEntry(table, entryId) as Record<string, number | null> | undefined;
  if (!entry) return;
  const current = entry[field];
  const currentMax = entry[maxField];

  td.innerHTML = `<span class="inline-edit-wrap">
    <input type="number" class="inline-edit-input" min="0" step="0.5" value="${current ?? ""}" />
    <span class="inline-edit-suffix">/</span>
    <input type="number" class="inline-edit-input inline-edit-max" min="0" step="0.5" value="${currentMax ?? ""}" />
  </span>`;
  const scoreInput = td.querySelector(".inline-edit-input:not(.inline-edit-max)") as HTMLInputElement;
  const maxInput = td.querySelector(".inline-edit-max") as HTMLInputElement;
  scoreInput.focus();
  scoreInput.select();

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const rawScore = scoreInput.value.trim();
    const rawMax = maxInput.value.trim();
    const newMax = rawMax === "" ? 0 : Number(rawMax);
    entry[maxField] = newMax;
    entry[field] = clampScore(rawScore === "" ? null : Number(rawScore), newMax);
    markDirty();
    rerenderTable(table);
    updatePerfCard();
    flashCell(table, entryId, "score", field);
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    rerenderTable(table);
  };

  for (const input of [scoreInput, maxInput]) {
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cancel();
      }
    });
  }
  // Commit only once focus leaves both fields (e.g. tabbing from score to max
  // shouldn't save yet); a short delay lets focus land on the sibling input.
  const onBlur = () => {
    window.setTimeout(() => {
      if (document.activeElement !== scoreInput && document.activeElement !== maxInput) {
        commit();
      }
    }, 0);
  };
  scoreInput.addEventListener("blur", onBlur);
  maxInput.addEventListener("blur", onBlur);
}

function beginStatusEdit(td: HTMLElement) {
  const table = td.dataset.table as "las" | "quiz";
  const entryId = td.dataset.entryId!;
  const entry = findEntry(table, entryId);
  if (!entry) return;

  const statuses: EntryStatus[] = ["pending", "submitted", "graded"];
  td.innerHTML = `<select class="inline-edit-input inline-edit-select">${statuses
    .map((s) => `<option value="${s}" ${entry.status === s ? "selected" : ""}>${s}</option>`)
    .join("")}</select>`;
  const select = td.querySelector("select") as HTMLSelectElement;
  select.focus();

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    entry.status = select.value as EntryStatus;
    markDirty();
    rerenderTable(table);
    updatePerfCard();
    flashCell(table, entryId, "status");
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    rerenderTable(table);
  };

  select.addEventListener("change", commit);
  select.addEventListener("blur", cancel, { once: true });
  select.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      cancel();
    }
  });
}

/* ------------------------------- modals -------------------------------- */

function openModal(id: string) {
  $(`#${id}`)?.classList.remove("hidden");
}
function closeModal(id: string) {
  $(`#${id}`)?.classList.add("hidden");
}
function closeAllModals() {
  $all(".modal-overlay").forEach((m) => m.classList.add("hidden"));
}

function openConfirm(message: string, onConfirm: () => void) {
  $("#confirm-message")!.textContent = message;
  confirmCallback = onConfirm;
  openModal("modal-confirm");
}

function openLasModal(entry?: LasEntry) {
  const form = $("#form-las-entry") as HTMLFormElement;
  form.reset();
  $("#las-entry-modal-title")!.textContent = entry ? "edit las" : "add las";
  const deleteBtn = $("#las-entry-delete") as HTMLButtonElement;
  (form.elements.namedItem("id") as HTMLInputElement).value = entry?.id ?? "";
  (form.elements.namedItem("date") as HTMLInputElement).value = entry?.date ?? todayIso();
  (form.elements.namedItem("number") as HTMLInputElement).value = entry?.number ?? "";
  (form.elements.namedItem("title") as HTMLInputElement).value = entry?.title ?? "";
  (form.elements.namedItem("cdScore") as HTMLInputElement).value = entry?.cdScore?.toString() ?? "";
  (form.elements.namedItem("cdMax") as HTMLInputElement).value = (entry?.cdMax ?? 10).toString();
  (form.elements.namedItem("wwScore") as HTMLInputElement).value = entry?.wwScore?.toString() ?? "";
  (form.elements.namedItem("wwMax") as HTMLInputElement).value = (entry?.wwMax ?? 10).toString();
  (form.elements.namedItem("status") as HTMLSelectElement).value = entry?.status ?? "pending";
  deleteBtn.hidden = !entry;
  openModal("modal-las-entry");
}

function openQuizModal(entry?: QuizEntry) {
  const form = $("#form-quiz-entry") as HTMLFormElement;
  form.reset();
  $("#quiz-entry-modal-title")!.textContent = entry ? "edit quiz" : "add quiz";
  const deleteBtn = $("#quiz-entry-delete") as HTMLButtonElement;
  (form.elements.namedItem("id") as HTMLInputElement).value = entry?.id ?? "";
  (form.elements.namedItem("date") as HTMLInputElement).value = entry?.date ?? todayIso();
  (form.elements.namedItem("number") as HTMLInputElement).value = entry?.number ?? "";
  (form.elements.namedItem("title") as HTMLInputElement).value = entry?.title ?? "";
  (form.elements.namedItem("score") as HTMLInputElement).value = entry?.score?.toString() ?? "";
  (form.elements.namedItem("max") as HTMLInputElement).value = (entry?.max ?? 50).toString();
  (form.elements.namedItem("status") as HTMLSelectElement).value = entry?.status ?? "pending";
  deleteBtn.hidden = !entry;
  openModal("modal-quiz-entry");
}

function numOrNull(v: FormDataEntryValue | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Scores can't be negative or exceed the item's max. */
function clampScore(score: number | null, max: number): number | null {
  if (score === null) return null;
  return Math.min(Math.max(score, 0), max);
}

function handleLasSubmit(e: Event) {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const fd = new FormData(form);
  const subject = activeSubject();
  const id = fd.get("id") as string;

  const cdMax = Number(fd.get("cdMax")) || 0;
  const wwMax = Number(fd.get("wwMax")) || 0;
  const entry: LasEntry = {
    id: id || makeId(),
    date: (fd.get("date") as string) ?? "",
    number: (fd.get("number") as string)?.trim() || "00",
    title: (fd.get("title") as string)?.trim() ?? "",
    cdScore: clampScore(numOrNull(fd.get("cdScore")), cdMax),
    cdMax,
    wwScore: clampScore(numOrNull(fd.get("wwScore")), wwMax),
    wwMax,
    status: (fd.get("status") as EntryStatus) ?? "pending",
  };

  const idx = subject.las.findIndex((l) => l.id === entry.id);
  if (idx >= 0) subject.las[idx] = entry;
  else subject.las.push(entry);

  markDirty();
  closeModal("modal-las-entry");
  renderLasRows();
  updatePerfCard();
}

function handleQuizSubmit(e: Event) {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const fd = new FormData(form);
  const subject = activeSubject();
  const id = fd.get("id") as string;

  const max = Number(fd.get("max")) || 0;
  const entry: QuizEntry = {
    id: id || makeId(),
    date: (fd.get("date") as string) ?? "",
    number: (fd.get("number") as string)?.trim() || "00",
    title: (fd.get("title") as string)?.trim() ?? "",
    score: clampScore(numOrNull(fd.get("score")), max),
    max,
    status: (fd.get("status") as EntryStatus) ?? "pending",
  };

  const idx = subject.quizzes.findIndex((q) => q.id === entry.id);
  if (idx >= 0) subject.quizzes[idx] = entry;
  else subject.quizzes.push(entry);

  markDirty();
  closeModal("modal-quiz-entry");
  renderQuizRows();
  updatePerfCard();
}

/* ------------------------- google classroom sync ------------------------ */

// Keyword hints used to match a Classroom course name to a subject tab.
// First subject (in tab order) whose keyword appears in the course name wins;
// courses that don't match anything are left alone.
const SUBJECT_KEYWORDS: Record<string, string[]> = {
  Science: ["science"],
  Filipino: ["filipino"],
  "Araling Pan.": ["araling panlipunan", "araling pan", "araling", "aralpan", "social studies"],
  TLE: ["tle", "technology and livelihood", "livelihood education"],
  CommArts: ["commarts", "comm arts", "communication arts", "english"],
  Math: ["math", "mathematics"],
};

function matchSubjectForCourse(courseName: string): Subject | undefined {
  const name = courseName.toLowerCase();
  return data.subjects.find((subject) => {
    const keywords = SUBJECT_KEYWORDS[subject.name] ?? [subject.name.toLowerCase()];
    return keywords.some((k) => name.includes(k));
  });
}

// A LAS number can carry a decimal sub-number ("2.1", "4.5") and/or a
// trailing quarter letter ("5A", "2A") on top of a plain integer.
const LAS_NUM = String.raw`\d+(?:\.\d+)?`;

// Zero-pads the integer part of a plain number so single digits sort/display
// consistently ("1" -> "01", "2.1" -> "02.1"); left alone once a letter
// suffix is involved, per the tag's own casing (e.g. "5A" stays "5A").
function padLasNumber(raw: string): string {
  const [intPart, decPart] = raw.split(".");
  const padded = intPart.padStart(2, "0");
  return decPart !== undefined ? `${padded}.${decPart}` : padded;
}

// A separator between the tag parts can be a space, a dash, a colon, or
// nothing at all ("LAS01", "LAS-01", "LAS 01 - Title"...).
const LAS_SEP = String.raw`\s*[-–—:]?\s*`;

// "[LAS 01] Title" / "[LAS 2.1] Title" — an explicit bracketed tag always
// wins when present, regardless of where it sits in the string.
const BRACKET_LAS_RULE = new RegExp(String.raw`\[\s*las\s*#?\s*(${LAS_NUM})\s*\]`, "i");

// The global convention: a LAS or quarter ("1Q".."4Q") prefix at the very
// front of the title, then the tag number (decimal sub-number and/or a
// trailing quarter letter A-D allowed), then everything else is the title.
// "LAS 01 - Cell Division", "1Q7 Reading", "LAS-2.1 Something", "LAS5A Topic"…
const GENERAL_LAS_RULE = new RegExp(String.raw`^\s*(?:las|[1-4]q)${LAS_SEP}(${LAS_NUM})([a-d])?${LAS_SEP}(.*)$`, "i");

function normalizeLasNumber(digits: string, letter?: string): string {
  return letter ? `${digits}${letter.toUpperCase()}` : padLasNumber(digits);
}

function parseLasTag(rawTitle: string): { number: string; title: string } | null {
  const bracketMatch = rawTitle.match(BRACKET_LAS_RULE);
  if (bracketMatch && bracketMatch.index !== undefined) {
    const number = padLasNumber(bracketMatch[1]);
    const rest = (
      rawTitle.slice(0, bracketMatch.index) + rawTitle.slice(bracketMatch.index + bracketMatch[0].length)
    )
      .replace(/^[\s\-:,.•]+|[\s\-:,.•]+$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return { number, title: /[a-z]/i.test(rest) ? rest : rawTitle };
  }

  const generalMatch = rawTitle.match(GENERAL_LAS_RULE);
  if (generalMatch) {
    const [, digits, letter, rest] = generalMatch;
    const number = normalizeLasNumber(digits, letter);
    const trimmedRest = rest.trim();
    return { number, title: /[a-z]/i.test(trimmedRest) ? trimmedRest : rawTitle };
  }

  return null;
}

function upsertLasFromClassroom(subject: Subject, items: SyncedItem[]): number {
  let nextNumber = subject.las.length + 1;
  for (const item of items) {
    const existingIdx = subject.las.findIndex((l) => l.sourceId === item.sourceId);
    const status: EntryStatus =
      item.assignedGrade !== null
        ? "graded"
        : item.state === "TURNED_IN" || item.state === "RETURNED"
          ? "submitted"
          : "pending";

    // LAS entries always score CD out of 10 in this tracker, but Classroom
    // assignments can be worth any number of points — scale proportionally
    // onto a /10 scale instead of just relabeling the max (which would
    // silently misrepresent the grade).
    const cdScore =
      item.assignedGrade !== null && item.maxPoints > 0
        ? Math.round(((item.assignedGrade / item.maxPoints) * 10) * 2) / 2
        : null;

    const tag = parseLasTag(item.title);
    const number =
      tag?.number ?? (existingIdx >= 0 ? subject.las[existingIdx].number : String(nextNumber++).padStart(2, "0"));
    const title = tag?.title ?? item.title;

    const entry: LasEntry = {
      id: existingIdx >= 0 ? subject.las[existingIdx].id : makeId(),
      date: item.dueDate ?? item.updated ?? "",
      number,
      title,
      cdScore,
      cdMax: 10,
      wwScore: null,
      wwMax: 0,
      status,
      sourceId: item.sourceId,
    };

    if (existingIdx >= 0) subject.las[existingIdx] = entry;
    else subject.las.push(entry);
  }
  return items.length;
}

/** Connects (if needed) then syncs; used by both the LAS-options menu item and the rescan button. */
async function triggerGoogleSync() {
  const status = await googleStatus();
  if (status.connected) void runGoogleSync();
  else openModal("modal-google");
}

async function runGoogleSync() {
  showToast("Signing in to Google Classroom…", "info");
  try {
    const status = await googleStatus();
    if (!status.connected) {
      showToast("Not connected to Google Classroom.", "error");
      return;
    }

    showToast("Looking for your classes…", "info");
    const courses = await googleListCourses();
    const matches = courses
      .map((course) => ({ course, subject: matchSubjectForCourse(course.name) }))
      .filter((m): m is { course: CourseSummary; subject: Subject } => !!m.subject);
    const skipped = courses.length - matches.length;

    if (matches.length === 0) {
      showToast("No Google Classroom classes matched a subject tab.", "error");
      return;
    }

    // One class at a time, with a short pause between each, so a burst of
    // requests across many classes doesn't trip Google's per-user rate limit.
    // A failure on one class doesn't stop the rest from syncing.
    const summary: string[] = [];
    const failures: string[] = [];
    for (let i = 0; i < matches.length; i++) {
      const { course, subject } = matches[i];
      showToast(`Syncing ${subject.name} (${course.name})…`, "info");
      try {
        const items = await googleSyncCourse(course.id);
        const count = upsertLasFromClassroom(subject, items);
        summary.push(`${subject.name}: ${count}`);
      } catch (err) {
        console.error(`Sync failed for ${subject.name} (${course.name}):`, err);
        failures.push(subject.name);
      }
      if (i < matches.length - 1) await sleep(600);
    }

    markDirty();
    renderLasRows();
    updatePerfCard();

    const skippedText = skipped > 0 ? `, skipped ${skipped} unrelated class${skipped === 1 ? "" : "es"}` : "";
    const failedText = failures.length > 0 ? ` Failed to sync: ${failures.join(", ")}.` : "";
    showToast(
      `Synced LAS for ${summary.join(", ") || "no subjects"}${skippedText}.${failedText}`,
      failures.length > 0 ? "error" : "success"
    );
  } catch (err) {
    console.error("Google Classroom sync failed:", err);
    showToast(err instanceof Error ? err.message : "Google Classroom sync failed.", "error");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/* --------------------------------- toasts -------------------------------- */

function showToast(message: string, kind: "info" | "success" | "error" = "info") {
  const stack = $("#toast-stack")!;
  // An in-flight "info" toast (e.g. "Signing in…") gets replaced by the next
  // status update instead of piling up.
  if (kind === "info") {
    $(".toast.is-pending", stack)?.remove();
  }
  const toast = document.createElement("div");
  toast.className = `toast ${kind === "error" ? "error" : ""} ${kind === "info" ? "is-pending" : ""}`.trim();
  toast.textContent = message;
  stack.appendChild(toast);

  if (kind !== "info") {
    window.setTimeout(() => {
      toast.classList.add("fade-out");
      toast.addEventListener("animationend", () => toast.remove(), { once: true });
    }, 4000);
  }
}

/* -------------------------------- theme --------------------------------- */

const THEME_STORAGE_KEY = "clearancer-theme";

function isDarkActive(): boolean {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark") return true;
  if (explicit === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function updateThemeToggleIcon() {
  const btn = $("#btn-theme-toggle");
  if (!btn) return;
  btn.innerHTML = `<span class="material-symbols-outlined icon-sm">${isDarkActive() ? "light_mode" : "dark_mode"}</span>`;
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "dark" || saved === "light") {
    document.documentElement.dataset.theme = saved;
  }
  updateThemeToggleIcon();
}

function toggleTheme() {
  const next = isDarkActive() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_STORAGE_KEY, next);
  updateThemeToggleIcon();
}

/* ---------------------------- now playing (SMTC) ------------------------- */

// SMTC only exposes metadata (title/artist/playback state), never raw audio,
// so this is a stylized equalizer that pulses while playing rather than a
// real audio-reactive visualizer — there's no waveform/spectrum to read.
function renderNowPlayingWidget() {
  const widget = $<HTMLElement>("#now-playing");
  if (!widget) return;
  if (!lastNowPlaying) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  widget.classList.toggle("is-playing", lastNowPlaying.playing);
  const titleEl = $("#now-playing-title");
  const artistEl = $("#now-playing-artist");
  if (titleEl) titleEl.textContent = lastNowPlaying.title;
  if (artistEl) artistEl.textContent = lastNowPlaying.artist;
}

async function pollNowPlaying() {
  lastNowPlaying = await getNowPlaying();
  renderNowPlayingWidget();
}

/* ------------------------------- utils --------------------------------- */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/* --------------------------- event wiring ------------------------------ */

function wireEvents() {
  // Tab switching
  $("#subject-tabs")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-subject-id]");
    if (!btn) return;
    const newId = btn.dataset.subjectId!;
    if (newId === data.activeSubjectId) return;
    data.activeSubjectId = newId;
    lasSearch = "";
    renderTabs();
    renderSubject();
  });

  // Delegated events inside the subject content area
  const content = $<HTMLElement>("#subject-content")!;

  content.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    const field = target.getAttribute("data-field");
    if (!field) return;
    const subject = activeSubject();
    const value = (target as HTMLInputElement).value;
    (subject as unknown as Record<string, string>)[field] = value;
    if (SHARED_SUBJECT_FIELDS.has(field)) {
      // A student has one grade level/section/quarter regardless of subject.
      for (const s of data.subjects) {
        (s as unknown as Record<string, string>)[field] = value;
      }
    }
    markDirty();
    if (field === "quarter" || field === "gradeLevel" || field === "section") {
      // subtitle text mirrors these fields; cheap targeted refresh
      $all(".subtitle").forEach((el) => {
        el.textContent = el.textContent!.includes("Assessment")
          ? `${subject.name} · ${subject.quarter} Assessment Portfolio`
          : `${subject.name} · ${subject.quarter}`;
      });
    }
  });
  // Drag-to-paint status: start on mousedown over a status cell with the
  // right modifier, then paint every status cell the pointer enters until
  // mouseup. The upcoming click (and, for shift+right, the context menu)
  // from this same interaction gets swallowed so it doesn't also try to
  // open the quick-edit or the full modal.
  content.addEventListener("mousedown", (e: MouseEvent) => {
    const statusCell = (e.target as HTMLElement).closest<HTMLElement>('td[data-role="status"]');
    if (!statusCell) return;

    const shiftLeft = e.button === 0 && e.shiftKey;
    const ctrlLeft = e.button === 0 && e.ctrlKey;
    const shiftRight = e.button === 2 && e.shiftKey;
    if (!shiftLeft && !ctrlLeft && !shiftRight) return;

    e.preventDefault();
    paintStatus = shiftRight ? "submitted" : ctrlLeft ? "pending" : "graded";
    paintTable = statusCell.dataset.table as "las" | "quiz";
    suppressNextClick = true;
    applyPaintStatus(statusCell);
  });
  content.addEventListener("mouseover", (e) => {
    if (!paintStatus) return;
    const statusCell = (e.target as HTMLElement).closest<HTMLElement>('td[data-role="status"]');
    if (statusCell) applyPaintStatus(statusCell);
  });
  document.addEventListener("mouseup", () => {
    paintStatus = null;
    paintTable = null;
  });

  content.addEventListener("change", (e) => {
    const target = e.target as HTMLElement;
    const field = target.getAttribute("data-field");
    if (!field) return;
    const subject = activeSubject();
    (subject as unknown as Record<string, string>)[field] = (target as HTMLSelectElement).value;
    markDirty();
  });

  content.addEventListener("click", (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const target = e.target as HTMLElement;

    if (target.closest("#toggle-titles")) {
      data.showTitles = !data.showTitles;
      markDirty();
      renderSubject();
      return;
    }
    if (target.closest("#toggle-las-sort")) {
      data.lasSortAscending = !data.lasSortAscending;
      markDirty();
      renderSubject();
      return;
    }
    if (target.closest("#add-las-row")) {
      openLasModal();
      return;
    }
    if (target.closest("#add-quiz-row")) {
      openQuizModal();
      return;
    }
    const pageBtn = target.closest<HTMLElement>("[data-page-action]");
    if (pageBtn && !(pageBtn as HTMLButtonElement).disabled) {
      const table = pageBtn.dataset.table as "las" | "quiz";
      const dir = pageBtn.dataset.pageAction === "next" ? 1 : -1;
      const subject = activeSubject();
      if (table === "las") {
        lasPage[subject.id] = (lasPage[subject.id] ?? 1) + dir;
        renderLasRows();
      } else {
        quizPage[subject.id] = (quizPage[subject.id] ?? 1) + dir;
        renderQuizRows();
      }
      return;
    }
    // Quick-edit: clicking a CD/WW/score chip or a status tag edits it in place,
    // like a spreadsheet cell, instead of opening the full modal.
    const scoreCell = target.closest<HTMLElement>('td[data-role="score"]');
    if (scoreCell) {
      if (!scoreCell.querySelector("input")) beginScoreEdit(scoreCell);
      return;
    }
    const statusCell = target.closest<HTMLElement>('td[data-role="status"]');
    if (statusCell) {
      if (!statusCell.querySelector("select")) beginStatusEdit(statusCell);
      return;
    }

    const lasRow = target.closest<HTMLElement>("tr[data-las-id]");
    if (lasRow) {
      const subject = activeSubject();
      const entry = subject.las.find((l) => l.id === lasRow.dataset.lasId);
      if (entry) openLasModal(entry);
      return;
    }
    const quizRow = target.closest<HTMLElement>("tr[data-quiz-id]");
    if (quizRow) {
      const subject = activeSubject();
      const entry = subject.quizzes.find((q) => q.id === quizRow.dataset.quizId);
      if (entry) openQuizModal(entry);
      return;
    }
  });

  // Right-click on a row always opens the full edit popup, even over a
  // quick-edit cell — mirrors "right click for more options" convention.
  // Exception: shift+right-click on a status cell is the "paint submitted"
  // gesture handled above via mousedown, so don't also pop the modal.
  content.addEventListener("contextmenu", (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (e.shiftKey && target.closest('td[data-role="status"]')) {
      e.preventDefault();
      return;
    }
    const lasRow = target.closest<HTMLElement>("tr[data-las-id]");
    if (lasRow) {
      e.preventDefault();
      const subject = activeSubject();
      const entry = subject.las.find((l) => l.id === lasRow.dataset.lasId);
      if (entry) openLasModal(entry);
      return;
    }
    const quizRow = target.closest<HTMLElement>("tr[data-quiz-id]");
    if (quizRow) {
      e.preventDefault();
      const subject = activeSubject();
      const entry = subject.quizzes.find((q) => q.id === quizRow.dataset.quizId);
      if (entry) openQuizModal(entry);
    }
  });

  let searchDebounce: number | undefined;
  content.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    if (target.id !== "las-search") return;
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      lasSearch = (target as HTMLInputElement).value;
      const subject = activeSubject();
      lasPage[subject.id] = 1;
      renderLasRows();
    }, 150);
  });

  // Manual save
  $("#btn-save-now")!.addEventListener("click", () => void flushSave(true));
  $("#btn-theme-toggle")!.addEventListener("click", toggleTheme);

  // LAS options modal
  $("#btn-las-options")!.addEventListener("click", () => {
    openModal("modal-las-options");
    void googleStatus().then((status) => {
      ($("#opt-google-disconnect") as HTMLButtonElement).hidden = !status.connected;
    });
  });
  $("#opt-add-las")!.addEventListener("click", () => {
    closeModal("modal-las-options");
    openLasModal();
  });
  $("#opt-add-quiz")!.addEventListener("click", () => {
    closeModal("modal-las-options");
    openQuizModal();
  });
  $("#opt-clear-las")!.addEventListener("click", () => {
    closeModal("modal-las-options");
    const subject = activeSubject();
    openConfirm(`Clear all LAS and quiz records for ${subject.name}? This cannot be undone.`, () => {
      subject.las = [];
      subject.quizzes = [];
      markDirty();
      renderLasRows();
      renderQuizRows();
      updatePerfCard();
    });
  });
  // Right-click the same button to wipe every subject at once instead of just the active one.
  $("#opt-clear-las")!.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    closeModal("modal-las-options");
    openConfirm("Clear ALL LAS and quiz records in EVERY subject? This cannot be undone.", () => {
      for (const subject of data.subjects) {
        subject.las = [];
        subject.quizzes = [];
      }
      markDirty();
      renderLasRows();
      renderQuizRows();
      updatePerfCard();
    });
  });
  $("#opt-google-classroom")!.addEventListener("click", () => {
    closeModal("modal-las-options");
    void triggerGoogleSync();
  });
  $("#opt-google-disconnect")!.addEventListener("click", () => {
    closeModal("modal-las-options");
    void googleDisconnect().then(() => showToast("Disconnected from Google Classroom.", "info"));
  });
  $("#btn-google-rescan")!.addEventListener("click", () => void triggerGoogleSync());
  $("#opt-reveal-data-file")!.addEventListener("click", () => {
    closeModal("modal-las-options");
    void (async () => {
      try {
        const filePath = await join(await appDataDir(), "data.json");
        await revealItemInDir(filePath);
      } catch (err) {
        console.error("Could not reveal data file:", err);
        showToast("Could not open File Explorer for the data file.", "error");
      }
    })();
  });

  // Google Classroom connect form
  $("#form-google-connect")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const clientId = (fd.get("clientId") as string).trim();
    const clientSecret = (fd.get("clientSecret") as string).trim();
    const submitBtn = $("#btn-google-connect") as HTMLButtonElement;
    const statusEl = $("#google-connect-status") as HTMLElement;

    submitBtn.disabled = true;
    statusEl.hidden = false;
    statusEl.classList.remove("is-error");
    statusEl.classList.add("is-info");
    statusEl.textContent = "Opening Google sign-in in your browser…";

    void googleConnect(clientId, clientSecret)
      .then(() => {
        closeModal("modal-google");
        form.reset();
        statusEl.hidden = true;
        void runGoogleSync();
      })
      .catch((err: unknown) => {
        statusEl.classList.remove("is-info");
        statusEl.classList.add("is-error");
        statusEl.textContent = err instanceof Error ? err.message : "Could not connect to Google.";
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });

  // Entry forms
  $("#form-las-entry")!.addEventListener("submit", handleLasSubmit);
  $("#form-quiz-entry")!.addEventListener("submit", handleQuizSubmit);

  $("#las-entry-delete")!.addEventListener("click", () => {
    const form = $("#form-las-entry") as HTMLFormElement;
    const id = (form.elements.namedItem("id") as HTMLInputElement).value;
    closeModal("modal-las-entry");
    openConfirm("Delete this learning activity sheet?", () => {
      const subject = activeSubject();
      subject.las = subject.las.filter((l) => l.id !== id);
      markDirty();
      renderLasRows();
      updatePerfCard();
    });
  });
  $("#quiz-entry-delete")!.addEventListener("click", () => {
    const form = $("#form-quiz-entry") as HTMLFormElement;
    const id = (form.elements.namedItem("id") as HTMLInputElement).value;
    closeModal("modal-quiz-entry");
    openConfirm("Delete this quiz?", () => {
      const subject = activeSubject();
      subject.quizzes = subject.quizzes.filter((q) => q.id !== id);
      markDirty();
      renderQuizRows();
      updatePerfCard();
    });
  });

  // Confirm dialog
  $("#confirm-ok")!.addEventListener("click", () => {
    const cb = confirmCallback;
    confirmCallback = null;
    closeModal("modal-confirm");
    cb?.();
  });
  $("#confirm-cancel")!.addEventListener("click", () => {
    confirmCallback = null;
    closeModal("modal-confirm");
  });

  // Generic close (X buttons + overlay background click)
  $all("[data-close-modal]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const overlay = (e.target as HTMLElement).closest(".modal-overlay");
      overlay?.classList.add("hidden");
    })
  );
  $all(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.add("hidden");
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllModals();
  });

  // No native browser context menu anywhere (Inspect/Reload etc. have no
  // place in a packaged desktop app); our own right-click behaviors above
  // already called preventDefault where they apply, this just catches
  // everything else (empty space, headers, tabs...).
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* --------------------------------- init --------------------------------- */

export async function initApp() {
  initTheme();
  data = await loadData();
  renderTabs();
  renderSubject();
  wireEvents();
  setSaveIndicator("saved");

  window.setInterval(() => {
    void flushSave();
  }, AUTOSAVE_INTERVAL_MS);

  void pollNowPlaying();
  window.setInterval(() => {
    void pollNowPlaying();
  }, NOW_PLAYING_POLL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushSave();
  });

  try {
    const appWindow = getCurrentWindow();
    appWindow.onCloseRequested(async (event) => {
      if (dirty) {
        event.preventDefault();
        await flushSave();
        await appWindow.destroy();
      }
    });
  } catch (err) {
    console.warn("Could not attach close handler:", err);
  }
}
