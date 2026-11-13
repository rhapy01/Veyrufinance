DROP INDEX IF EXISTS trezu_workspace_members_user_unique;
DROP INDEX IF EXISTS trezu_employees_user_id_unique;

CREATE INDEX IF NOT EXISTS trezu_employees_user_active_idx
  ON trezu_employees (user_id, active);

INSERT INTO trezu_workspace_members (workspace_id, user_id, role)
SELECT employee.workspace_id, employee.user_id, 'employee'::trezu_workspace_role
FROM trezu_employees AS employee
WHERE employee.user_id IS NOT NULL AND employee.active = true
ON CONFLICT (workspace_id, user_id) DO NOTHING;
