-- Phase 1 and 2 changes (AFC Agent Management Developer Requirements)

-- Registration tasks: PRISMS -> compliance, ASQAnet -> CEO, website -> administration.
-- The old 30-day ASQAnet backstop is gone.
UPDATE onboarding_task_templates SET owner_role = 'compliance' WHERE type = 'PRISMS_ADD' AND owner_role = 'coe_admin';
UPDATE onboarding_task_templates SET owner_role = 'ceo'        WHERE type = 'ASQANET_START' AND owner_role = 'coe_admin';
UPDATE onboarding_task_templates SET legal_days = NULL;

-- Agreement wording: Schedule 1 commission rates, 1-year term, no sub-contracting.
-- Only the unedited sample wording (version 1) is replaced. A wording the college has edited is left alone.
UPDATE agreement_templates
SET body = replace(replace(replace(body,
  'and {{agency_name}}, business number {{business_number}}, of {{country}}, represented by {{agent_name}} ({{agent_email}}) (the Agent).',
  'and {{agency_name}} (trading as {{trading_name}}), business number {{business_number}}, of {{agent_address}}, {{country}}, phone {{agent_phone}}, represented by {{agent_name}}, {{agent_position}} ({{agent_email}}) (the Agent). Dated {{agreement_date}}.'),
  'in the amounts set out in the commission schedule that the College provides to the Agent. The College may change the schedule for future students by giving the Agent written notice.',
  'in the amounts set out in Schedule 1 of the Education Agent Agreement: 35% of the tuition fees paid for VET courses and 30% of the tuition fees paid for ELICOS courses. The College may change the schedule for future students by giving the Agent written notice.'),
  'The Agent is an independent contractor and is not an employee, partner or legal representative of the College.',
  'The Agent is an independent contractor and is not an employee, partner or legal representative of the College. The Agent must not sub-contract any of its obligations under this Agreement to another person or business.')
WHERE is_active AND version = 1 AND body LIKE '%commission schedule that the College provides to the Agent%';

UPDATE agreement_templates
SET body = replace(body, 'This Agreement starts on {{effective_date}} and continues until {{expiry_date}} unless it is ended earlier under clause 8.',
  'This Agreement starts on {{effective_date}} and continues for a term of one (1) year, until {{expiry_date}}, unless it is ended earlier under clause 8.')
WHERE is_active AND version = 1;

