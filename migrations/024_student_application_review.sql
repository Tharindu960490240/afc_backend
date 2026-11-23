-- Phase 5 step 2: the staff review. The day-4 alert is sent once per application.
ALTER TABLE student_applications ADD COLUMN day4_alerted_at TIMESTAMPTZ;
ALTER TABLE student_applications ADD COLUMN assessed_by BIGINT REFERENCES users(id);
