-- Per-user removal and restoration of direct-chat contacts.
-- Run after schema.sql in Supabase Dashboard -> SQL Editor.
begin;

alter table public.conversation_members
  add column if not exists hidden_at timestamptz;

create or replace function public.set_direct_contact_hidden(target_conversation uuid, is_hidden boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.conversations c
    join public.conversation_members cm on cm.conversation_id = c.id
    where c.id = target_conversation
      and c.type = 'direct'
      and cm.user_id = auth.uid()
  ) then
    raise exception 'Direct conversation not found or access denied';
  end if;

  update public.conversation_members
  set hidden_at = case when is_hidden then now() else null end
  where conversation_id = target_conversation
    and user_id = auth.uid();
end;
$$;

revoke all on function public.set_direct_contact_hidden(uuid, boolean) from public;
grant execute on function public.set_direct_contact_hidden(uuid, boolean) to authenticated;

commit;
