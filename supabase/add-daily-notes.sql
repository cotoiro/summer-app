-- 「きょう」ページの宿題・勉強／お手伝いメモを、家族で共有するための追加設定です。
-- すでにオンライン共有を使っている場合だけ、Supabase の SQL Editor で一度実行してください。

create table if not exists public.daily_notes (
  family_id uuid not null references public.families(id) on delete cascade,
  note_date date not null,
  member_key text not null,
  category text not null check (category in ('study', 'help')),
  body text not null default '',
  updated_at timestamptz not null default now(),
  primary key (family_id, note_date, member_key, category)
);

alter table public.daily_notes enable row level security;

drop policy if exists "family members manage daily notes" on public.daily_notes;
create policy "family members manage daily notes" on public.daily_notes
for all using (public.can_access_family(family_id)) with check (public.can_access_family(family_id));

grant select, insert, update, delete on public.daily_notes to authenticated;
