begin;

-- An authenticated owner may edit an AI action, which resets its review state.
-- Revoking its pending reminders and status links must still run with the
-- migration owner's privileges; browser roles intentionally cannot write
-- either of those tables directly.
alter function private.invalidate_ai_action_reminders() security definer;
alter function private.invalidate_ai_action_reminders() set search_path = '';

revoke all on function private.invalidate_ai_action_reminders()
from public, anon, authenticated;

commit;
