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
```

- `CANVAS_TOKEN` — the token from step 1. Never commit this file; `.env` is gitignored.
- `SCHOOL_ROOT` — the directory containing your `onn <N>` semester folders.
- `CURRENT_SEMESTER` — which `onn <N>` you're currently in (used as a fallback and for sync
  defaults). The server also derives each course's semester from its Canvas term name.

### 3. Install and build

```sh
npm install
npm run build
```

`npm run dev` runs the server directly from TypeScript (via `tsx`) without building, useful while
iterating.

### 4. Map your courses (first run)

Canvas course codes (`T-603-THYD`) need to be mapped to your local folder names (`thyd`) and a
semester number. Run the two mapping tools once (via Claude, see below, or the CLI):

1. `propose_course_mapping` — proposes `config/courses.json` plus a folder-rename plan
   (e.g. `POSH` → `posh`, `compilers` → `thyd` if it can't auto-match). It does **not** write
   anything.
2. Review the proposal, fill in any `overrides` for folders it couldn't match, then run
   `apply_course_mapping` with `confirm: true` to write `config/courses.json` and perform the
   renames. `config/courses.json` is also gitignored (it contains your real Canvas course ids).

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
| `list_courses` | Lists your courses (id, code, slug, name, term); current semester by default. |
| `list_assignments` | Lists assignments for a course, filterable by upcoming / past / missing / graded / all. |
| `get_assignment` | Full assignment detail: description as markdown, rubric, attachments, submission state. |
| `get_upcoming` | Merged timeline of assignments, quizzes, calendar events, and announcements due soon. |
| `list_announcements` | Recent course announcements as markdown. |
| `get_grades` | Your current score/grade in each course. |
| `get_page` | A single Canvas page's body, converted to markdown. |
| `list_modules` | A course's modules and their items (files, pages, assignments, links, …). |
| `download_file` | Downloads a single Canvas file to `<course>/canvas/files/...` (or a custom destination). |
| `propose_course_mapping` | Proposes `config/courses.json` and a folder-rename plan; does not write anything. |
| `apply_course_mapping` | Writes `config/courses.json` and performs the proposed folder renames (requires `confirm: true`). |
| `sync_course` | Downloads new/changed files, modules, and pages for a course (or `"all"`); supports `dry_run`. |
| `sync_status` | Shows manifest summary, last sync time, and stale-file count for a course. |
| `search_materials` | Searches files, module items, and pages by name; ranks matches and shows local sync path if already downloaded. |

## Sync folder layout

For a course with slug `thyd` in semester 5, `sync_course` writes into:

```
onn 5/thyd/canvas/
  files/<Canvas folder path>/<filename>       # mirrors Canvas's own folder structure
  pages/<page-url>.md                         # each Canvas Page as markdown
  .canvas-sync.json                           # manifest: file id -> local path, updated_at, size
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
npx canvas-mcp courses                # same as list_courses
npx canvas-mcp sync thyd              # sync one course by slug
npx canvas-mcp sync all               # sync every current-semester course
npx canvas-mcp sync thyd --dry-run    # report what would change, write nothing
```

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
  deletes local files. Check `sync_status` for a report of files present locally but no longer on
  Canvas, and remove them yourself if you want.
- **Icelandic filenames look mangled** — file and folder names keep Icelandic characters
  (`þæöðáéíóúý`); only path separators and control characters are stripped. If something still
  looks wrong, check your terminal/editor's encoding (should be UTF-8).
