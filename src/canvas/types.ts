// Canvas REST API types — only the fields canvas-mcp actually uses.
// Canvas may omit many of these depending on `include[]` params and object
// state, so most fields are optional. See https://canvas.instructure.com/doc/api/

export interface EnrollmentTerm {
  id: number;
  name: string;
}

export interface Grades {
  current_score?: number | null;
  current_grade?: string | null;
  final_score?: number | null;
  final_grade?: string | null;
}

export interface Enrollment {
  course_id: number;
  type: string; // "StudentEnrollment" | "TeacherEnrollment" | "TaEnrollment" | "ObserverEnrollment" | "DesignerEnrollment"
  enrollment_state?: string;
  grades?: Grades;
}

export interface Course {
  id: number;
  name: string;
  course_code: string;
  term?: EnrollmentTerm;
  enrollment_term_id?: number;
  workflow_state: string; // "available" | "completed" | "deleted" | "unpublished"
  enrollments?: Enrollment[];
}

export interface RubricCriterionRating {
  id?: string;
  description?: string;
  points?: number;
}

export interface RubricCriterion {
  id?: string;
  description?: string;
  long_description?: string;
  points?: number;
  ratings?: RubricCriterionRating[];
}

export interface Submission {
  submitted_at?: string | null;
  score?: number | null;
  grade?: string | null;
  workflow_state?: string; // "submitted" | "unsubmitted" | "graded" | "pending_review"
  late?: boolean;
  missing?: boolean;
}

export interface Assignment {
  id: number;
  name: string;
  description?: string | null;
  due_at?: string | null;
  lock_at?: string | null;
  unlock_at?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  html_url: string;
  has_submitted_submissions?: boolean;
  submission?: Submission;
  rubric?: RubricCriterion[];
}

export interface CanvasFile {
  id: number;
  display_name: string;
  filename: string;
  folder_id: number;
  size: number;
  "content-type"?: string;
  url: string;
  updated_at?: string;
  modified_at?: string;
  locked?: boolean;
  hidden?: boolean;
  /** True when the file exists but Canvas is currently withholding it from this user (e.g. unlock date not reached). */
  locked_for_user?: boolean;
}

export interface Folder {
  id: number;
  name: string;
  full_name: string;
  parent_folder_id: number | null;
  files_count: number;
  folders_count: number;
}

export interface ModuleItem {
  id: number;
  title: string;
  type: string; // "File" | "Page" | "Discussion" | "Assignment" | "Quiz" | "ExternalUrl" | "ExternalTool" | "SubHeader"
  content_id?: number;
  html_url?: string;
  url?: string;
  page_url?: string;
  external_url?: string;
  /** Present when the module list was fetched with `include[]=content_details`. */
  content_details?: {
    display_name?: string;
    locked_for_user?: boolean;
  };
}

export interface Module {
  id: number;
  name: string;
  position: number;
  items?: ModuleItem[];
}

export interface Page {
  url: string;
  title: string;
  body?: string | null;
  updated_at?: string;
  front_page?: boolean;
}

export interface PlannableDetails {
  title?: string;
  due_at?: string | null;
  points_possible?: number | null;
  /** Present when `plannable_type` is "calendar_event" — the event's own start/end. */
  start_at?: string | null;
  end_at?: string | null;
  /** Room/location for a calendar_event plannable, when Canvas has one (e.g. "M120"). */
  location_name?: string | null;
}

export interface PlannerItem {
  plannable_type: string;
  plannable_id: number;
  plannable_date: string;
  course_id?: number | null;
  plannable: PlannableDetails;
  html_url?: string;
  /** `false` for non-submittable plannables (events, announcements, pages); an object otherwise. */
  submissions?:
    | false
    | { submitted?: boolean; graded?: boolean; missing?: boolean; late?: boolean; score?: number | null };
}

export interface CalendarEvent {
  id: number;
  title: string;
  start_at?: string | null;
  end_at?: string | null;
  description?: string | null;
  context_code: string;
  html_url: string;
  /** Room/location Canvas has on file for the event (e.g. "M120"), when set. */
  location_name?: string | null;
}

export interface Announcement {
  id: number;
  title: string;
  message?: string | null;
  posted_at?: string | null;
  context_code: string;
  html_url: string;
}
