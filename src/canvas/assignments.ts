import type { CanvasClient } from "./client.js";
import type { CourseInfo } from "./courses.js";
import type { Assignment, RubricCriterion } from "./types.js";
import { decodeHtmlEntities, htmlToMarkdown, stripVerifierParams } from "../util/html.js";

export type AssignmentFilter = "upcoming" | "past" | "missing" | "graded" | "all";

export interface AssignmentSummary {
  id: number;
  courseId: number;
  courseSlug: string;
  name: string;
  dueAt: string | null;
  pointsPossible: number | null;
  submitted: boolean;
  score: number | null;
  grade: string | null;
  missing: boolean;
  late: boolean;
  htmlUrl: string;
  /** Raw Canvas submission_types, e.g. ["online_upload"] or ["none"] / ["on_paper"] for in-class work. */
  submissionTypes?: string[];
}

export interface RubricItem {
  description: string;
  points: number | null;
}

export interface AssignmentAttachment {
  name: string;
  url: string;
  /** Canvas file id parsed out of the url, when the link is a /files/:id link. null otherwise. */
  fileId: number | null;
}

export interface AssignmentDetail extends AssignmentSummary {
  descriptionMarkdown: string;
  submissionTypes: string[];
  rubric: RubricItem[];
  attachments?: AssignmentAttachment[];
  unlockAt: string | null;
  lockAt: string | null;
  submittedAt: string | null;
}

const ASSIGNMENTS_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_UPCOMING_DAYS = 30;

const SUBMITTED_WORKFLOW_STATES = new Set(["submitted", "graded", "pending_review"]);

/** RU regularly grades "none"/"on_paper" assignments (in-class work, no online submission) with a score. */
export function isInClassOnly(submissionTypes: string[] | undefined): boolean {
  if (!submissionTypes || submissionTypes.length === 0) return false;
  return submissionTypes.every((t) => t === "none" || t === "on_paper");
}

/**
 * Formats a score with its Canvas `grade`, dropping the parenthesised grade
 * when it's redundant with the score itself — Canvas often sets `grade` to
 * just the bare score ("2" for a 2/2 assignment), which previously rendered
 * as the useless "Score: 2/2 (2)". A grade is shown only when it adds
 * information the raw score/points didn't already carry (a letter grade, a
 * percentage, etc).
 */
export function formatScoreWithGrade(score: number, pointsPossible: number | null, grade: string | null): string {
  const rawScoreText = `${score}${pointsPossible !== null ? `/${pointsPossible}` : ""}`;
  const gradeRedundant = grade !== null && (grade === rawScoreText || grade === String(score));
  const gradePart = grade && !gradeRedundant ? ` (${grade})` : "";
  return `${rawScoreText}${gradePart}`;
}

/**
 * "Submitted" is derived from `workflow_state` (or a non-null score), NEVER
 * from `submitted_at`. Confirmed live: RU's `on_paper`/`none` submission_types
 * assignments carry `workflow_state: "graded"` with `submitted_at: null` once
 * the teacher enters a grade — the student never submits anything online.
 */
function isSubmitted(a: Assignment): boolean {
  const state = a.submission?.workflow_state;
  if (state && SUBMITTED_WORKFLOW_STATES.has(state)) return true;
  return a.submission?.score != null;
}

/**
 * "Missing" is ONLY ever Canvas's own `submission.missing` flag — never inferred from "past
 * due and not submitted". That heuristic used to false-positive on e.g. Turnitin
 * (`external_tool`) assignments: Canvas's planner/assignment `submitted` never goes true for
 * those even once handed in (`workflow_state: "pending_review"`), so the old fallback wrongly
 * called a submitted assignment Missing. When Canvas hasn't told us, we don't guess.
 */
function isMissing(a: Assignment): boolean {
  return a.submission?.missing === true;
}

function toSummary(a: Assignment, course: CourseInfo): AssignmentSummary {
  return {
    id: a.id,
    courseId: course.id,
    courseSlug: course.slug,
    name: a.name,
    dueAt: a.due_at ?? null,
    pointsPossible: a.points_possible ?? null,
    submitted: isSubmitted(a),
    score: a.submission?.score ?? null,
    grade: a.submission?.grade ?? null,
    missing: isMissing(a),
    late: a.submission?.late ?? false,
    htmlUrl: a.html_url,
    submissionTypes: a.submission_types ?? [],
  };
}

async function fetchAssignments(client: CanvasClient, course: CourseInfo): Promise<Assignment[]> {
  return client.getAll<Assignment>(
    `/api/v1/courses/${course.id}/assignments`,
    { include: ["submission"], order_by: "due_at" },
    ASSIGNMENTS_TTL_MS,
  );
}

