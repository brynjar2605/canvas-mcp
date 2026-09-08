// Central list of every MCP tool this server exposes. src/index.ts imports
// this and registers each one — it contains no business logic of its own.
// Keep this list in sync with the tool table in PLAN.md.

import type { ToolDef } from "./_types.js";

import { tool as listCourses } from "./list_courses.js";
import { tool as listAssignments } from "./list_assignments.js";
import { tool as getAssignment } from "./get_assignment.js";
import { tool as getUpcoming } from "./get_upcoming.js";
import { tool as listAnnouncements } from "./list_announcements.js";
import { tool as getGrades } from "./get_grades.js";
import { tool as getPage } from "./get_page.js";
import { tool as listModules } from "./list_modules.js";
import { tool as downloadFile } from "./download_file.js";
import { tool as proposeCourseMapping } from "./propose_course_mapping.js";
import { tool as applyCourseMapping } from "./apply_course_mapping.js";
import { tool as syncCourse } from "./sync_course.js";
import { tool as syncStatus } from "./sync_status.js";
import { tool as searchMaterials } from "./search_materials.js";

export const allTools: ToolDef[] = [
  listCourses,
  listAssignments,
  getAssignment,
  getUpcoming,
  listAnnouncements,
  getGrades,
  getPage,
  listModules,
  downloadFile,
  proposeCourseMapping,
  applyCourseMapping,
  syncCourse,
  syncStatus,
  searchMaterials,
];
