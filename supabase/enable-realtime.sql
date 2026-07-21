-- 別の端末で行った変更をすぐ画面へ反映するための設定です。
-- Supabase の SQL Editor で1回だけ実行してください。

do $$
declare
  table_name text;
begin
  foreach table_name in array array['tasks', 'calendar_events', 'task_completions', 'help_requests', 'daily_notes']
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;
