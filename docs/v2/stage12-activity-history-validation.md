# Stage 12 activity-history live validation

Validated on 2026-09-03 from live local files and the built server.

- `make build` produced `bin/omo-webchat`.
- The server ran with a temporary state directory and
  `--root /Volumes/storage/workspace/omo-webchat-v2h`.
- A temporary in-place copy of the live-probed project session
  `01a05dff-ce50-7e6e-afd8-584465582016` was opened through the workspace
  session catalog. Its header cwd was changed only in the temporary copy so
  the root-scoped catalog could select it.
- The worktree temporarily linked the live-probed
  `/Volumes/storage/workspace/cli-webchat/.omo/senpi-task` store at the
  expected cwd-relative location.
- The authenticated, catalog-scoped activity endpoint returned 108 historical
  task rows and 16 DAG runs. Task `st_01a06790` included non-empty `task_id`,
  `name`, `status`, `created_at`, and `updated_at`; the task digest contained
  the same 108 rows. The DAG digest correctly omitted the 16 terminal runs,
  matching the stage-8 digest rule, while the full history retained them.
- Vitest rendered the hydrated task and DAG through the existing
  `ActivityShelf` component.
- The server process, temporary state, cookie, session copy, and task-store
  link were removed after the assertions. Follow-up filesystem and process
  checks confirmed cleanup.
