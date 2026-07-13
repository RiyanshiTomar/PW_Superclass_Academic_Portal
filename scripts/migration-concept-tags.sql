-- ============================================================
-- Superclass Portal — Concept Tags / Syllabus Master (ADDITIVE, idempotent).
-- Run in the Supabase SQL Editor. Safe to re-run.
--
-- Adds the master syllabus under existing programs/subjects:
--   programs → subjects → chapters → topics
-- Admin curates this; it's the source of truth used to validate that a
-- batch's planner (and later, test scheduler) covers every subject/chapter,
-- and to measure chapter completion (topics taught / total topics).
-- ============================================================

-- CHAPTERS — ordered chapters within a subject.
CREATE TABLE IF NOT EXISTS chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sequence_no INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subject_id, name)
);
CREATE INDEX IF NOT EXISTS idx_chapters_subject ON chapters(subject_id);

-- TOPICS — the granular "concept tags" within a chapter.
CREATE TABLE IF NOT EXISTS topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sequence_no INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chapter_id, name)
);
CREATE INDEX IF NOT EXISTS idx_topics_chapter ON topics(chapter_id);

-- ------------------------------------------------------------
-- RLS — keep DISABLED to match every existing table (app-level role checks).
-- ------------------------------------------------------------
ALTER TABLE chapters DISABLE ROW LEVEL SECURITY;
ALTER TABLE topics   DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read chapters" ON chapters;
DROP POLICY IF EXISTS "Authenticated write chapters" ON chapters;
CREATE POLICY "Authenticated read chapters" ON chapters FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write chapters" ON chapters FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated read topics" ON topics;
DROP POLICY IF EXISTS "Authenticated write topics" ON topics;
CREATE POLICY "Authenticated read topics" ON topics FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write topics" ON topics FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- DONE. New tables: chapters, topics.
-- ============================================================
