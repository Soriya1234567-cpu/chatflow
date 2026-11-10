-- Repair restrictive chat-attachment policies on installations that ran
-- messaging_media.sql before those policies were scoped to their bucket.
begin;

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

commit;
