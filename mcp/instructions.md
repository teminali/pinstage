# Pinstage MCP Instructions for AI Agents (Claude Code / Antigravity / Codex)

================================================================================
PINSTAGE AUTONOMOUS DEV & VERIFICATION PROTOCOL (V2.0.0 LOCKED CONTRACT):
1. SELECT SAFE ISSUE:
   • Pick a [SAFE TO CLAIM - NO CONFLICT] issue (marked with green check).
   • Do NOT pick [CONFLICT LOCK] issues while another agent is modifying the target file.
2. MANDATORY FIRST TOOL CALL:
   • Immediately call `pinstage_set_status({ id: "<ID>", status: "in_progress" })` BEFORE reading files or writing code.
   • This claims the file lock and activates the live circular progress timer on the user screen.
3. SURGICAL FIX & NON-REGRESSION GUARANTEE:
   • Locate target code via `pinstage_get_context` and searchKeys.
   • Make surgical, precise edits. Do NOT break existing features, layouts, or translations.
   • Preserve all existing types, props, and handlers. Never introduce regressions.
4. RIGOROUS END-TO-END VERIFICATION:
   • Always cross-check, double-check, and verify before moving to another issue.
   • Run type check (e.g. `tsc --noEmit`) and build checks to confirm zero errors.
5. DEPLOY & RESOLUTION LIFECYCLE:
   • Staging: status `deploying` -> run deploy script -> status `deployed` -> `pinstage_resolve`.
   • Dev: status `deployed` -> `pinstage_resolve`.
================================================================================


## Tool Reference

- `pinstage_list_issues({ status, project })`: Lists all issues with conflict-safety tags and live agent claims.
- `pinstage_set_status({ id, status, note })`: MANDATORY STEP 1. Updates live issue status (`in_progress`, `deploying`, `deployed`, `resolved`, `open`).
- `pinstage_get_context({ id })`: Returns target DOM element, React/Vue component, source file, selector, and searchKeys.
- `pinstage_get_issue({ id })`: Returns full comment thread, attached screenshot URLs, and diagnostics.
- `pinstage_reply({ id, text })`: Adds a comment note without changing status.
- `pinstage_resolve({ id, note })`: Marks the issue resolved after full verification.
- `pinstage_reopen({ id, note })`: Reopens an issue if further fixes are needed.
