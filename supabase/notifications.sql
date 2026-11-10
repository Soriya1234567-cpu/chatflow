-- Persistent notification preferences, private push subscriptions, and unread counts.
-- Run after schema.sql and messaging_media.sql.
begin;

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  desktop_enabled boolean not null default false,
  push_enabled boolean not null default false,
  sound_enabled boolean not null default true,
  previews_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;
drop policy if exists "Users manage their notification preferences" on public.notification_preferences;
create policy "Users manage their notification preferences"
on public.notification_preferences for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());
grant select, insert, update, delete on public.notification_preferences to authenticated;
revoke all on public.notification_preferences from public, anon;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists "Users manage their push subscriptions" on public.push_subscriptions;
create policy "Users manage their push subscriptions"
on public.push_subscriptions for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_subscriptions to authenticated;
revoke all on public.push_subscriptions from public, anon;

create table if not exists public.message_push_deliveries (
  message_id uuid not null references public.messages(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'processing' check (status in ('processing', 'sent', 'failed', 'skipped')),
  updated_at timestamptz not null default now(),
  primary key (message_id, recipient_id)
);
alter table public.message_push_deliveries enable row level security;
revoke all on public.message_push_deliveries from public, anon, authenticated;
grant all on public.message_push_deliveries to service_role;

create index if not exists message_reads_user_message_idx on public.message_reads(user_id, message_id);
create index if not exists messages_conversation_sender_idx on public.messages(conversation_id, sender_id);

create or replace function public.get_unread_message_counts()
returns table (conversation_id uuid, unread_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
    select m.conversation_id, count(*)::bigint
    from public.messages m
    join public.conversation_members cm
      on cm.conversation_id = m.conversation_id
      and cm.user_id = auth.uid()
    left join public.message_reads mr
      on mr.message_id = m.id
      and mr.user_id = auth.uid()
    where m.sender_id <> auth.uid()
      and mr.message_id is null
    group by m.conversation_id;
end;
$$;
revoke all on function public.get_unread_message_counts() from public, anon;
grant execute on function public.get_unread_message_counts() to authenticated;

create or replace function public.set_notification_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists notification_preferences_updated_at on public.notification_preferences;
create trigger notification_preferences_updated_at
before update on public.notification_preferences
for each row execute procedure public.set_notification_updated_at();

drop trigger if exists push_subscriptions_updated_at on public.push_subscriptions;
create trigger push_subscriptions_updated_at
before update on public.push_subscriptions
for each row execute procedure public.set_notification_updated_at();

notify pgrst, 'reload schema';
commit;
