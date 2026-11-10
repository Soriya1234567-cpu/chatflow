-- Incremental profile editor and avatar Storage migration.
-- Safe to run after schema.sql on existing ChatFlow installations.
begin;

alter table public.profiles
  add column if not exists username text,
  add column if not exists avatar_path text,
  add column if not exists bio text,
  add column if not exists status_message text,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_username_format') then
    alter table public.profiles add constraint profiles_username_format
      check (username is null or (char_length(trim(username)) between 2 and 30 and username ~ '^[a-zA-Z0-9._-]+$'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_display_name_length') then
    alter table public.profiles add constraint profiles_display_name_length
      check (char_length(trim(display_name)) between 1 and 40);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_bio_length') then
    alter table public.profiles add constraint profiles_bio_length
      check (bio is null or char_length(trim(bio)) between 1 and 180);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_status_message_length') then
    alter table public.profiles add constraint profiles_status_message_length
      check (status_message is null or char_length(trim(status_message)) between 1 and 80);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_avatar_path_owner') then
    alter table public.profiles add constraint profiles_avatar_path_owner
      check (avatar_path is null or avatar_path like id::text || '/%');
  end if;
end
$$;

create unique index if not exists profiles_username_unique
  on public.profiles (lower(username))
  where username is not null and username <> '';

create or replace function public.set_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_profile_updated_at();

alter table public.profiles enable row level security;
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

revoke update on public.profiles from authenticated;
revoke update (id, display_name, email, username, avatar_url, avatar_path, bio, status_message, created_at, updated_at)
  on public.profiles from authenticated;
grant update (display_name, username, avatar_url, avatar_path, bio, status_message)
  on public.profiles to authenticated;
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their own avatars" on storage.objects;
drop policy if exists "Users can update their own avatars" on storage.objects;
drop policy if exists "Users can delete their own avatars" on storage.objects;
drop policy if exists "Public avatars are viewable" on storage.objects;
drop policy if exists "Chat participants can view profile avatars" on storage.objects;

create policy "Users can upload their own avatars"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "Users can update their own avatars"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "Users can delete their own avatars"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "Chat participants can view profile avatars"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'avatars'
    and case
      when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (storage.foldername(name))[1] = auth.uid()::text
        or public.shares_conversation_with((storage.foldername(name))[1]::uuid, auth.uid())
      else false
    end
  );

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
    ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
