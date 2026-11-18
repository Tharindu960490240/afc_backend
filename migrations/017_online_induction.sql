-- Phase 3 (requirements document): self-paced induction modules, policy acknowledgement (immutable ASQA evidence),
-- marketing materials with staff approval, and the induction gate.

-- ------------------------------------------------------------ induction modules (the six required topics)
CREATE TABLE induction_modules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position    INT          NOT NULL UNIQUE,
  key         VARCHAR(40)  NOT NULL UNIQUE,
  title       VARCHAR(160) NOT NULL,
  body        TEXT         NOT NULL,
  version     INT          NOT NULL DEFAULT 1,
  active      BOOLEAN      NOT NULL DEFAULT true,
  updated_by  BIGINT,  -- no foreign key: configuration rows must survive a users truncate in tests
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE induction_completions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID   NOT NULL REFERENCES agents(id),
  module_id       UUID   NOT NULL REFERENCES induction_modules(id),
  module_version  INT    NOT NULL,
  user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip              TEXT,
  user_agent      TEXT,
  UNIQUE (agent_id, module_id)
);
CREATE INDEX induction_completions_agent_idx ON induction_completions (agent_id);

-- ------------------------------------------------------------ policies and procedures (PP) and acknowledgements
CREATE TABLE pp_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version       VARCHAR(40)  NOT NULL UNIQUE,
  title         VARCHAR(200) NOT NULL,
  body          TEXT         NOT NULL,
  document_url  TEXT,
  is_current    BOOLEAN      NOT NULL DEFAULT false,
  created_by    BIGINT,  -- no foreign key (see induction_modules)
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pp_versions_one_current ON pp_versions (is_current) WHERE is_current;

CREATE TABLE pp_acknowledgements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID   NOT NULL REFERENCES agents(id),
  user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  pp_version_id   UUID   NOT NULL REFERENCES pp_versions(id),
  pp_version      VARCHAR(40) NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- always the server clock: it cannot be backdated
  ip              TEXT,
  user_agent      TEXT,
  UNIQUE (agent_id, pp_version_id)
);
CREATE INDEX pp_acknowledgements_agent_idx ON pp_acknowledgements (agent_id);

-- completions and acknowledgements are evidence: no edits, no deletes
CREATE FUNCTION immutable_evidence_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'This record is evidence and cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER induction_completions_guard BEFORE UPDATE OR DELETE ON induction_completions FOR EACH ROW EXECUTE FUNCTION immutable_evidence_guard();
CREATE TRIGGER pp_acknowledgements_guard BEFORE UPDATE OR DELETE ON pp_acknowledgements FOR EACH ROW EXECUTE FUNCTION immutable_evidence_guard();

-- ------------------------------------------------------------ marketing materials (hidden until staff approve)
ALTER TABLE coms_files DROP CONSTRAINT coms_files_kind_check;
ALTER TABLE coms_files ADD CONSTRAINT coms_files_kind_check
  CHECK (kind IN ('referee', 'declaration', 'task_evidence', 'other', 'agent_document', 'marketing_material'));

CREATE TABLE marketing_materials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        VARCHAR(200) NOT NULL,
  description  TEXT,
  category     VARCHAR(30)  NOT NULL DEFAULT 'brochure' CHECK (category IN ('brochure', 'fees', 'policy', 'course_guide', 'other')),
  version      VARCHAR(40)  NOT NULL DEFAULT '1.0',
  file_id      UUID NOT NULL REFERENCES coms_files(id),
  status       VARCHAR(12)  NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  uploaded_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_at  TIMESTAMPTZ,
  retired_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- who was told about an approved material, and when (the 24-hour notification duty)
CREATE TABLE marketing_material_deliveries (
  material_id UUID NOT NULL REFERENCES marketing_materials(id),
  agent_id    UUID NOT NULL REFERENCES agents(id),
  sent_to     TEXT,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, agent_id)
);

