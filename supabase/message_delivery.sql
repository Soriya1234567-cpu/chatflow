-- Recipient-side delivery receipts for outgoing messages.
-- Run after schema.sql and messaging_media.sql.
begin;

create table if not exists public.message_deliveries (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.message_deliveries enable row level security;
drop policy if exists "Members can view message delivery receipts" on public.message_deliveries;
create policy "Members can view message delivery receipts"
  on public.message_deliveries for select to authenticated
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_id and public.is_conversation_member(m.conversation_id, auth.uid())
    )
  );
grant select on public.message_deliveries to authenticated;

create or replace function public.mark_messages_delivered(target_messages uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if coalesce(array_length(target_messages, 1), 0) > 100 then
    raise exception 'You can mark up to 100 messages delivered at a time';
  end if;

  insert into public.message_deliveries(message_id, user_id)
  select m.id, auth.uid()
  from public.messages m
  where m.id = any(coalesce(target_messages, array[]::uuid[]))
    and m.sender_id <> auth.uid()
    and public.is_conversation_member(m.conversation_id, auth.uid())
  on conflict (message_id, user_id) do nothing;
end;
$$;

revoke all on function public.mark_messages_delivered(uuid[]) from public;
grant execute on function public.mark_messages_delivered(uuid[]) to authenticated;

create or replace function public.mark_message_delivered(target_message uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.message_deliveries(message_id, user_id)
  select m.id, auth.uid()
  from public.messages m
  where m.id = target_message
    and m.sender_id <> auth.uid()
    and public.is_conversation_member(m.conversation_id, auth.uid())
  on conflict (message_id, user_id) do nothing;
end;
$$;

revoke all on function public.mark_message_delivered(uuid) from public;
grant execute on function public.mark_message_delivered(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_deliveries'
  ) then
    alter publication supabase_realtime add table public.message_deliveries;
  end if;
end $$;

commit;
