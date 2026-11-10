-- Last-seen timestamps for conversation contacts.
-- Run after schema.sql in Supabase Dashboard -> SQL Editor.
begin;

create table if not exists public.user_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

alter table public.user_presence enable row level security;
drop policy if exists "Users can view conversation contacts presence" on public.user_presence;
create policy "Users can view conversation contacts presence"
  on public.user_presence for select to authenticated
  using (user_id = auth.uid() or public.shares_conversation_with(user_id, auth.uid()));

grant select on public.user_presence to authenticated;

create or replace function public.heartbeat_chat_presence()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.user_presence(user_id, last_seen_at)
  values (auth.uid(), now())
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at;
end;
$$;

revoke all on function public.heartbeat_chat_presence() from public;
grant execute on function public.heartbeat_chat_presence() to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_presence'
  ) then
    alter publication supabase_realtime add table public.user_presence;
  end if;
end $$;

commit;
