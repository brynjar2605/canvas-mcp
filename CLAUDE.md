# canvas-mcp

Read-only MCP server + sync engine for RU Canvas. See PLAN.md for architecture and tool list — follow it.

## Rules
- TypeScript ESM, strict. Node ≥ 22 native `fetch`. No axios.
- Never log or print `CANVAS_TOKEN`. Never commit `.env` or `config/courses.json` with real ids (it's gitignored).
- Every Canvas list call goes through `client.getAll()` (Link-header pagination). Never hand-roll pagination.
- Sync never deletes anything under the user's folders. Only writes inside `<course>/canvas/`.
- Filenames: keep Icelandic characters (þ æ ö ð á é í ó ú ý), strip only path separators and control chars.
- Tools return compact, LLM-friendly text/JSON — no raw Canvas objects with 60 fields.
- Tests: vitest, mocked fetch, no network in tests.
- Run `npm run check` (tsc + vitest) before declaring a task done.
