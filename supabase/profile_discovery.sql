-- Authenticated profile cards and a bounded user directory.
-- Run after schema.sql and profile_avatars.sql.
begin;

create or replace function public.get_public_profile(target_profile_id uuid)
returns table (
  id uuid,
  display_name text,
  username text,
  avatar_url text,
  avatar_path text,
  bio text,
  status_message text,
  updated_at timestamptz
)
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
    select p.id, p.display_name, p.username, p.avatar_url, p.avatar_path,
      p.bio, p.status_message, p.updated_at
    from public.profiles p
    where p.id = target_profile_id;
end;
$$;
revoke all on function public.get_public_profile(uuid) from public;
grant execute on function public.get_public_profile(uuid) to authenticated;

create or replace function public.search_public_profiles(search_term text, result_limit integer default 30)
returns table (
  id uuid,
  display_name text,
  username text,
  avatar_url text,
  avatar_path text,
  bio text,
  status_message text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_term text := lower(trim(coalesce(search_term, '')));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if char_length(normalized_term) < 2 or char_length(normalized_term) > 40 then
    return;
  end if;

  return query
    select p.id, p.display_name, p.username, p.avatar_url, p.avatar_path,
      p.bio, p.status_message, p.updated_at
    from public.profiles p
    where p.id <> auth.uid()
      and (
        position(normalized_term in lower(p.display_name)) > 0
        or position(normalized_term in lower(coalesce(p.username, ''))) > 0
      )
    order by lower(p.display_name), p.id
    limit least(greatest(coalesce(result_limit, 30), 1), 30);
end;
$$;
revoke all on function public.search_public_profiles(text, integer) from public;
grant execute on function public.search_public_profiles(text, integer) to authenticated;

create or replace function public.suggest_public_profiles(result_limit integer default 8)
returns table (
  id uuid,
  display_name text,
  username text,
  avatar_url text,
  avatar_path text,
  bio text,
  status_message text,
  updated_at timestamptz
)
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
    select p.id, p.display_name, p.username, p.avatar_url, p.avatar_path,
      p.bio, p.status_message, p.updated_at
    from public.profiles p
    where p.id <> auth.uid()
      and not exists (
        select 1
        from public.conversations c
        join public.conversation_members current_member
          on current_member.conversation_id = c.id
          and current_member.user_id = auth.uid()
        join public.conversation_members other_member
          on other_member.conversation_id = c.id
          and other_member.user_id = p.id
        where c.type = 'direct'
      )
    order by p.created_at desc nulls last, lower(p.display_name), p.id
    limit least(greatest(coalesce(result_limit, 8), 1), 12);
end;
$$;
revoke all on function public.suggest_public_profiles(integer) from public;
grant execute on function public.suggest_public_profiles(integer) to authenticated;

-- A private avatars bucket must allow signed reads for profiles found in the
-- authenticated directory. Upload, update, and delete remain owner-only.
drop policy if exists "Chat participants can view profile avatars" on storage.objects;
drop policy if exists "Authenticated users can view profile avatars" on storage.objects;
create policy "Authenticated users can view profile avatars"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars');

notify pgrst, 'reload schema';
commit;
