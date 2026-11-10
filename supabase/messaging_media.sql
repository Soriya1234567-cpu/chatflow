-- Incremental messaging and private attachment support for existing ChatFlow projects.
-- Run after schema.sql in Supabase Dashboard -> SQL Editor.

alter table public.messages
  add column if not exists message_type text not null default 'text',
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime text,
  add column if not exists attachment_size bigint,
  add column if not exists edited_at timestamptz;

alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages drop constraint if exists messages_payload_valid;
alter table public.messages
  add constraint messages_payload_valid check (
    (
      message_type = 'text'
      and attachment_path is null
      and attachment_name is null
      and attachment_mime is null
      and attachment_size is null
      and char_length(trim(content)) between 1 and 4000
    )
    or
    (
      message_type in ('image', 'video', 'audio', 'file')
      and attachment_path is not null
      and attachment_name is not null
      and char_length(attachment_name) between 1 and 255
      and attachment_mime is not null
      and attachment_size between 1 and 26214400
      and attachment_path like conversation_id::text || '/' || sender_id::text || '/%'
      and char_length(content) <= 4000
    )
  );

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (emoji in ('👍', '❤️', '😂', '🎉')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table if not exists public.message_reads (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.message_reactions enable row level security;
drop policy if exists "Members can view message reactions" on public.message_reactions;
create policy "Members can view message reactions"
on public.message_reactions for select to authenticated
using (
  exists (
    select 1 from public.messages m
    where m.id = message_id and public.is_conversation_member(m.conversation_id, auth.uid())
  )
);
drop policy if exists "Members can react as themselves" on public.message_reactions;
create policy "Members can react as themselves"
on public.message_reactions for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.messages m
    where m.id = message_id and public.is_conversation_member(m.conversation_id, auth.uid())
  )
);
drop policy if exists "Users can remove their own reactions" on public.message_reactions;
create policy "Users can remove their own reactions"
on public.message_reactions for delete to authenticated
using (user_id = auth.uid());

alter table public.message_reads enable row level security;
drop policy if exists "Members can view conversation read receipts" on public.message_reads;
create policy "Members can view conversation read receipts"
on public.message_reads for select to authenticated
using (
  exists (
    select 1 from public.messages m
    where m.id = message_id and public.is_conversation_member(m.conversation_id, auth.uid())
  )
);
drop policy if exists "Users can mark messages read" on public.message_reads;
create policy "Users can mark messages read"
on public.message_reads for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.messages m
    where m.id = message_id and public.is_conversation_member(m.conversation_id, auth.uid())
  )
);
drop policy if exists "Users can update their own read receipts" on public.message_reads;
create policy "Users can update their own read receipts"
on public.message_reads for update to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.messages m
    where m.id = message_id and public.is_conversation_member(m.conversation_id, auth.uid())
  )
);

drop policy if exists "Authors can edit their own messages" on public.messages;
drop policy if exists "Members can send as themselves" on public.messages;
create policy "Members can send as themselves"
on public.messages for insert to authenticated
with check (
  sender_id = auth.uid()
  and public.is_conversation_member(conversation_id, auth.uid())
  and (
    (
      message_type = 'text'
      and attachment_path is null
      and attachment_name is null
      and attachment_mime is null
      and attachment_size is null
      and char_length(trim(content)) between 1 and 4000
    )
    or
    (
      message_type in ('image', 'video', 'audio', 'file')
      and attachment_path is not null
      and attachment_name is not null
      and char_length(attachment_name) between 1 and 255
      and attachment_mime is not null
      and attachment_size between 1 and 26214400
      and attachment_path like conversation_id::text || '/' || sender_id::text || '/%'
      and char_length(content) <= 4000
    )
  )
);
create policy "Authors can edit their own messages"
on public.messages for update to authenticated
using (sender_id = auth.uid() and public.is_conversation_member(conversation_id, auth.uid()))
with check (
  sender_id = auth.uid()
  and public.is_conversation_member(conversation_id, auth.uid())
  and (
    (message_type = 'text' and attachment_path is null and char_length(trim(content)) between 1 and 4000)
    or
    (message_type in ('image', 'video', 'audio', 'file') and attachment_path is not null
      and attachment_name is not null and attachment_mime is not null
      and attachment_size between 1 and 26214400
      and attachment_path like conversation_id::text || '/' || sender_id::text || '/%'
      and char_length(content) <= 4000)
  )
);
drop policy if exists "Authors can delete their own messages" on public.messages;
create policy "Authors can delete their own messages"
on public.messages for delete to authenticated
using (sender_id = auth.uid() and public.is_conversation_member(conversation_id, auth.uid()));

grant select, insert, delete on public.message_reactions to authenticated;
grant select, insert on public.message_reads to authenticated;
grant update (read_at) on public.message_reads to authenticated;
grant update (content, edited_at) on public.messages to authenticated;
grant delete on public.messages to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  false,
  26214400,
  array[
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm',
    'audio/webm', 'audio/ogg', 'audio/mp4'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Conversation members can read attachments" on storage.objects;
create policy "Conversation members can read attachments"
on storage.objects for select to authenticated
using (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_conversation_member(
    case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(name))[1])::uuid else null end,
    auth.uid()
  )
);
drop policy if exists "Conversation members can upload attachments" on storage.objects;
create policy "Conversation members can upload attachments"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_conversation_member(
    case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(name))[1])::uuid else null end,
    auth.uid()
  )
  and (storage.foldername(name))[2] = auth.uid()::text
);
drop policy if exists "Authors can remove their attachments" on storage.objects;
create policy "Authors can remove their attachments"
on storage.objects for delete to authenticated
using (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[2] = auth.uid()::text
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.is_conversation_member(
    case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(name))[1])::uuid else null end,
    auth.uid()
  )
);

drop policy if exists "Chat attachment member read boundary" on storage.objects;
create policy "Chat attachment member read boundary"
on storage.objects as restrictive for select to public
using (
  bucket_id <> 'chat-attachments'
  or (
    (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_conversation_member(
      case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then ((storage.foldername(name))[1])::uuid else null end,
      auth.uid()
    )
  )
);
drop policy if exists "Chat attachment owner upload boundary" on storage.objects;
create policy "Chat attachment owner upload boundary"
on storage.objects as restrictive for insert to public
with check (
  bucket_id <> 'chat-attachments'
  or (
    (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_conversation_member(
      case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then ((storage.foldername(name))[1])::uuid else null end,
      auth.uid()
    )
  )
);
drop policy if exists "Chat attachment owner delete boundary" on storage.objects;
create policy "Chat attachment owner delete boundary"
on storage.objects as restrictive for delete to public
using (
  bucket_id <> 'chat-attachments'
  or (
    (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_conversation_member(
      case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then ((storage.foldername(name))[1])::uuid else null end,
      auth.uid()
    )
  )
);
drop policy if exists "Chat attachment updates are disabled" on storage.objects;
create policy "Chat attachment updates are disabled"
on storage.objects as restrictive for update to public
using (bucket_id <> 'chat-attachments')
with check (bucket_id <> 'chat-attachments');

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions'
  ) then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reads'
  ) then
    alter publication supabase_realtime add table public.message_reads;
  end if;
end $$;
