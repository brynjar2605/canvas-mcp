import type { CanvasClient } from "./client.js";
import type { CourseInfo } from "./courses.js";
import type { Assignment, RubricCriterion } from "./types.js";
import { htmlToMarkdown } from "../util/html.js";

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
}

export interface RubricItem {
  description: string;
  points: number | null;
}

export interface AssignmentAttachment {
  name: string;
  url: string;
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

function isSubmitted(a: Assignment): boolean {
  const state = a.submission?.workflow_state;
  if (state) return state !== "unsubmitted";
  return Boolean(a.submission?.submitted_at);
}

function isMissing(a: Assignment, now: Date): boolean {
  if (typeof a.submission?.missing === "boolean") return a.submission.missing;
  if (!a.due_at) return false;
  return new Date(a.due_at) < now && !isSubmitted(a);
}

function toSummary(a: Assignment, course: CourseInfo, now: Date): AssignmentSummary {
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
    missing: isMissing(a, now),
    late: a.submission?.late ?? false,
    htmlUrl: a.html_url,
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
  const summaries = raw.map((a) => toSummary(a, course, now));
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

/** Pulls `<a href=".../files/...">name</a>` links out of an assignment description as attachments. */
function extractAttachments(html: string | null | undefined): AssignmentAttachment[] {
  if (!html) return [];
  const attachments: AssignmentAttachment[] = [];
  let match: RegExpExecArray | null;
  FILE_LINK_RE.lastIndex = 0;
  while ((match = FILE_LINK_RE.exec(html)) !== null) {
    const url = match[1]!;
    const name = match[2]!.replace(TAG_RE, "").trim() || url;
    attachments.push({ name, url });
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
  const now = new Date();
  const a = await client.get<Assignment>(`/api/v1/courses/${course.id}/assignments/${assignmentId}`, {
    include: ["submission"],
  });
  const summary = toSummary(a, course, now);
  return {
    ...summary,
    descriptionMarkdown: htmlToMarkdown(a.description),
    submissionTypes: a.submission_types ?? [],
    rubric: toRubricItems(a.rubric),
    attachments: extractAttachments(a.description),
    unlockAt: a.unlock_at ?? null,
    lockAt: a.lock_at ?? null,
    submittedAt: a.submission?.submitted_at ?? null,
  };
}
