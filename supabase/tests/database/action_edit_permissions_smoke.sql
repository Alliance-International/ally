-- Rollback-only regression for browser action editing and manual creation.
begin;

insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values (
  '00000000-0000-4000-8000-00000000006a',
  'action-edit-a@example.invalid',
  '{"display_name":"Action Edit A"}'::jsonb,
  now(), now()
);

insert into public.action_items (
  id, user_id, title, assignee, assignee_email, source, status,
  start_date, deadline
) values (
  '20000000-0000-4000-8000-00000000006a',
  '00000000-0000-4000-8000-00000000006a',
  'Original AI task', 'Alice', 'alice@example.invalid', 'ai_generated',
  'not_started', current_date, current_date + 1
);

update public.action_items
set review_status = 'confirmed', reviewed_at = now()
where id = '20000000-0000-4000-8000-00000000006a';

insert into public.reminder_deliveries (
  id, action_item_id, request_owner_id, manual_idempotency_key,
  reminder_type, dedupe_key, status
) values (
  '60000000-0000-4000-8000-00000000006a',
  '20000000-0000-4000-8000-00000000006a',
  '00000000-0000-4000-8000-00000000006a',
  '30000000-0000-4000-8000-00000000006a',
  'manual_notification', 'action-edit-pending', 'pending'
);

insert into public.action_status_tokens (
  id, action_item_id, target_status, token_hash, sibling_group_id,
  expires_at
) values (
  '70000000-0000-4000-8000-00000000006a',
  '20000000-0000-4000-8000-00000000006a',
  'in_progress', decode(repeat('a', 64), 'hex'),
  '80000000-0000-4000-8000-00000000006a', now() + interval '1 day'
);

select set_config(
  'request.jwt.claim.sub', '00000000-0000-4000-8000-00000000006a', true
);
set local role authenticated;

-- Match the browser PATCH, including fields that did not change.
update public.action_items
set title = 'Edited AI task', assignee = 'Alice',
    assignee_email = 'alice@example.invalid', status = 'not_started',
    start_date = current_date, deadline = current_date + 2
where id = '20000000-0000-4000-8000-00000000006a'
  and user_id = '00000000-0000-4000-8000-00000000006a';

insert into public.action_items (
  user_id, title, assignee, assignee_email, start_date, deadline
) values (
  '00000000-0000-4000-8000-00000000006a',
  'New manual task', 'Alice', 'alice@example.invalid',
  current_date, current_date + 2
);

reset role;

do $test$
begin
  if (select review_status from public.action_items
      where id = '20000000-0000-4000-8000-00000000006a') <> 'pending'
    or (select reviewed_at from public.action_items
      where id = '20000000-0000-4000-8000-00000000006a') is not null then
    raise exception 'AI action edit did not reset review';
  end if;
  if (select status from public.reminder_deliveries
      where id = '60000000-0000-4000-8000-00000000006a') <> 'cancelled'
    or (select revoked_at from public.action_status_tokens
      where id = '70000000-0000-4000-8000-00000000006a') is null then
    raise exception 'AI action edit did not revoke unsent reminder work';
  end if;
  if not exists (
    select 1 from public.action_items
    where user_id = '00000000-0000-4000-8000-00000000006a'
      and title = 'New manual task'
      and source = 'manual'
      and review_status = 'confirmed'
  ) then
    raise exception 'Browser could not create a manual action';
  end if;
  if pg_catalog.has_table_privilege(
      'authenticated', 'public.reminder_deliveries', 'update'
    ) or pg_catalog.has_table_privilege(
      'authenticated', 'public.action_status_tokens', 'update'
    ) or pg_catalog.has_function_privilege(
      'authenticated', 'private.invalidate_ai_action_reminders()', 'execute'
    ) then
    raise exception 'Browser received reminder internals privileges';
  end if;
end;
$test$;

rollback;
