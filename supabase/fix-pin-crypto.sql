--いけ profile-permissions.sql 適用後に gen_salt エラーが出た環境向け修正
-- PIN関連の関数だけを安全に置き換えます。

create extension if not exists pgcrypto with schema extensions;

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
    update family_members set pin_hash = extensions.crypt(v_pin, extensions.gen_salt('bf')), pin_set_at = now() where family_id = v_family and profile_key = v_member.profile_key;
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
  if v_member.id is null or v_member.pin_hash is null or extensions.crypt(p_pin, v_member.pin_hash) <> v_member.pin_hash then
    raise exception 'PINが違います';
  end if;
  delete from family_profile_sessions where auth_user_id = auth.uid() and expires_at < now();
  insert into family_profile_sessions(family_id, profile_key, auth_user_id) values(v_family, p_profile_key, auth.uid()) returning token into v_token;
  insert into family_activity_log(family_id, profile_key, action, target_type, target_key) values(v_family, p_profile_key, 'unlock_profile', 'profile', p_profile_key);
  return jsonb_build_object('token', v_token, 'profile_key', p_profile_key);
end;
$$;

create or replace function public.reset_family_profile_pin(p_token uuid, p_profile_key text, p_new_pin text)
returns void language plpgsql security definer set search_path = public as $$
declare v_session family_profile_sessions%rowtype; v_role text;
begin
  select * into v_session from family_profile_sessions where token=p_token and auth_user_id=auth.uid() and expires_at>now();
  select role into v_role from family_members where family_id=v_session.family_id and profile_key=v_session.profile_key;
  if v_role <> 'parent' then raise exception '親プロフィールでの操作が必要です'; end if;
  if p_new_pin !~ '^[0-9]{4}$' then raise exception 'PINは4桁の数字にしてください'; end if;
  update family_members set pin_hash=extensions.crypt(p_new_pin,extensions.gen_salt('bf')),pin_set_at=now() where family_id=v_session.family_id and profile_key=p_profile_key;
  delete from family_profile_sessions where family_id=v_session.family_id and profile_key=p_profile_key and token<>p_token;
  insert into family_activity_log(family_id,profile_key,action,target_type,target_key) values(v_session.family_id,v_session.profile_key,'reset_pin','profile',p_profile_key);
end;
$$;
