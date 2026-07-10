-- ============================================================
-- Superclass Portal — Seed existing classrooms (halls) per centre.
-- Run AFTER scripts/migration-classrooms.sql.
-- Idempotent: matches centre by name (ILIKE) and upserts by (centre_id, name).
-- If you re-run it, capacities / room numbers are refreshed, nothing duplicates.
-- ============================================================

INSERT INTO classrooms (centre_id, room_no, name, capacity)
SELECT c.id, v.room_no, v.name, v.capacity
FROM (
  VALUES
    -- Laxmi Nagar Superclass
    ('Laxmi Nagar', 'CR1', 'Study Space',    110),
    ('Laxmi Nagar', 'CR2', 'Skill Zone',      34),
    ('Laxmi Nagar', 'CR3', 'Star Base',       75),
    ('Laxmi Nagar', 'CR4', 'Idea Hub',        70),
    ('Laxmi Nagar', 'CR5', 'Think Tank',      90),
    ('Laxmi Nagar', 'CR6', 'The Drive Room',  74),
    -- Pitampura Superclass
    ('Pitampura',   '101', 'Study Space',      36),
    ('Pitampura',   '102', 'Skill Zone',       36),
    ('Pitampura',   '103', 'Star Base',        36),
    -- Patna Superclass
    ('Patna',       '1',   'Study Space',      55),
    ('Patna',       '2',   'Skill Zone',       35),
    ('Patna',       '3',   'Star Base',        40),
    ('Patna',       '4',   'Idea Hub',         40),
    ('Patna',       '5',   'Think Tank',       45),
    ('Patna',       '6',   'The Drive Room',   40),
    -- Jaipur Superclass
    ('Jaipur',      '101', 'Study Space',      36),
    ('Jaipur',      '102', 'Skill Zone',       16),
    ('Jaipur',      '103', 'Star Base',        36),
    ('Jaipur',      '201', 'Idea Hub',         36),
    ('Jaipur',      '202', 'Think Tank',       40)
) AS v(centre_match, room_no, name, capacity)
JOIN centres c ON c.name ILIKE '%' || v.centre_match || '%'
ON CONFLICT (centre_id, name) DO UPDATE
  SET room_no = EXCLUDED.room_no,
      capacity = EXCLUDED.capacity;

-- Quick check: how many rooms per centre now.
-- SELECT c.name, count(*) FROM classrooms cr JOIN centres c ON c.id = cr.centre_id GROUP BY c.name ORDER BY c.name;
