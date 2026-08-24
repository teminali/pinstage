# Pinstage Agent Best Practices & Protocol

Whenever you connect to Pinstage or the user asks you to work with Pinstage feedback, you MUST initiate this 3-mode workflow:

## 1. Mode Initiation Flow
Ask the user which mode they want to run:
- 🔄 **Auto Dev Mode (Continuous Autonomous Loop)**:
  - Continuously poll for newly reported issues across the project.
  - When an issue appears:
    1. ⚡ **MANDATORY FIRST STEP**: Immediately call `pinstage_set_status({ id, status: "in_progress" })` BEFORE reading files or editing code so the live UI badge turns blue and pulses.
    2. Call `pinstage_get_context` to get component, DOM element, testId, selector, and source file.
    3. Evaluate if it is a Major Issue (Staging only).
    4. Implement and verify the fix.
    5. **Environment Branching**:
       - If reported on **Staging**: set status `deploying` ➔ run staging deployment script (e.g. `bash scripts/deploy-staging.sh`) ➔ set status `deployed` ➔ resolve with `pinstage_resolve`.
       - If reported on **Dev (localhost)**: set status `deployed` ➔ resolve with `pinstage_resolve` without triggering staging builds.
    6. Loop continuously until the user says stop/pause.
- 📦 **Fix Existing Issues & Stop**:
  - List all active open issues (`pinstage_list_issues`).
  - Fix issues sequentially (or batch staging fixes into a single deployment pass).
  - Resolve each and stop when complete.
- 🎯 **Fix Specific Issue(s)**:
  - Present the list of open issues with IDs and previews.
  - Let the user choose which issue(s) to fix.
  - Fix only those issues, deploy/verify, and resolve.

## 2. Major Staging Issue Safety Guard
For issues reported on **Staging**:
- ⚠️ **High Threshold Major Issues**: Database schema alterations, security/RLS changes, payment processing/billing logic alterations, or destructive data changes.
- **Protocol**: If an issue qualifies as Major, do NOT implement immediately. Post a reply `[⚠️ Flagged: Major change — awaiting developer review]`, present the implementation plan in chat, and wait for explicit developer approval.
- ✅ **Routine Issues** (UI, copy, styles, standard component bugs) are implemented directly without blocking.

## 3. Live Status Contract
Always maintain live transparent status:
`open` ➔ `in_progress` ➔ `deploying` ➔ `deployed` ➔ `resolved`.
