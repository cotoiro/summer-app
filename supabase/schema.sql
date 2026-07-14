-- 夏やすみボード: 家族共有用データベース
-- Supabase の SQL Editor で実行する想定です。

create extension if not exists pgcrypto;

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'わが家',
  created_at timestamptz not null default now()
);

create table if not exists public.family_users (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'shared' check (role in ('shared', 'admin')),
  created_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

create table if not exists public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  profile_key text not null,
  display_name text not null,
  color text not null,
  role text not null check (role in ('parent', 'child')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (family_id, profile_key)
);

create table if not exists public.tasks (
  id uuid primary key,
  family_id uuid not null references public.families(id) on delete cascade,
  title text not null,
  category text not null check (category in ('study', 'help')),
  assignee_key text not null,
  schedule_type text not null check (schedule_type in ('once', 'anytime', 'daily', 'weekly', 'biweekly')),
  schedule jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.task_completions (
  family_id uuid not null references public.families(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  member_key text not null,
  completed_on date not null,
  created_at timestamptz not null default now(),
  primary key (task_id, member_key, completed_on)
);

create table if not exists public.daily_notes (
  family_id uuid not null references public.families(id) on delete cascade,
  note_date date not null,
  member_key text not null,
  category text not null check (category in ('study', 'help')),
  body text not null default '',
  updated_at timestamptz not null default now(),
  primary key (family_id, note_date, member_key, category)
);

create table if not exists public.calendar_events (
  id uuid primary key,
  family_id uuid not null references public.families(id) on delete cascade,
  event_date date not null,
  title text not null,
  start_time time,
  end_time time,
  owner_keys text[] not null default array['family']::text[],
  external_uid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.family_admin_settings (
  family_id uuid primary key references public.families(id) on delete cascade,
  pin_hash text,
  updated_at timestamptz not null default now()
);

create or replace function public.can_access_family(target_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.family_users
    where family_id = target_family_id and user_id = auth.uid()
  );
$$;

alter table public.families enable row level security;
alter table public.family_users enable row level security;
alter table public.family_members enable row level security;
alter table public.tasks enable row level security;
alter table public.task_completions enable row level security;
alter table public.daily_notes enable row level security;
alter table public.calendar_events enable row level security;
alter table public.family_admin_settings enable row level security;

create policy "family members can read families" on public.families
for select using (public.can_access_family(id));

create policy "family members can read memberships" on public.family_users
for select using (user_id = auth.uid());

create policy "family members manage profiles" on public.family_members
for all using (public.can_access_family(family_id)) with check (public.can_access_family(family_id));

create policy "family members manage tasks" on public.tasks
for all using (public.can_access_family(family_id)) with check (public.can_access_family(family_id));

create policy "family members manage completions" on public.task_completions
for all using (public.can_access_family(family_id)) with check (public.can_access_family(family_id));

create policy "family members manage daily notes" on public.daily_notes
for all using (public.can_access_family(family_id)) with check (public.can_access_family(family_id));

create policy "family members manage events" on public.calendar_events
for all using (public.can_access_family(family_id)) with check (public.can_access_family(family_id));

create policy "family members manage admin settings" on public.family_admin_settings
for all using (public.can_access_family(family_id)) with check (public.can_access_family(family_id));
