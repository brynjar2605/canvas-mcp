# canvas-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for Reykjavík University's Canvas
(`reykjavik.instructure.com`), plus a sync engine that mirrors course material (files, pages,
modules) to disk under `~/Documents/Tolvunarfraedi/onn <N>/<course>/canvas/`.

It never writes to Canvas — no submissions, no posting, no grade changes. It only reads, and only
writes files under your own `<course>/canvas/` folders.

See [`PLAN.md`](./PLAN.md) for the full architecture and design rationale.

## Setup

### 1. Generate a Canvas access token

1. Log into `https://reykjavik.instructure.com`.
2. Go to **Account** → **Settings**.
3. Scroll to **Approved Integrations** and click **+ New Access Token**.
4. Give it a purpose (e.g. "canvas-mcp"), leave the expiry blank or set one, click **Generate Token**.
5. Copy the token immediately — Canvas only shows it once.

### 2. Configure `.env`

```sh
cp .env.example .env
```

Edit `.env`:

```sh
CANVAS_BASE_URL=https://reykjavik.instructure.com
CANVAS_TOKEN=paste-your-token-here
SCHOOL_ROOT=/Users/you/Documents/Tolvunarfraedi
CURRENT_SEMESTER=5
FIRST_TERM=Haustönn 2024
```

- `CANVAS_TOKEN` — the token from step 1. Never commit this file; `.env` is gitignored.
- `SCHOOL_ROOT` — the directory containing your `onn <N>` semester folders.
- `FIRST_TERM` — the term (`Haustönn` = autumn, `Vorönn` = spring) you started your studies in,
  e.g. `Haustönn 2024`. Every `onn <N>` number in the product (course folders, `propose_course_mapping`,
  sync destinations) is counted from this term, two terms per year, 1-based — so `Haustönn 2024` is
  önn 1, `Vorönn 2025` is önn 2, and so on. Defaults to `Haustönn 2024` if unset. If courses are
  landing in the wrong `onn <N>` folder, this is almost always why.
- `CURRENT_SEMESTER` — still required to start the server today, but only actually *used* as a
  last-resort fallback (in `search_materials`, when a course's semester can't be derived from its
  Canvas term at all). Most setups never hit that fallback, since `FIRST_TERM` derives every
  current course's semester automatically — any integer value works if you're unsure.

### 3. Install and build

```sh
npm install
npm run build
```

`npm run dev` runs the server directly from TypeScript (via `tsx`) without building, useful while
iterating.

### 4. Rename your course folders (first run, optional)

**Every tool works without this step** — `list_courses`, `list_assignments`, `search_materials`, and
so on all resolve courses live against Canvas and need no local configuration. This step only
matters once you start syncing: `sync_course` writes to `onn <N>/<slug>/canvas`, so if your course
folder is called `compilers` instead of `thyd`, sync will create a brand-new `thyd/` folder next to
it instead of writing into your existing one.

Canvas course codes (`T-603-THYD`) need to be mapped to your local folder names (`thyd`) and a
semester number. Run the two mapping tools once (via Claude, see below, or the CLI):

