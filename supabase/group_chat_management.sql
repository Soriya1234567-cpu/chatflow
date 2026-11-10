-- Group photos, member-managed contact invitations, and owner-managed group actions.
-- Run after schema.sql, profile_avatars.sql, and messaging_media.sql.
begin;

alter table public.conversations
  add column if not exists group_avatar_path text;

grant update (name, group_avatar_path) on public.conversations to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('group-avatars', 'group-avatars', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Group members can view group photos" on storage.objects;
create policy "Group members can view group photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'group-avatars'
    and public.is_conversation_member(
      case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (storage.foldername(name))[1]::uuid else null end,
      auth.uid()
    )
  );

drop policy if exists "Group owners can upload group photos" on storage.objects;
create policy "Group owners can upload group photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'group-avatars'
    and exists (
      select 1 from public.conversations c
      where c.id = case
        when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (storage.foldername(name))[1]::uuid
        else null
      end
        and c.type = 'group'
        and c.created_by = auth.uid()
        and public.is_conversation_member(c.id, auth.uid())
    )
  );

drop policy if exists "Group owners can delete group photos" on storage.objects;
create policy "Group owners can delete group photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'group-avatars'
    and exists (
      select 1 from public.conversations c
      where c.id = case
        when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (storage.foldername(name))[1]::uuid
        else null
      end
        and c.type = 'group'
        and c.created_by = auth.uid()
        and public.is_conversation_member(c.id, auth.uid())
    )
  );

create or replace function public.add_group_members(target_conversation uuid, new_member_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  unique_member_ids uuid[];
  group_member_count integer;
  valid_contact_count integer;
  added_count integer;
  target_type text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select c.type into target_type
  from public.conversations c
  where c.id = target_conversation
  for update;
  if not found or target_type <> 'group' then raise exception 'Group not found'; end if;
  if not public.is_conversation_member(target_conversation, auth.uid()) then
    raise exception 'Only group members can add contacts';
  end if;
  if new_member_ids is null or coalesce(array_length(new_member_ids, 1), 0) = 0 then
    raise exception 'Select at least one contact';
  end if;
  if array_length(new_member_ids, 1) > 50 then
    raise exception 'You can add up to 50 contacts at a time';
  end if;

  select array_agg(distinct requested.user_id)
  into unique_member_ids
  from unnest(new_member_ids) as requested(user_id)
  where requested.user_id is not null and requested.user_id <> auth.uid();
  if unique_member_ids is null then raise exception 'Select at least one other contact'; end if;

  select count(*) into valid_contact_count
  from unnest(unique_member_ids) as requested(user_id)
  where exists (
    select 1
    from public.conversations direct_chat
    join public.conversation_members caller_member
      on caller_member.conversation_id = direct_chat.id
      and caller_member.user_id = auth.uid()
    join public.conversation_members contact_member
      on contact_member.conversation_id = direct_chat.id
      and contact_member.user_id = requested.user_id
    where direct_chat.type = 'direct'
  );
  if valid_contact_count <> array_length(unique_member_ids, 1) then
    raise exception 'Only your direct-chat contacts can be added';
  end if;

  select count(*) into group_member_count
  from public.conversation_members cm
  where cm.conversation_id = target_conversation;
  select group_member_count + count(*) into group_member_count
  from unnest(unique_member_ids) as requested(user_id)
  where not exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = target_conversation and cm.user_id = requested.user_id
  );
  if group_member_count > 51 then raise exception 'Groups can have up to 51 members'; end if;

  insert into public.conversation_members(conversation_id, user_id, role)
  select target_conversation, requested.user_id, 'member'
  from unnest(unique_member_ids) as requested(user_id)
  on conflict (conversation_id, user_id) do nothing;
  get diagnostics added_count = row_count;
  return added_count;
end;
$$;
revoke all on function public.add_group_members(uuid, uuid[]) from public;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;

create or replace function public.delete_group_conversation(target_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_type text;
  group_owner uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select c.type, c.created_by into target_type, group_owner
  from public.conversations c
  where c.id = target_conversation
  for update;
  if not found or target_type <> 'group' then raise exception 'Group not found'; end if;
  if group_owner <> auth.uid() then raise exception 'Only the group creator can delete this group'; end if;

  delete from public.conversations c where c.id = target_conversation;
end;
$$;
revoke all on function public.delete_group_conversation(uuid) from public;
grant execute on function public.delete_group_conversation(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
