-- ChatFlow database schema for Supabase PostgreSQL.
-- Run the entire file in Supabase Dashboard -> SQL Editor.
-- Never expose a service_role key in browser code.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 40),
  email text not null unique,
  username text unique check (username is null or (char_length(trim(username)) between 2 and 30 and username ~ '^[a-zA-Z0-9._-]+$')),
  avatar_url text,
  avatar_path text check (avatar_path is null or avatar_path like id::text || '/%'),
  bio text check (bio is null or char_length(trim(bio)) between 1 and 180),
  status_message text check (status_message is null or char_length(trim(status_message)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('direct', 'group')),
  name text,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint group_name_required check (
    (type = 'direct' and name is null) or
    (type = 'group' and name is not null and char_length(trim(name)) between 1 and 80)
  )
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists conversation_members_user_idx on public.conversation_members(user_id);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);

-- Create a profile automatically when an auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  chosen_name text;
begin
  chosen_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1), 'ChatFlow user');
  insert into public.profiles (id, display_name, email)
  values (new.id, left(chosen_name, 40), lower(new.email))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_chatflow on auth.users;
create trigger on_auth_user_created_chatflow
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Keep profile email synchronized if the user changes email in Supabase Auth.
create or replace function public.handle_auth_email_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = lower(new.email) where id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists on_auth_user_email_updated_chatflow on auth.users;
create trigger on_auth_user_email_updated_chatflow
after update of email on auth.users
for each row execute procedure public.handle_auth_email_update();

-- Helper functions use SECURITY DEFINER to avoid RLS recursion when checking membership.
create or replace function public.is_conversation_member(target_conversation uuid, target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = target_conversation and cm.user_id = target_user
  );
$$;

revoke all on function public.is_conversation_member(uuid, uuid) from public;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;

