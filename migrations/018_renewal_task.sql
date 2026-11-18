-- Phase 2: a renewal task is created at month 11 of each agreement (client requirements, agreement lifecycle)
ALTER TABLE coms_tasks DROP CONSTRAINT coms_tasks_type_check;
ALTER TABLE coms_tasks ADD CONSTRAINT coms_tasks_type_check CHECK (type IN (
  'PRISMS_ADD','PRISMS_UPDATE','PRISMS_REMOVE','ASQANET_START','ASQANET_END',
  'WEBSITE_ADD','WEBSITE_REMOVE','S21B_REQUEST','INDUCTION','COMMISSION_REPORT','RENEWAL','GENERAL'));
CREATE UNIQUE INDEX coms_tasks_renewal_uq ON coms_tasks (agreement_id) WHERE type = 'RENEWAL' AND deleted_at IS NULL;
