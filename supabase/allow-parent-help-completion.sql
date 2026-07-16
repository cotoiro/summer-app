-- 親が申請なしでもお手伝いを直接完了できるようにする更新SQL

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
    if v_member.role <> 'parent' then raise exception 'お手伝いの完了は親だけが変更できます'; end if;
  elsif v_member.role <> 'parent' and not (v_session.profile_key = p_member_key and v_task.assignee_key = p_member_key and coalesce((v_member.permissions->>'complete_study')::boolean, false)) then
    raise exception 'この勉強項目は変更できません';
  end if;
  if p_completed then
    insert into task_completions(family_id, task_id, member_key, completed_on) values(v_session.family_id, p_task_id, p_member_key, p_completed_on) on conflict do nothing;
    if v_task.category = 'help' then
      update help_requests set status = 'approved', decided_at = now(), decided_by = v_session.profile_key
      where task_id = p_task_id and member_key = p_member_key and requested_on = p_completed_on and status = 'pending';
    end if;
  else
    delete from task_completions where family_id = v_session.family_id and task_id = p_task_id and member_key = p_member_key and completed_on = p_completed_on;
  end if;
  insert into family_activity_log(family_id, profile_key, action, target_type, target_key, details)
  values(v_session.family_id, v_session.profile_key, case when p_completed and v_task.category = 'help' then 'complete_help_direct' when p_completed then 'complete_study' else 'cancel_completion' end, 'task', p_task_id::text, jsonb_build_object('member', p_member_key, 'date', p_completed_on));
end;
$$;