-- The app only needs exact email lookup for creating a conversation.
-- The function returns only matching profile rows and only to authenticated callers.
create or replace function public.lookup_profiles_by_email(lookup_emails text[])
returns table (id uuid, email text, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if coalesce(array_length(lookup_emails, 1), 0) < 1 or array_length(lookup_emails, 1) > 50 then
    raise exception 'Provide between 1 and 50 email addresses';
  end if;
  return query
    select p.id, p.email, p.display_name
    from public.profiles p
    where lower(p.email) = any (
      select lower(x) from unnest(lookup_emails) as x
    );
end;
$$;
revoke all on function public.lookup_profiles_by_email(text[]) from public;
grant execute on function public.lookup_profiles_by_email(text[]) to authenticated;

-- Atomic creation: caller is always included; direct chats require exactly two members.
create or replace function public.create_conversation(conversation_type text, conversation_name text, member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_conversation_id uuid;
  unique_members uuid[];
  requested_count integer;
  valid_count integer;
  person_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if conversation_type not in ('direct', 'group') then raise exception 'Invalid conversation type'; end if;
  if member_ids is null or coalesce(array_length(member_ids, 1), 0) < 2 or array_length(member_ids, 1) > 51 then
    raise exception 'Conversations require between 2 and 51 members';
  end if;

  select array_agg(distinct x) into unique_members
  from unnest(member_ids || array[auth.uid()]) as x;
  requested_count := coalesce(array_length(unique_members, 1), 0);
  if conversation_type = 'direct' and requested_count <> 2 then
    raise exception 'Direct conversations must have exactly two members';
  end if;
  if conversation_type = 'group' and (conversation_name is null or char_length(trim(conversation_name)) not between 1 and 80) then
    raise exception 'Group name must be between 1 and 80 characters';
  end if;

  select count(*) into valid_count from public.profiles p where p.id = any(unique_members);
  if valid_count <> requested_count then raise exception 'One or more members do not exist'; end if;

  -- Avoid duplicate one-to-one conversations.
  if conversation_type = 'direct' then
    select c.id into new_conversation_id
    from public.conversations c
    where c.type = 'direct'
      and (select count(*) from public.conversation_members cm where cm.conversation_id = c.id) = 2
      and exists (select 1 from public.conversation_members cm where cm.conversation_id = c.id and cm.user_id = unique_members[1])
      and exists (select 1 from public.conversation_members cm where cm.conversation_id = c.id and cm.user_id = unique_members[2])
    limit 1;
    if new_conversation_id is not null then return new_conversation_id; end if;
  end if;

  insert into public.conversations(type, name, created_by)
  values (conversation_type, case when conversation_type = 'group' then trim(conversation_name) else null end, auth.uid())
  returning id into new_conversation_id;

  foreach person_id in array unique_members loop
    insert into public.conversation_members(conversation_id, user_id, role)
    values (new_conversation_id, person_id, case when person_id = auth.uid() then 'owner' else 'member' end);
  end loop;
  return new_conversation_id;
end;
$$;
revoke all on function public.create_conversation(text, text, uuid[]) from public;
grant execute on function public.create_conversation(text, text, uuid[]) to authenticated;

-- Profile access: authenticated users can view profile cards; only self can update their profile.
alter table public.profiles enable row level security;
-- A user can see their own profile, or profiles of people who share a conversation with them.
-- This prevents a broad authenticated user from enumerating the entire profile directory.
create or replace function public.shares_conversation_with(target_user uuid, viewer uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_members mine
    join public.conversation_members theirs
      on theirs.conversation_id = mine.conversation_id
    where mine.user_id = viewer and theirs.user_id = target_user
  );
$$;
revoke all on function public.shares_conversation_with(uuid, uuid) from public;
grant execute on function public.shares_conversation_with(uuid, uuid) to authenticated;

drop policy if exists "Authenticated users can view profiles" on public.profiles;
drop policy if exists "Users can view own or conversation-member profiles" on public.profiles;
create policy "Users can view own or conversation-member profiles"
on public.profiles for select to authenticated
using (id = auth.uid() or public.shares_conversation_with(id, auth.uid()));
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile"
on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- Profile creation is handled by the auth trigger; no client INSERT policy.

alter table public.conversations enable row level security;
drop policy if exists "Members can view their conversations" on public.conversations;
create policy "Members can view their conversations"
on public.conversations for select to authenticated
using (public.is_conversation_member(id, auth.uid()));
-- Creation is only through create_conversation RPC; no direct INSERT policy.
drop policy if exists "Owners can update group name" on public.conversations;
create policy "Owners can update group name"
on public.conversations for update to authenticated
using (created_by = auth.uid() and type = 'group' and public.is_conversation_member(id, auth.uid()))
with check (created_by = auth.uid() and type = 'group' and public.is_conversation_member(id, auth.uid()));

alter table public.conversation_members enable row level security;
drop policy if exists "Members can view fellow members" on public.conversation_members;
create policy "Members can view fellow members"
on public.conversation_members for select to authenticated
using (public.is_conversation_member(conversation_id, auth.uid()));
-- No client insert/delete policy: membership is managed by the trusted RPC / future admin RPCs.

alter table public.messages enable row level security;
drop policy if exists "Members can read conversation messages" on public.messages;
create policy "Members can read conversation messages"
on public.messages for select to authenticated
using (public.is_conversation_member(conversation_id, auth.uid()));
drop policy if exists "Members can send as themselves" on public.messages;
create policy "Members can send as themselves"
on public.messages for insert to authenticated
with check (
  sender_id = auth.uid()
  and public.is_conversation_member(conversation_id, auth.uid())
  and char_length(trim(content)) between 1 and 4000
);
-- No UPDATE or DELETE policies: messages cannot be edited/deleted from this starter app.

-- Grant only the needed operations. RLS still applies to every row.
grant usage on schema public to authenticated;
grant select on public.profiles, public.conversations, public.conversation_members, public.messages to authenticated;
revoke update on public.profiles from authenticated;
grant update (display_name, username, avatar_url, avatar_path, bio, status_message) on public.profiles to authenticated;
grant update (name) on public.conversations to authenticated;
grant insert on public.messages to authenticated;

-- Realtime publication for live message inserts and membership changes.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_members'
  ) then
    alter publication supabase_realtime add table public.conversation_members;
  end if;
end $$;

-- Run profile_avatars.sql, then profile_discovery.sql after this schema.
