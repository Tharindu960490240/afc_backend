-- Course list published by AFC on 24 November 2026: CRICOS codes, durations, tuition and material fees, entry requirements.
-- Fees are in AUD and exclude the AUD 250 enrolment fee that applies to every qualification. Fees and durations may change; staff edit them on the Courses screen.
ALTER TABLE courses ADD COLUMN material_fee NUMERIC(10,2) CHECK (material_fee IS NULL OR material_fee >= 0);
ALTER TABLE courses ADD COLUMN enrolment_fee NUMERIC(10,2) CHECK (enrolment_fee IS NULL OR enrolment_fee >= 0);

-- ICT60220 is offered in three versions that share one CRICOS code. The form listed two; the third has no specialisation.
INSERT INTO courses (code, name, specialisation, course_type, sort_order) VALUES ('ICT60220', 'Advanced Diploma of Information Technology', NULL, 'VET', 0);
INSERT INTO course_offerings (course_id, campus_id)
  SELECT c.id, k.id FROM courses c, campuses k WHERE c.code = 'ICT60220' AND c.specialisation IS NULL;
UPDATE courses SET specialisation = 'Cyber Security Specialisation' WHERE code = 'ICT60220' AND specialisation ILIKE 'Cyber security%';

WITH d (code, spec, cricos, weeks, tuition, material, academic, ord) AS (VALUES
  ('BSB50420', NULL, '104415A', 52, 17800, 400, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 1),
  ('BSB60420', NULL, '108185M', 52, 11800, 400, 'A Diploma or Advanced Diploma from the BSB Training Package, such as BSB50420', 2),
  ('ICT50220', NULL, '108184A', 65, 17250, 500, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 3),
  ('ICT60220', NULL, '108186K', 78, 20800, 500, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 4),
  ('ICT60220', 'Telecommunications Network Engineering Specialisation', '108186K', 104, 24850, 600, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 5),
  ('ICT60220', 'Cyber Security Specialisation', '108186K', 104, 24850, 600, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 6),
  ('SIT40521', NULL, '110636D', 78, 21000, 1750, 'Australian Year 12 or equivalent, or AQF Certificate III or above', 7),
  ('SIT50422', NULL, '111929E', 65, 15000, 1500, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 8),
  ('SIT60322', NULL, '118106K', 104, 26000, 1500, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 9),
  ('CHC43015', NULL, '119917M', 52, 14000, 1000, 'Australian Year 12 or equivalent, or AQF Certificate III or above', 10),
  ('CHC52025', NULL, '118794C', 72, 24000, 1450, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 11),
  ('CHC62015', NULL, '111025A', 71, 18000, 600, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 12),
  ('AHC51422', NULL, '111931M', 52, 14000, 1000, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 13),
  ('RII60520', NULL, '114858B', 104, 30000, 1000, 'Australian Year 12 or equivalent, or AQF Certificate IV or above', 14))
UPDATE courses c SET cricos_code = d.cricos, duration_weeks = d.weeks, tuition_fee = d.tuition, material_fee = d.material, enrolment_fee = 250,
       entry_requirements = d.academic || '. Students must be at least 18 at the start of the course, meet the college''s English language requirement, and complete a course entry assessment (LLND) before starting.',
       sort_order = d.ord, updated_at = now()
FROM d WHERE c.code = d.code AND lower(coalesce(c.specialisation, '')) = lower(coalesce(d.spec, ''));

-- General English (ELICOS): fees are not published; no IELTS requirement when studied on its own.
UPDATE courses SET cricos_code = '116758A', duration_weeks = 70, sort_order = 15,
       entry_requirements = 'No IELTS requirement when studied on its own; the level is set by the college''s assessment at enrolment. Students must be at least 18 at the start of the course and complete a course entry assessment (LLND) before starting.'
WHERE course_type = 'ELICOS';
