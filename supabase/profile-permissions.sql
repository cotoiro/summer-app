-- 家族プロフィール・PIN・お手伝い承認を追加する更新SQL
-- Supabase SQL Editor で1回だけ実行してください。

alter table public.family_members add column if not exists pin_hash text;
alter table public.family_members add column if not exists pin_set_at timestamptz;
alter table public.family_members add column if not exists permissions jsonb not null default '{}'::jsonb;

update public.family_members
set permissions = case profile_key
  when 'parent' then '{"manage_all":true,"manage_study":true,"complete_study":true}'::jsonb
  when 'child1' then '{"manage_study":true,"complete_study":true}'::jsonb
  else '{"manage_study":false,"complete_study":false}'::jsonb
end
where permissions = '{}'::jsonb;

create table if not exists public.family_profile_sessions (
  token uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  profile_key text not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '365 days')
);

create table if not exists public.help_requests (
  family_id uuid not null references public.families(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  member_key text not null,
  requested_on date not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  primary key (task_id, member_key, requested_on)
);

create table if not exists public.family_activity_log (
  id bigint generated always as identity primary key,
  family_id uuid not null references public.families(id) on delete cascade,
  profile_key text not null,
  action text not null,
  target_type text not null,
  target_key text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.family_profile_sessions enable row level security;
alter table public.help_requests enable row level security;
alter table public.family_activity_log enable row level security;

drop policy if exists "family members manage profiles" on public.family_members;
create policy "family members read profiles" on public.family_members
for select using (public.can_access_family(family_id));

drop policy if exists "family members manage completions" on public.task_completions;
create policy "family members read completions" on public.task_completions
for select using (public.can_access_family(family_id));

drop policy if exists "family members manage tasks" on public.tasks;
create policy "family members read tasks" on public.tasks for select using (public.can_access_family(family_id));
create policy "bootstrap tasks before pins" on public.tasks for all
using (public.can_access_family(family_id) and not exists(select 1 from family_members m where m.family_id=tasks.family_id and m.pin_set_at is not null))
with check (public.can_access_family(family_id) and not exists(select 1 from family_members m where m.family_id=tasks.family_id and m.pin_set_at is not null));

drop policy if exists "family members manage daily notes" on public.daily_notes;
create policy "family members read daily notes" on public.daily_notes for select using (public.can_access_family(family_id));
create policy "bootstrap notes before pins" on public.daily_notes for all
using (public.can_access_family(family_id) and not exists(select 1 from family_members m where m.family_id=daily_notes.family_id and m.pin_set_at is not null))
with check (public.can_access_family(family_id) and not exists(select 1 from family_members m where m.family_id=daily_notes.family_id and m.pin_set_at is not null));

drop policy if exists "family members manage events" on public.calendar_events;
create policy "family members read events" on public.calendar_events for select using (public.can_access_family(family_id));
create policy "bootstrap events before pins" on public.calendar_events for all
using (public.can_access_family(family_id) and not exists(select 1 from family_members m where m.family_id=calendar_events.family_id and m.pin_set_at is not null))
with check (public.can_access_family(family_id) and not exists(select 1 from family_members m where m.family_id=calendar_events.family_id and m.pin_set_at is not null));

create policy "bootstrap completions before pins" on public.task_completions for all
using (public.can_access_family(family_id) and not exists(select 1 from family_members m where m.family_id=task_completions.family_id and m.pin_set_at is not null))
with check (public.can_access_family(family_id) and not exists(select 1 from family_members m where m.family_id=task_completions.family_id and m.pin_set_at is not null));

create policy "family members read help requests" on public.help_requests
for select using (public.can_access_family(family_id));

create policy "family members read activity" on public.family_activity_log
for select using (public.can_access_family(family_id));

create or replace function public.setup_family_profile_pins(p_pins jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_family uuid;
  v_parent_key text;
  v_token uuid;
  v_member record;
  v_pin text;
begin
  select family_id into v_family from family_users where user_id = auth.uid() and role = 'admin' limit 1;
  if v_family is null then raise exception '管理者ログインが必要です'; end if;
  if exists (select 1 from family_members where family_id = v_family and pin_set_at is not null) then
    raise exception 'PINは設定済みです';
  end if;
  for v_member in select profile_key, role from family_members where family_id = v_family loop
    v_pin := p_pins ->> v_member.profile_key;
    if v_pin is null or v_pin !~ '^[0-9]{4}$' then raise exception '% のPINは4桁の数字にしてください', v_member.profile_key; end if;
    update family_members set pin_hash = crypt(v_pin, gen_salt('bf')), pin_set_at = now() where family_id = v_family and profile_key = v_member.profile_key;
    if v_member.role = 'parent' then v_parent_key := v_member.profile_key; end if;
  end loop;
  insert into family_profile_sessions(family_id, profile_key, auth_user_id) values(v_family, v_parent_key, auth.uid()) returning token into v_token;
  insert into family_activity_log(family_id, profile_key, action, target_type, target_key) values(v_family, v_parent_key, 'setup_pins', 'family', v_family::text);
  return jsonb_build_object('token', v_token, 'profile_key', v_parent_key);
end;
$$;

create or replace function public.unlock_family_profile(p_profile_key text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_family uuid; v_member family_members%rowtype; v_token uuid;
begin
  select family_id into v_family from family_users where user_id = auth.uid() limit 1;
  select * into v_member from family_members where family_id = v_family and profile_key = p_profile_key;
  if v_member.id is null or v_member.pin_hash is null or crypt(p_pin, v_member.pin_hash) <> v_member.pin_hash then
    raise exception 'PINが違います';
  end if;
  delete from family_profile_sessions where auth_user_id = auth.uid() and expires_at < now();
  insert into family_profile_sessions(family_id, profile_key, auth_user_id) values(v_family, p_profile_key, auth.uid()) returning token into v_token;
  insert into family_activity_log(family_id, profile_key, action, target_type, target_key) values(v_family, p_profile_key, 'unlock_profile', 'profile', p_profile_key);
  return jsonb_build_object('token', v_token, 'profile_key', p_profile_key);
end;
$$;

create or replace function public.resume_family_profile(p_token uuid)
returns jsonb
language sql security definer set search_path = public
as $$
  select jsonb_build_object('profile_key', s.profile_key)
  from family_profile_sessions s
  where s.token = p_token and s.auth_user_id = auth.uid() and s.expires_at > now()
  limit 1;
$$;

create or replace function public.reset_family_profile_pin(p_token uuid, p_profile_key text, p_new_pin text)
returns void language plpgsql security definer set search_path = public as $$
declare v_session family_profile_sessions%rowtype; v_role text;
begin
  select * into v_session from family_profile_sessions where token=p_token and auth_user_id=auth.uid() and expires_at>now();
  select role into v_role from family_members where family_id=v_session.family_id and profile_key=v_session.profile_key;
  if v_role <> 'parent' then raise exception '親プロフィールでの操作が必要です'; end if;
  if p_new_pin !~ '^[0-9]{4}$' then raise exception 'PINは4桁の数字にしてください'; end if;
  update family_members set pin_hash=crypt(p_new_pin,gen_salt('bf')),pin_set_at=now() where family_id=v_session.family_id and profile_key=p_profile_key;
  delete from family_profile_sessions where family_id=v_session.family_id and profile_key=p_profile_key and token<>p_token;
  insert into family_activity_log(family_id,profile_key,action,target_type,target_key) values(v_session.family_id,v_session.profile_key,'reset_pin','profile',p_profile_key);
end; $$;

create or replace function public.set_family_help_request(p_token uuid, p_task_id uuid, p_member_key text, p_requested_on date, p_cancel boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_session family_profile_sessions%rowtype; v_task tasks%rowtype;
begin
  select * into v_session from family_profile_sessions where token = p_token and auth_user_id = auth.uid() and expires_at > now();
  if v_session.token is null or v_session.profile_key <> p_member_key then raise exception '自分のお手伝いだけ申請できます'; end if;
  select * into v_task from tasks where id = p_task_id and family_id = v_session.family_id;
  if v_task.id is null or v_task.category <> 'help' or not (v_task.assignee_key in (p_member_key, 'both')) then raise exception '申請できないお手伝いです'; end if;
  if p_cancel then
    delete from help_requests where task_id = p_task_id and member_key = p_member_key and requested_on = p_requested_on and status = 'pending';
  else
    insert into help_requests(family_id, task_id, member_key, requested_on, status) values(v_session.family_id, p_task_id, p_member_key, p_requested_on, 'pending')
    on conflict (task_id, member_key, requested_on) do update set status = 'pending', requested_at = now(), decided_at = null, decided_by = null;
  end if;
  insert into family_activity_log(family_id, profile_key, action, target_type, target_key, details)
  values(v_session.family_id, v_session.profile_key, case when p_cancel then 'cancel_help_request' else 'request_help_completion' end, 'task', p_task_id::text, jsonb_build_object('date', p_requested_on));
end;
$$;

create or replace function public.decide_family_help_request(p_token uuid, p_task_id uuid, p_member_key text, p_requested_on date, p_approve boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_session family_profile_sessions%rowtype; v_role text;
begin
  select * into v_session from family_profile_sessions where token = p_token and auth_user_id = auth.uid() and expires_at > now();
  select role into v_role from family_members where family_id = v_session.family_id and profile_key = v_session.profile_key;
  if v_session.token is null or v_role <> 'parent' then raise exception '親プロフィールでの確認が必要です'; end if;
  if not exists (select 1 from help_requests where task_id = p_task_id and member_key = p_member_key and requested_on = p_requested_on and status = 'pending') then raise exception '確認待ちの申請がありません'; end if;
  update help_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_at = now(), decided_by = v_session.profile_key
  where task_id = p_task_id and member_key = p_member_key and requested_on = p_requested_on;
  if p_approve then
    insert into task_completions(family_id, task_id, member_key, completed_on) values(v_session.family_id, p_task_id, p_member_key, p_requested_on) on conflict do nothing;
  end if;
  insert into family_activity_log(family_id, profile_key, action, target_type, target_key, details)
  values(v_session.family_id, v_session.profile_key, case when p_approve then 'approve_help' else 'reject_help' end, 'task', p_task_id::text, jsonb_build_object('member', p_member_key, 'date', p_requested_on));
end;
$$;

create or replace function public.set_family_task_completion(p_token uuid, p_task_id uuid, p_member_key text, p_completed_on date, p_completed boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_session family_profile_sessions%rowtype; v_member family_members%rowtype; v_task tasks%rowtype;
begin
  select * into v_session from family_profile_sessions where token = p_token and auth_user_id = auth.uid() and expires_at > now();
  select * into v_member from family_members where family_id = v_session.family_id and profile_key = v_session.profile_key;
  select * into v_task from tasks where id = p_task_id and family_id = v_session.family_id;
  if v_session.token is null or v_task.id is null then raise exception '操作できません'; end if;
  if v_task.category = 'help' then
    if v_member.role <> 'parent' or p_completed then raise exception 'お手伝いは申請の確認から完了にしてください'; end if;
  elsif v_member.role <> 'parent' and not (v_session.profile_key = p_member_key and v_task.assignee_key = p_member_key and coalesce((v_member.permissions->>'complete_study')::boolean, false)) then
    raise exception 'この勉強項目は変更できません';
  end if;
  if p_completed then
    insert into task_completions(family_id, task_id, member_key, completed_on) values(v_session.family_id, p_task_id, p_member_key, p_completed_on) on conflict do nothing;
  else
    delete from task_completions where family_id = v_session.family_id and task_id = p_task_id and member_key = p_member_key and completed_on = p_completed_on;
  end if;
  insert into family_activity_log(family_id, profile_key, action, target_type, target_key, details)
  values(v_session.family_id, v_session.profile_key, case when p_completed then 'complete_study' else 'cancel_completion' end, 'task', p_task_id::text, jsonb_build_object('member', p_member_key, 'date', p_completed_on));
end;
$$;

create or replace function public.save_family_task(p_token uuid, p_task jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_session family_profile_sessions%rowtype; v_member family_members%rowtype; v_existing tasks%rowtype;
begin
  select * into v_session from family_profile_sessions where token = p_token and auth_user_id = auth.uid() and expires_at > now();
  select * into v_member from family_members where family_id = v_session.family_id and profile_key = v_session.profile_key;
  select * into v_existing from tasks where id = (p_task->>'id')::uuid and family_id = v_session.family_id;
  if v_session.token is null then raise exception 'プロフィールを選び直してください'; end if;
  if v_member.role <> 'parent' and not (coalesce((v_member.permissions->>'manage_study')::boolean, false) and p_task->>'category' = 'study' and p_task->>'assignee_key' = v_session.profile_key and (v_existing.id is null or (v_existing.category = 'study' and v_existing.assignee_key = v_session.profile_key))) then raise exception 'この項目は編集できません'; end if;
  insert into tasks(id, family_id, title, category, assignee_key, schedule_type, schedule, active)
  values((p_task->>'id')::uuid, v_session.family_id, p_task->>'title', p_task->>'category', p_task->>'assignee_key', p_task->>'schedule_type', coalesce(p_task->'schedule','{}'::jsonb), coalesce((p_task->>'active')::boolean,true))
  on conflict (id) do update set title=excluded.title, category=excluded.category, assignee_key=excluded.assignee_key, schedule_type=excluded.schedule_type, schedule=excluded.schedule, active=excluded.active, updated_at=now();
  insert into family_activity_log(family_id,profile_key,action,target_type,target_key) values(v_session.family_id,v_session.profile_key,case when v_existing.id is null then 'create_task' else 'update_task' end,'task',p_task->>'id');
end; $$;

create or replace function public.delete_family_task(p_token uuid, p_task_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_session family_profile_sessions%rowtype; v_role text;
begin
  select * into v_session from family_profile_sessions where token=p_token and auth_user_id=auth.uid() and expires_at>now();
  select role into v_role from family_members where family_id=v_session.family_id and profile_key=v_session.profile_key;
  if v_role <> 'parent' then raise exception '削除は親だけが行えます'; end if;
  delete from tasks where family_id=v_session.family_id and id=p_task_id;
  insert into family_activity_log(family_id,profile_key,action,target_type,target_key) values(v_session.family_id,v_session.profile_key,'delete_task','task',p_task_id::text);
end; $$;

create or replace function public.save_family_daily_note(p_token uuid, p_note_date date, p_member_key text, p_category text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare v_session family_profile_sessions%rowtype; v_role text;
begin
  select * into v_session from family_profile_sessions where token=p_token and auth_user_id=auth.uid() and expires_at>now();
  select role into v_role from family_members where family_id=v_session.family_id and profile_key=v_session.profile_key;
  if v_role <> 'parent' and v_session.profile_key <> p_member_key then raise exception '自分のメモだけ編集できます'; end if;
  if trim(p_body) = '' then delete from daily_notes where family_id=v_session.family_id and note_date=p_note_date and member_key=p_member_key and category=p_category;
  else insert into daily_notes(family_id,note_date,member_key,category,body) values(v_session.family_id,p_note_date,p_member_key,p_category,trim(p_body)) on conflict(family_id,note_date,member_key,category) do update set body=excluded.body,updated_at=now(); end if;
  insert into family_activity_log(family_id,profile_key,action,target_type,target_key,details) values(v_session.family_id,v_session.profile_key,'save_note','note',p_member_key||':'||p_note_date::text,jsonb_build_object('category',p_category));
end; $$;

create or replace function public.save_family_event(p_token uuid, p_event jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_session family_profile_sessions%rowtype; v_role text;
begin
  select * into v_session from family_profile_sessions where token=p_token and auth_user_id=auth.uid() and expires_at>now();
  select role into v_role from family_members where family_id=v_session.family_id and profile_key=v_session.profile_key;
  if v_role <> 'parent' then raise exception '予定の変更は親だけが行えます'; end if;
  insert into calendar_events(id,family_id,event_date,title,start_time,end_time,owner_keys,external_uid)
  values((p_event->>'id')::uuid,v_session.family_id,(p_event->>'event_date')::date,p_event->>'title',nullif(p_event->>'start_time','')::time,nullif(p_event->>'end_time','')::time,array(select jsonb_array_elements_text(coalesce(p_event->'owner_keys','["family"]'::jsonb))),nullif(p_event->>'external_uid',''))
  on conflict(id) do update set event_date=excluded.event_date,title=excluded.title,start_time=excluded.start_time,end_time=excluded.end_time,owner_keys=excluded.owner_keys,external_uid=excluded.external_uid,updated_at=now();
end; $$;

create or replace function public.delete_family_event(p_token uuid, p_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_session family_profile_sessions%rowtype; v_role text;
begin
  select * into v_session from family_profile_sessions where token=p_token and auth_user_id=auth.uid() and expires_at>now();
  select role into v_role from family_members where family_id=v_session.family_id and profile_key=v_session.profile_key;
  if v_role <> 'parent' then raise exception '予定の削除は親だけが行えます'; end if;
  delete from calendar_events where family_id=v_session.family_id and id=p_event_id;
end; $$;

revoke select on public.family_members from authenticated;
grant select (id, family_id, profile_key, display_name, color, role, sort_order, created_at, pin_set_at, permissions) on public.family_members to authenticated;
grant select on public.help_requests, public.family_activity_log to authenticated;
revoke all on public.family_profile_sessions from authenticated;
grant execute on function public.setup_family_profile_pins(jsonb) to authenticated;
grant execute on function public.unlock_family_profile(text, text) to authenticated;
grant execute on function public.resume_family_profile(uuid) to authenticated;
grant execute on function public.reset_family_profile_pin(uuid, text, text) to authenticated;
grant execute on function public.set_family_help_request(uuid, uuid, text, date, boolean) to authenticated;
grant execute on function public.decide_family_help_request(uuid, uuid, text, date, boolean) to authenticated;
grant execute on function public.set_family_task_completion(uuid, uuid, text, date, boolean) to authenticated;
grant execute on function public.save_family_task(uuid, jsonb) to authenticated;
grant execute on function public.delete_family_task(uuid, uuid) to authenticated;
grant execute on function public.save_family_daily_note(uuid, date, text, text, text) to authenticated;
grant execute on function public.save_family_event(uuid, jsonb) to authenticated;
grant execute on function public.delete_family_event(uuid, uuid) to authenticated;
