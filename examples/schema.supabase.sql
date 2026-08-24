-- ═══════════════════════════════════════════════════════════════════════════
--  pinstage — example Supabase schema for the built-in supabaseAdapter
--
--  Storage convention: id TEXT PRIMARY KEY + data JSONB. Adapt names/paths to
--  your project (the adapter's `tables` option maps custom names).
--
--  Two helpers you must provide from YOUR auth model:
--    app_uid()   — the signed-in user's application uid (below: JWT sub)
--    is_admin()  — whether they are a platform admin (below: a stub)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION app_uid() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT auth.uid()::text;   -- or e.g. auth.jwt()->'app_metadata'->>'your_uid_claim'
$$;

CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT false;              -- wire to your own admin model
$$;

-- ─── Team roster (doubles as the @mention picker) ────────────────────────────

CREATE TABLE IF NOT EXISTS "mdTeamMembers" (
  id   TEXT PRIMARY KEY,     -- the member's app uid
  data JSONB NOT NULL DEFAULT '{}'   -- {email, name, role, status:'active', addedBy, addedAt:{_ts}}
);
ALTER TABLE "mdTeamMembers" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION is_md_team() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_admin() OR EXISTS (
    SELECT 1 FROM "mdTeamMembers" m
    WHERE m.id = app_uid() AND COALESCE(m.data->>'status', 'active') = 'active'
  );
$$;

CREATE POLICY "mdteam_read"   ON "mdTeamMembers" FOR SELECT TO authenticated USING (is_md_team());
CREATE POLICY "mdteam_insert" ON "mdTeamMembers" FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "mdteam_update" ON "mdTeamMembers" FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "mdteam_delete" ON "mdTeamMembers" FOR DELETE TO authenticated USING (is_admin());

-- ─── Comment threads (the pins) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "feedbackThreads" (
  id   TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'
);
ALTER TABLE "feedbackThreads" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fbthread_read" ON "feedbackThreads" FOR SELECT TO authenticated USING (is_md_team());
CREATE POLICY "fbthread_insert" ON "feedbackThreads" FOR INSERT TO authenticated
  WITH CHECK (is_md_team() AND data->'createdBy'->>'uid' = app_uid() AND data->>'status' = 'open');
CREATE POLICY "fbthread_update" ON "feedbackThreads" FOR UPDATE TO authenticated
  USING (is_md_team()) WITH CHECK (is_md_team());
CREATE POLICY "fbthread_delete" ON "feedbackThreads" FOR DELETE TO authenticated USING (is_admin());

-- ─── Comments ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "feedbackComments" (
  id   TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'
);
ALTER TABLE "feedbackComments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fbcomment_read" ON "feedbackComments" FOR SELECT TO authenticated USING (is_md_team());
CREATE POLICY "fbcomment_insert" ON "feedbackComments" FOR INSERT TO authenticated
  WITH CHECK (is_md_team() AND data->>'authorUid' = app_uid());
CREATE POLICY "fbcomment_update" ON "feedbackComments" FOR UPDATE TO authenticated
  USING (is_admin() OR data->>'authorUid' = app_uid())
  WITH CHECK (is_admin() OR data->>'authorUid' = app_uid());
CREATE POLICY "fbcomment_delete" ON "feedbackComments" FOR DELETE TO authenticated
  USING (is_admin() OR data->>'authorUid' = app_uid());

-- ─── @mention notifications (optional) ───────────────────────────────────────
--  If you already have a notifications table, allow team→team inserts of the
--  toolbar's mention type. Otherwise omit and skip adapter.notifyMentions.

-- CREATE POLICY "notifications_insert_md_team" ON notifications FOR INSERT TO authenticated
-- WITH CHECK (
--   is_md_team()
--   AND data->>'type' = 'md_toolbar_mention'
--   AND EXISTS (SELECT 1 FROM "mdTeamMembers" m WHERE m.id = data->>'userId')
-- );

-- ─── Screenshot attachments (optional) ───────────────────────────────────────
--  Screenshots upload to a PUBLIC storage bucket via the adapter's `storage`
--  option; the bucket needs an authenticated INSERT policy, e.g.:
--
-- CREATE POLICY "uploads_auth_insert" ON storage.objects FOR INSERT TO authenticated
--   WITH CHECK (bucket_id = 'uploads');