-- ------------------------------------------------------------ starter content (AFC must review before agents use it)
INSERT INTO induction_modules (position, key, title, body) VALUES
(1, 'courses', 'AFC courses and campuses',
$$STARTER CONTENT: AFC must review and replace this with its current course and campus details before agents are onboarded.

What you will learn
- Which courses AFC offers, at which campuses and in which study modes.
- The entry requirements for each course, including English language and any prior study.
- Which courses are registered on CRICOS and which are delivered to domestic students only.

Why it matters
You may only describe the courses, campuses and outcomes that AFC has approved in its current marketing materials. Do not promise a course outcome, a job, a visa or permanent residency.

Where to look
Download the current approved course guides from the Marketing materials page of this portal.$$),
(2, 'fees', 'Fees and refunds policy',
$$STARTER CONTENT: AFC must review and replace this with its current fee schedule and refund policy before agents are onboarded.

What you will learn
- How tuition fees, enrolment fees and materials fees are charged and when they fall due.
- When a student is entitled to a refund, and how a refund is requested and paid.
- That the written agreement between the student and AFC sets out the fees and refund terms.

Why it matters
Students must be given accurate fee information before they enrol. Never quote a fee that is not in AFC's current fee schedule, and never tell a student a fee is refundable unless the refund policy says so.$$),
(3, 'attendance', 'Attendance and course progress monitoring',
$$STARTER CONTENT: AFC must review and replace this with its current attendance and progress requirements.

What you will learn
- International students on a student visa must attend classes and make satisfactory course progress.
- AFC monitors attendance and progress and must act, and may report to the Department of Home Affairs, when a student falls short.
- Students who are at risk are contacted early and offered support.

Why it matters
You must explain these requirements to every student you recruit before they enrol, so they understand that their visa can be affected.$$),
(4, 'complaints', 'Complaints and appeals',
$$STARTER CONTENT: AFC must review and replace this with its current complaints and appeals procedure.

What you will learn
- Students can complain about AFC, about you as an agent, or about a decision, and can appeal decisions.
- Complaints are handled fairly, in writing and within the time set by AFC's procedure.
- A student can take a complaint to an external body if it is not resolved internally.

Why it matters
You must tell students how to complain and must pass any complaint you receive to AFC straight away. You must not discourage a student from complaining.$$),
(5, 'preenrolment', 'The pre-enrolment pack',
$$STARTER CONTENT: AFC must review and replace this with the contents of its current pre-enrolment pack.

What you will learn
- Before a student accepts an offer, they must be given AFC's pre-enrolment information (the pack), covering the course, fees, refunds, support services and their rights and responsibilities.
- You must make sure each student you recruit has received the pack and has had time to read it.

Why it matters
A student who has not been given the pre-enrolment pack has not been properly informed. This is a compliance requirement, not an option.$$),
(6, 'esos', 'The ESOS Act and the National Code of Practice 2018',
$$STARTER CONTENT: AFC must review and replace this with the sections of the ESOS Act and the National Code that apply to its agents.

What you will learn
- The Education Services for Overseas Students (ESOS) Act 2000 and the National Code of Practice for Providers of Education and Training to Overseas Students 2018 protect international students.
- Under the National Code, AFC must only work with reputable agents, must have a written agreement with each agent, and must monitor the agent's performance (Standard 4).
- You must act honestly and ethically, give accurate information, and must not engage in unauthorised advice, for example migration advice if you are not registered to give it.

Why it matters
Your understanding of these obligations is part of AFC's evidence to the regulator that you were properly briefed.$$);

INSERT INTO pp_versions (version, title, body, is_current) VALUES
('1.0', 'AFC agent policies and procedures',
$$STARTER CONTENT: AFC must replace this with its current approved Policies and Procedures (PP) document before agents are onboarded.

By acknowledging, you confirm that you have read and understood AFC's policies and procedures for agents, including:
- the Education Agent Agreement and the Code of Ethics,
- how to give accurate information to students,
- the pre-enrolment pack requirement,
- complaints and appeals,
- AFC's privacy requirements, and
- your obligation to follow the ESOS Act 2000 and the National Code of Practice 2018.

Your acknowledgement is recorded with the date and time, your IP address and this version of the policies. It cannot be changed afterwards.$$, true);