function applyFilter(
  summaries: AssignmentSummary[],
  filter: AssignmentFilter,
  days: number | undefined,
  now: Date,
): AssignmentSummary[] {
  switch (filter) {
    case "all":
      return summaries;
    case "missing":
      return summaries.filter((s) => s.missing);
    case "graded":
      return summaries.filter((s) => s.score !== null);
    case "upcoming": {
      const windowMs = (days ?? DEFAULT_UPCOMING_DAYS) * 24 * 60 * 60 * 1000;
      const cutoff = new Date(now.getTime() + windowMs);
      return summaries.filter((s) => s.dueAt !== null && new Date(s.dueAt) >= now && new Date(s.dueAt) <= cutoff);
    }
    case "past": {
      if (days === undefined) {
        return summaries.filter((s) => s.dueAt !== null && new Date(s.dueAt) < now);
      }
      const windowMs = days * 24 * 60 * 60 * 1000;
      const floor = new Date(now.getTime() - windowMs);
      return summaries.filter((s) => s.dueAt !== null && new Date(s.dueAt) < now && new Date(s.dueAt) >= floor);
    }
    default: {
      const exhaustive: never = filter;
      throw new Error(`Unknown assignment filter: ${String(exhaustive)}`);
    }
  }
}

/**
 * Lists a course's assignments, optionally filtered. `days` sizes the window
 * for "upcoming" (default 30) and, if given, bounds "past" to the last N
 * days; it is ignored for "missing" / "graded" / "all". Sorted by due date,
 * nulls (no due date) last.
 */
export async function listAssignments(
  client: CanvasClient,
  course: CourseInfo,
  filter: AssignmentFilter = "all",
  days?: number,
): Promise<AssignmentSummary[]> {
  const now = new Date();
  const raw = await fetchAssignments(client, course);
  const summaries = raw.map((a) => toSummary(a, course));
  const filtered = applyFilter(summaries, filter, days, now);
  return filtered.sort((a, b) => {
    if (a.dueAt === null && b.dueAt === null) return 0;
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  });
}

const FILE_LINK_RE = /<a\b[^>]*href=["']([^"']*\/files\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
const TAG_RE = /<[^>]+>/g;
const FILE_ID_RE = /\/files\/(\d+)/;

/** Pulls `<a href=".../files/...">name</a>` links out of an assignment description as attachments.
 * Canvas HTML-escapes the href attribute (so `?verifier=x&wrap=1` shows up as `&amp;wrap=1`), and
 * the link text can carry entities too — both are decoded here. The verifier itself is stripped
 * from the displayed url since it's a one-time per-user token with no value to the LLM; the file
 * id (needed by download_file) is parsed out separately so it survives that stripping. */
function extractAttachments(html: string | null | undefined): AssignmentAttachment[] {
  if (!html) return [];
  const attachments: AssignmentAttachment[] = [];
  let match: RegExpExecArray | null;
  FILE_LINK_RE.lastIndex = 0;
  while ((match = FILE_LINK_RE.exec(html)) !== null) {
    const rawUrl = decodeHtmlEntities(match[1]!);
    const url = stripVerifierParams(rawUrl);
    const name = decodeHtmlEntities(match[2]!.replace(TAG_RE, "").trim()) || url;
    const idMatch = FILE_ID_RE.exec(rawUrl);
    const fileId = idMatch ? Number(idMatch[1]) : null;
    attachments.push({ name, url, fileId });
  }
  return attachments;
}

function toRubricItems(rubric: RubricCriterion[] | undefined): RubricItem[] {
  if (!rubric) return [];
  return rubric.map((c) => ({
    description: c.description ?? c.long_description ?? "",
    points: c.points ?? null,
  }));
}

/** Fetches full assignment detail: description as markdown, rubric, and file attachments parsed from the description. */
export async function getAssignment(
  client: CanvasClient,
  course: CourseInfo,
  assignmentId: number,
): Promise<AssignmentDetail> {
  const a = await client.get<Assignment>(`/api/v1/courses/${course.id}/assignments/${assignmentId}`, {
    include: ["submission"],
  });
  const summary = toSummary(a, course);
  return {
    ...summary,
    // The verifier param is a one-time per-user file-access token with no value to the LLM
    // (file access goes through file_id + download_file instead) — strip it from every URL
    // in the rendered description, not just the attachment links parsed out separately below.
    descriptionMarkdown: stripVerifierParams(htmlToMarkdown(a.description)),
    submissionTypes: a.submission_types ?? [],
    rubric: toRubricItems(a.rubric),
    attachments: extractAttachments(a.description),
    unlockAt: a.unlock_at ?? null,
    lockAt: a.lock_at ?? null,
    submittedAt: a.submission?.submitted_at ?? null,
  };
}
