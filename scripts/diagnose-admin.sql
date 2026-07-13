-- ============================================================
-- Admin data health check (READ-ONLY — nothing is changed).
-- Run each block in the Supabase SQL Editor and eyeball the results.
-- ============================================================

-- 1) Every faculty and the subjects mapped to them (comma-separated).
--    Spot anyone whose subjects look wrong or empty.
SELECT u.full_name,
       COALESCE(c.name, '—')                              AS centre,
       count(fs.subject_id)                               AS subject_count,
       string_agg(s.name, ', ' ORDER BY s.name)           AS subjects
FROM app_users u
LEFT JOIN faculty_subjects fs ON fs.faculty_id = u.id
LEFT JOIN subjects s          ON s.id = fs.subject_id
LEFT JOIN centres c           ON c.id = u.centre_id
WHERE 'faculty' = ANY(u.roles) OR u.role = 'faculty'
GROUP BY u.full_name, c.name
ORDER BY subject_count ASC, u.full_name;   -- 0-subject faculty float to the top

-- 2) Faculty NOT linked to any centre (won't show in Batch Scheduler dropdown).
SELECT u.full_name, u.email
FROM app_users u
WHERE ('faculty' = ANY(u.roles) OR u.role = 'faculty')
  AND u.centre_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM user_centres uc WHERE uc.user_id = u.id);

-- 3) Syllabus overview: subjects & chapters per program (spot leftover 0-chapter dupes).
SELECT p.name AS program,
       count(DISTINCT s.id)  AS subjects,
       count(ch.id)          AS chapters
FROM programs p
LEFT JOIN subjects s ON s.program_id = p.id
LEFT JOIN chapters ch ON ch.subject_id = s.id
GROUP BY p.name ORDER BY p.name;

-- 4) Subjects with ZERO chapters (likely old duplicates to merge/remove, or not-yet-imported).
SELECT p.name AS program, s.name AS subject
FROM subjects s JOIN programs p ON p.id = s.program_id
WHERE NOT EXISTS (SELECT 1 FROM chapters ch WHERE ch.subject_id = s.id)
ORDER BY p.name, s.name;

-- 5) Role counts (sanity check of who exists).
SELECT unnest(roles) AS role, count(*) FROM app_users GROUP BY 1 ORDER BY 2 DESC;

-- 6) Duplicate programs by similar name (case-insensitive first word) — spot leftovers.
SELECT name FROM programs ORDER BY name;
