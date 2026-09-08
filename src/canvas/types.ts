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
  type: string; // "student", "teacher", "ta", "observer", "designer"
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
}

export interface PlannerItem {
  plannable_type: string;
  plannable_id: number;
  plannable_date: string;
  course_id?: number | null;
  plannable: PlannableDetails;
  html_url?: string;
}

export interface CalendarEvent {
  id: number;
  title: string;
  start_at?: string | null;
  end_at?: string | null;
  description?: string | null;
  context_code: string;
  html_url: string;
}

export interface Announcement {
  id: number;
  title: string;
  message?: string | null;
  posted_at?: string | null;
  context_code: string;
  html_url: string;
}