1. `propose_course_mapping` — proposes a folder-rename plan (e.g. `POSH` → `posh`, `compilers` →
   `thyd` if it can't auto-match). It does **not** write anything.
2. Review the proposal, fill in any `overrides` for folders it couldn't match, then run
   `apply_course_mapping` with `confirm: true` to rename the folders and write `config/courses.json`
   (which records the id → slug/semester mapping so sync keeps writing to the right place even if a
   course's derived semester ever changes). `config/courses.json` is gitignored — it contains your
   real Canvas course ids — and, again, entirely optional: skip this step and every read-only tool
   still works, you'll just end up with an extra `thyd/` folder once you sync instead of reusing
   `compilers/`.

## Register with Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "node",
      "args": ["/absolute/path/to/canvas-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. The token and other config are read from `.env` at the project root, not
from this file.

## Register with Claude Code

```sh
claude mcp add canvas -- node /absolute/path/to/canvas-mcp/dist/index.js
```

## Tools

| Tool | Description |
|---|---|
| `list_courses` | Lists your courses (id, code, slug, name, term, önn); current semester by default. |
| `list_assignments` | Assignments for one course (or all current courses): due date, points, submitted/graded state, score, and the id `get_assignment` needs. Filterable by upcoming / past / missing / graded / all. No lectures or calendar events — use `get_upcoming` for those. |
| `get_assignment` | Full assignment detail: description as markdown, rubric, attachments (with file ids), submission state. |
| `get_upcoming` | Timeline for the next N days across all current courses (or one, via `course`): deadlines first each day, then a compact lectures/dæmatímar line per event. Not a substitute for `list_assignments` when you need scores or full descriptions. |
| `export_timeline` | Structured JSON export of the timeline (deadlines, lectures, labs) with a stable `key` per row, for syncing into external calendars/Notion. Supports a past-inclusive window via `start_offset_days`. |
| `list_announcements` | Recent course announcements as markdown, newest first; bodies trimmed to 600 chars by default (`full: true` for the rest). |
| `get_grades` | Your computed grade per course (RU hides Canvas's own course totals from students) — for one course or all current ones. |
| `get_page` | A single Canvas page's body, converted to markdown. Needs the page's `page_url` slug from `search_materials` or `list_modules` — not its title. |
| `list_modules` | A course's modules and their items (files, pages, assignments, links, …), with ids for `download_file` / `get_page` / `get_assignment`. |
| `download_file` | Downloads a single Canvas file to `<course>/canvas/files/...` (or a custom destination). |
| `propose_course_mapping` | Proposes a folder-rename plan for this semester's courses; does not write anything. |
| `apply_course_mapping` | Renames the proposed folders on disk and writes `config/courses.json` (requires `confirm: true`). |
| `sync_course` | Downloads new/changed files, modules, and pages for a course (or `"all"`); supports `dry_run`. |
| `sync_status` | Shows last sync time, tracked file/page counts, manifest size, and folder path for a course. |
| `search_materials` | Searches files, module items, and pages by name; ranks matches and shows local sync path if already downloaded. |

## Sync folder layout

For a course with slug `thyd` in semester 5, `sync_course` writes into:

```
onn 5/thyd/canvas/
  files/<Canvas folder path>/<filename>        # mirrors Canvas's own folder structure
  pages/<page-url>.md                          # each Canvas Page as markdown, named by its stable url slug
  modules/03 - Lexical Analysis/                # module order preserved
    01 - Chapter 3.pdf                           # symlink into files/ (copy if symlinks fail)
    links.md                                     # any ExternalUrl items in the module
  .canvas-sync.json                            # manifest: file id -> local path, updated_at, size
```

Sync is idempotent and additive:
- Unchanged files (same id, same `updated_at`/size) are skipped.
- Changed files are re-downloaded in place.
- Files removed on Canvas are **left on disk** and reported, never deleted.
- Nothing outside `<course>/canvas/` is ever touched.

## CLI usage

The same code paths are exposed as a small CLI, useful for scripting or a cron job without going
through an LLM client:

```sh
npx canvas-mcp courses                          # same as list_courses
npx canvas-mcp courses --include-past           # include past semesters too

npx canvas-mcp mapping                          # same as propose_course_mapping
npx canvas-mcp mapping --semester 5             # propose for a specific önn
npx canvas-mcp mapping --override compilers=thyd --apply
                                                 # apply with an override (same as apply_course_mapping)

npx canvas-mcp sync thyd                        # sync one course by slug
npx canvas-mcp sync all                         # sync every current-semester course
npx canvas-mcp sync thyd --dry-run              # report what would change, write nothing

npx canvas-mcp status                           # same as sync_status, all current courses
npx canvas-mcp status thyd                      # sync status for one course

npx canvas-mcp tool list_courses                # run any MCP tool directly by name
npx canvas-mcp tool get_assignment '{"course":"thyd","assignment_id":123}'
npx canvas-mcp tools                            # list every tool name — description

npx canvas-mcp help                             # usage (also --help / -h)
```

Arguments are validated through the same zod schema each MCP tool uses, so e.g. `--semester abc`
fails with a clear message instead of silently doing the wrong thing.

## Troubleshooting

- **"CANVAS_TOKEN is missing" / server exits immediately** — `.env` isn't set up, or the MCP
  client isn't picking it up. Confirm `.env` exists at the project root (next to `package.json`)
  and contains `CANVAS_TOKEN`.
- **401 Unauthorized / "Canvas rejected the request as unauthorized"** — the token is missing,
  expired, or was revoked. Generate a new one (see Setup step 1) and update `.env`.
- **Rate limited / requests slowing down** — Canvas returns `X-Rate-Limit-Remaining`; the client
  backs off automatically below a threshold and retries on `429`/5xx. If you see persistent
  failures, wait a few minutes — Canvas's per-account rate limit resets over time.
- **A course is missing from `list_courses`** — only courses whose `course_code` matches
  `X-NNN-CODE` (e.g. `T-603-THYD`) are treated as real courses; announcement/video shell "courses"
  are filtered out. Only the current (highest-derived) semester is shown by default — pass
  `include_past: true` to see older ones.
- **Sync didn't remove a file that was deleted on Canvas** — this is intentional; sync never
  deletes local files. Run `sync_course` again (even with `dry_run: true`) for a
  "removed-on-canvas" list of files present locally but no longer on Canvas, and remove them
  yourself if you want — `sync_status` reports the manifest summary (last sync time, file/page
  counts, folder path) but does not compare against Canvas itself.
- **Courses land in the wrong `onn <N>` folder** — check `FIRST_TERM`; every semester number is
  counted from that term, two terms per year (`Haustönn`, `Vorönn`).
- **Icelandic filenames look mangled** — file and folder names keep Icelandic characters
  (`þæöðáéíóúý`); only path separators and control characters are stripped. If something still
  looks wrong, check your terminal/editor's encoding (should be UTF-8).
