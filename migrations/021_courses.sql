-- Phase 5 groundwork: campuses and the course catalogue, taken from the AFC Application for Enrolment Form (International) V3.1.
-- CRICOS codes, durations, fees and entry requirements are not on the form; they stay empty until AFC supplies them.
-- Courses are switched off, never deleted.
CREATE TABLE campuses (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  sort_order  INT NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE courses (
  id               BIGSERIAL PRIMARY KEY,
  code             TEXT,
  name             TEXT NOT NULL,
  specialisation   TEXT,
  course_type      TEXT NOT NULL CHECK (course_type IN ('VET','ELICOS')),
  cricos_code      TEXT,
  duration_weeks   INT CHECK (duration_weeks IS NULL OR duration_weeks > 0),
  tuition_fee      NUMERIC(10,2) CHECK (tuition_fee IS NULL OR tuition_fee >= 0),
  entry_requirements TEXT,
  sort_order       INT NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX courses_code_uq ON courses (lower(code), lower(coalesce(specialisation, ''))) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX courses_name_uq ON courses (lower(name), lower(coalesce(specialisation, ''))) WHERE code IS NULL;

CREATE TABLE course_offerings (
  course_id  BIGINT NOT NULL REFERENCES courses(id),
  campus_id  BIGINT NOT NULL REFERENCES campuses(id),
  PRIMARY KEY (course_id, campus_id)
);

INSERT INTO campuses (name, sort_order) VALUES ('Launceston', 1), ('Melbourne', 2);

INSERT INTO courses (code, name, specialisation, course_type, sort_order) VALUES
  ('BSB60420', 'Advanced Diploma of Leadership and Management', NULL, 'VET', 1),
  ('BSB50420', 'Diploma of Leadership and Management', NULL, 'VET', 2),
  ('CHC62015', 'Advanced Diploma of Community Sector Management', NULL, 'VET', 3),
  ('CHC52025', 'Diploma of Community Services', NULL, 'VET', 4),
  ('CHC43015', 'Certificate IV in Ageing Support', NULL, 'VET', 5),
  ('AHC51422', 'Diploma of Agribusiness Management', NULL, 'VET', 6),
  ('SIT60322', 'Advanced Diploma of Hospitality Management', NULL, 'VET', 7),
  ('SIT50422', 'Diploma of Hospitality Management', NULL, 'VET', 8),
  ('SIT40521', 'Certificate IV in Kitchen Management', NULL, 'VET', 9),
  ('ICT60220', 'Advanced Diploma of Information Technology', 'Telecommunications Network Engineering Specialisation', 'VET', 10),
  ('ICT60220', 'Advanced Diploma of Information Technology', 'Cyber security specialisation', 'VET', 11),
  ('ICT50220', 'Diploma of Information Technology', NULL, 'VET', 12),
  ('RII60520', 'Advanced Diploma of Civil Construction Design', NULL, 'VET', 13);
INSERT INTO courses (code, name, specialisation, course_type, sort_order) VALUES (NULL, 'General English - ELICOS', NULL, 'ELICOS', 14);

-- Launceston: the twelve VET courses. Melbourne: the same twelve, plus General English (ELICOS) and RII60520.
INSERT INTO course_offerings (course_id, campus_id)
  SELECT c.id, (SELECT id FROM campuses WHERE name = 'Launceston') FROM courses c WHERE c.sort_order <= 12;
INSERT INTO course_offerings (course_id, campus_id)
  SELECT c.id, (SELECT id FROM campuses WHERE name = 'Melbourne') FROM courses c;
