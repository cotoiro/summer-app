-- オンライン共有を始める前に一度だけ実行する設定です。
-- ログイン済みの人が、自分の家族用データを安全に作れるようにします。

create or replace function public.bootstrap_family(p_family_name text default 'わが家')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_family_id uuid;
  new_family_id uuid;
begin
  if auth.uid() is null then
    raise exception 'ログインが必要です';
  end if;

  select family_id into existing_family_id
  from public.family_users
  where user_id = auth.uid()
  limit 1;

  if existing_family_id is not null then
    return existing_family_id;
  end if;

  insert into public.families (name)
  values (coalesce(nullif(trim(p_family_name), ''), 'わが家'))
  returning id into new_family_id;

  insert into public.family_users (family_id, user_id, role)
  values (new_family_id, auth.uid(), 'admin');

  insert into public.family_members (family_id, profile_key, display_name, color, role, sort_order)
  values
    (new_family_id, 'parent', 'おかあ', '#e9969f', 'parent', 0),
    (new_family_id, 'child1', 'りょう', '#72a9dc', 'child', 1),
    (new_family_id, 'child2', 'しゅん', '#69b98b', 'child', 2);

  return new_family_id;
end;
$$;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.families to authenticated;
grant select, insert, update, delete on public.family_users to authenticated;
grant select, insert, update, delete on public.family_members to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, update, delete on public.task_completions to authenticated;
grant select, insert, update, delete on public.calendar_events to authenticated;
grant select, insert, update, delete on public.family_admin_settings to authenticated;

revoke all on function public.bootstrap_family(text) from public;
grant execute on function public.bootstrap_family(text) to authenticated;
