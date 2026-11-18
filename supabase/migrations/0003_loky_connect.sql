-- 0003_loky_connect.sql — LOKY CONNECT upgrade
--
-- ADDITIVE ONLY. Safe to run twice. There is no DROP TABLE, no DELETE, no
-- TRUNCATE and no column removal. The two constraints that are dropped are
-- immediately re-created (looser, never tighter) so media-only messages and
-- profile bios become possible without touching existing rows.
--
-- Run this in the Supabase Dashboard → SQL Editor for project
-- jqnzfuimnkghwqccyosw. It builds on 0001_username_system.sql and
-- 0002_friends_admin.sql, which must already be applied.

begin;

-- ── 1. profiles: avatar, bio, privacy ───────────────────────────────────────
alter table public.profiles
  add column if not exists avatar_url           text,
  add column if not exists bio                  text,
  add column if not exists privacy_last_seen    boolean not null default true,
  add column if not exists privacy_discoverable boolean not null default true;

alter table public.profiles drop constraint if exists profiles_bio_len;
alter table public.profiles
  add constraint profiles_bio_len
  check (bio is null or char_length(bio) <= 160);

alter table public.profiles drop constraint if exists profiles_avatar_url_len;
alter table public.profiles
  add constraint profiles_avatar_url_len
  check (avatar_url is null or char_length(avatar_url) <= 500);

-- 0002 granted UPDATE column-by-column. New columns need their own grant or a
-- client PATCH is refused even when RLS allows the row.
grant update (avatar_url, bio, privacy_last_seen, privacy_discoverable)
  on public.profiles to authenticated;

-- ── 2. messages: media, replies, soft delete ────────────────────────────────
alter table public.messages
  add column if not exists media_path   text,
  add column if not exists media_type   text,
  add column if not exists reply_to_id  uuid references public.messages (id) on delete set null,
  add column if not exists deleted_at   timestamptz;

-- Old rule: body must be 1..4000 chars, so a photo-only message was impossible.
-- New rule: still <= 4000, and body may be empty ONLY when media is attached.
alter table public.messages drop constraint if exists messages_body_length;
alter table public.messages
  add constraint messages_body_length
  check (
    char_length(body) <= 4000
    and (char_length(body) >= 1 or media_path is not null)
  );

alter table public.messages drop constraint if exists messages_media_type_check;
alter table public.messages
  add constraint messages_media_type_check
  check (media_type is null or media_type in ('image', 'video'));

alter table public.messages drop constraint if exists messages_media_path_len;
alter table public.messages
  add constraint messages_media_path_len
  check (media_path is null or char_length(media_path) <= 400);

create index if not exists messages_conv_live_idx
  on public.messages (conversation_id, created_at desc)
  where deleted_at is null;

-- ── 3. reactions ────────────────────────────────────────────────────────────
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji),
  constraint message_reactions_emoji_len check (char_length(emoji) between 1 and 8)
);

alter table public.message_reactions enable row level security;

drop policy if exists "reactions: read as member"   on public.message_reactions;
drop policy if exists "reactions: insert as self"   on public.message_reactions;
drop policy if exists "reactions: delete own"       on public.message_reactions;

create policy "reactions: read as member"
  on public.message_reactions for select
  to authenticated
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_id and public.is_conversation_member(m.conversation_id)
    )
  );

create policy "reactions: insert as self"
  on public.message_reactions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_id and public.is_conversation_member(m.conversation_id)
    )
  );

create policy "reactions: delete own"
  on public.message_reactions for delete
  to authenticated
  using (user_id = auth.uid());

-- ── 4. read receipts ────────────────────────────────────────────────────────
create table if not exists public.message_receipts (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.message_receipts enable row level security;

drop policy if exists "receipts: read own"    on public.message_receipts;
drop policy if exists "receipts: upsert own"  on public.message_receipts;
drop policy if exists "receipts: update own"  on public.message_receipts;

create policy "receipts: read own"
  on public.message_receipts for select
  to authenticated
  using (user_id = auth.uid() or public.is_conversation_member(conversation_id));

create policy "receipts: upsert own"
  on public.message_receipts for insert
  to authenticated
  with check (user_id = auth.uid() and public.is_conversation_member(conversation_id));

create policy "receipts: update own"
  on public.message_receipts for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── 5. typing presence (ephemeral, one row per member) ──────────────────────
create table if not exists public.connect_typing (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  updated_at      timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.connect_typing enable row level security;

drop policy if exists "typing: read as member" on public.connect_typing;
drop policy if exists "typing: write self"     on public.connect_typing;
drop policy if exists "typing: update self"    on public.connect_typing;

create policy "typing: read as member"
  on public.connect_typing for select
  to authenticated
  using (public.is_conversation_member(conversation_id));

create policy "typing: write self"
  on public.connect_typing for insert
  to authenticated
  with check (user_id = auth.uid() and public.is_conversation_member(conversation_id));

create policy "typing: update self"
  on public.connect_typing for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── 6. notifications ────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  kind            text not null,
  actor_id        uuid references auth.users (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete cascade,
  message_id      uuid references public.messages (id) on delete cascade,
  body            text,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  constraint notifications_kind_check
    check (kind in ('friend_request', 'friend_accepted', 'message', 'reaction')),
  constraint notifications_body_len check (body is null or char_length(body) <= 200)
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists "notifications: read own"   on public.notifications;
drop policy if exists "notifications: update own" on public.notifications;
drop policy if exists "notifications: delete own" on public.notifications;

create policy "notifications: read own"
  on public.notifications for select
  to authenticated
  using (user_id = auth.uid());

create policy "notifications: update own"
  on public.notifications for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "notifications: delete own"
  on public.notifications for delete
  to authenticated
  using (user_id = auth.uid());

-- Deliberately NO insert policy: a user can never write into someone else's
-- inbox. Rows are created only by the SECURITY DEFINER triggers below.

create or replace function public.notify_friend_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.notifications (user_id, kind, actor_id, body)
  values (new.receiver_id, 'friend_request', new.sender_id, 'sent you a friend request');
  return new;
end;
$$;

drop trigger if exists friend_request_notify on public.friend_requests;
create trigger friend_request_notify
  after insert on public.friend_requests
  for each row when (new.status = 'pending')
  execute function public.notify_friend_request();

create or replace function public.notify_friend_accepted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    insert into public.notifications (user_id, kind, actor_id, body)
    values (new.sender_id, 'friend_accepted', new.receiver_id, 'accepted your friend request');
  end if;
  return new;
end;
$$;

drop trigger if exists friend_request_accepted_notify on public.friend_requests;
create trigger friend_request_accepted_notify
  after update of status on public.friend_requests
  for each row execute function public.notify_friend_accepted();

create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.notifications (user_id, kind, actor_id, conversation_id, message_id, body)
  select m.user_id,
         'message',
         new.sender_id,
         new.conversation_id,
         new.id,
         left(coalesce(nullif(new.body, ''), case when new.media_type = 'video' then 'Sent a video' else 'Sent a photo' end), 120)
  from public.conversation_members m
  where m.conversation_id = new.conversation_id
    and m.user_id <> new.sender_id;
  return new;
end;
$$;

drop trigger if exists message_notify on public.messages;
create trigger message_notify
  after insert on public.messages
  for each row execute function public.notify_new_message();

-- ── 7. read helpers ─────────────────────────────────────────────────────────
create or replace function public.connect_can_read_media(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_first text;
begin
  v_first := split_part(coalesce(object_name, ''), '/', 1);

  -- Profile pictures live at avatars/<user id>/… and any signed-in user may
  -- read one, which is the point of an avatar. Writes are owner-only and are
  -- enforced separately by connect_can_write_media().
  if v_first = 'avatars' then
    return true;
  end if;

  if v_first !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  return public.is_conversation_member(v_first::uuid);
end;
$$;

-- Write side of the same rule: chat media may only be written by a member of
-- the conversation whose id is the first path segment, and avatars only by the
-- user whose id is the second segment.
create or replace function public.connect_can_write_media(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_first  text;
  v_second text;
begin
  if auth.uid() is null then
    return false;
  end if;

  v_first  := split_part(coalesce(object_name, ''), '/', 1);
  v_second := split_part(coalesce(object_name, ''), '/', 2);

  if v_first = 'avatars' then
    return v_second = auth.uid()::text;
  end if;

  if v_first !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  return public.is_conversation_member(v_first::uuid);
end;
$$;

-- ── 8. connect_threads(): chat list with peer, preview and unread count ──────
create or replace function public.connect_threads()
returns table (
  conversation_id   uuid,
  peer_id           uuid,
  peer_username     text,
  peer_display_name text,
  peer_avatar_url   text,
  peer_last_seen    timestamptz,
  last_body         text,
  last_media_type   text,
  last_sender_id    uuid,
  last_at           timestamptz,
  unread_count      bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with mine as (
    select cm.conversation_id
    from public.conversation_members cm
    where cm.user_id = auth.uid()
  ),
  peer as (
    select cm.conversation_id, cm.user_id
    from public.conversation_members cm
    join mine on mine.conversation_id = cm.conversation_id
    where cm.user_id <> auth.uid()
  )
  select c.id,
         p.user_id,
         pr.username,
         pr.display_name,
         pr.avatar_url,
         case when coalesce(pr.privacy_last_seen, true) then pr.last_seen_at else null end,
         lm.body,
         lm.media_type,
         lm.sender_id,
         coalesce(lm.created_at, c.created_at) as last_at,
         (
           select count(*)
           from public.messages m2
           where m2.conversation_id = c.id
             and m2.sender_id <> auth.uid()
             and m2.deleted_at is null
             and m2.created_at > coalesce(
               (select r.last_read_at
                  from public.message_receipts r
                 where r.conversation_id = c.id and r.user_id = auth.uid()),
               '-infinity'::timestamptz
             )
         ) as unread_count
  from mine
  join public.conversations c on c.id = mine.conversation_id
  left join peer p on p.conversation_id = c.id
  left join public.profiles pr on pr.id = p.user_id
  left join lateral (
    select m.body, m.media_type, m.sender_id, m.created_at
    from public.messages m
    where m.conversation_id = c.id and m.deleted_at is null
    order by m.created_at desc
    limit 1
  ) lm on true
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

-- ── 9. connect_messages(): one conversation, newest first, with reactions ───
create or replace function public.connect_messages(conv uuid, max_rows int default 60)
returns table (
  id            uuid,
  sender_id     uuid,
  body          text,
  media_path    text,
  media_type    text,
  reply_to_id   uuid,
  reply_body    text,
  reply_sender  uuid,
  deleted_at    timestamptz,
  created_at    timestamptz,
  sender_username text,
  sender_display  text,
  sender_avatar   text,
  reactions     jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_conversation_member(conv) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;

  return query
  select m.id,
         m.sender_id,
         m.body,
         m.media_path,
         m.media_type,
         m.reply_to_id,
         rp.body,
         rp.sender_id,
         m.deleted_at,
         m.created_at,
         pr.username,
         pr.display_name,
         pr.avatar_url,
         coalesce(
           (select jsonb_agg(jsonb_build_object('emoji', r.emoji, 'user_id', r.user_id))
              from public.message_reactions r
             where r.message_id = m.id),
           '[]'::jsonb
         )
  from public.messages m
  left join public.messages rp on rp.id = m.reply_to_id
  left join public.profiles pr on pr.id = m.sender_id
  where m.conversation_id = conv
  order by m.created_at desc
  limit greatest(1, least(coalesce(max_rows, 60), 200));
end;
$$;

-- ── 10. connect_send_message(): text and/or media, optional reply ───────────
create or replace function public.connect_send_message(
  conv uuid,
  body text default '',
  media_path text default null,
  media_type text default null,
  reply_to uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := coalesce(body, '');
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  if not public.is_conversation_member(conv) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;

  v_body := left(v_body, 4000);
  if char_length(v_body) = 0 and media_path is null then
    raise exception 'message is empty' using errcode = '22023';
  end if;
  if media_type is not null and media_type not in ('image', 'video') then
    raise exception 'unsupported media type' using errcode = '22023';
  end if;
  if media_path is not null and media_path not like conv::text || '/%' then
    raise exception 'media path must live under the conversation folder' using errcode = '22023';
  end if;

  insert into public.messages (conversation_id, sender_id, body, media_path, media_type, reply_to_id)
  values (
    conv,
    auth.uid(),
    v_body,
    media_path,
    media_type,
    case when reply_to is null then null else reply_to end
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ── 11. read state, reactions, deletion, typing ─────────────────────────────
create or replace function public.connect_mark_read(conv uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_conversation_member(conv) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;

  insert into public.message_receipts (conversation_id, user_id, last_read_at)
  values (conv, auth.uid(), now())
  on conflict (conversation_id, user_id)
  do update set last_read_at = excluded.last_read_at;
end;
$$;

create or replace function public.connect_react(message_id uuid, emoji text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv uuid;
begin
  select m.conversation_id into v_conv from public.messages m where m.id = message_id;
  if v_conv is null or not public.is_conversation_member(v_conv) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;
  if emoji is null or char_length(emoji) = 0 or char_length(emoji) > 8 then
    raise exception 'invalid reaction' using errcode = '22023';
  end if;

  insert into public.message_reactions (message_id, user_id, emoji)
  values (message_id, auth.uid(), emoji)
  on conflict do nothing;
end;
$$;

create or replace function public.connect_unreact(message_id uuid, emoji text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.message_reactions
  where message_id = connect_unreact.message_id
    and user_id = auth.uid()
    and emoji = connect_unreact.emoji;
end;
$$;

create or replace function public.connect_delete_message(message_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.messages
     set deleted_at = now(), body = '', media_path = null, media_type = null
   where id = connect_delete_message.message_id
     and sender_id = auth.uid()
     and deleted_at is null;

  if not found then
    raise exception 'only the sender can delete their own message' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.connect_set_typing(conv uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_conversation_member(conv) then
    return;
  end if;

  insert into public.connect_typing (conversation_id, user_id, updated_at)
  values (conv, auth.uid(), now())
  on conflict (conversation_id, user_id)
  do update set updated_at = now();
end;
$$;

create or replace function public.connect_typing_status(conv uuid)
returns table (user_id uuid, username text, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.user_id, pr.username, t.updated_at
  from public.connect_typing t
  left join public.profiles pr on pr.id = t.user_id
  where t.conversation_id = conv
    and t.user_id <> auth.uid()
    and t.updated_at > now() - interval '8 seconds'
    and public.is_conversation_member(conv);
$$;

-- ── 12. profile, notifications ──────────────────────────────────────────────
create or replace function public.connect_set_profile(
  display_name text default null,
  bio text default null,
  avatar_url text default null,
  privacy_last_seen boolean default null,
  privacy_discoverable boolean default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = '42501';
  end if;

  update public.profiles
     set display_name          = coalesce(left(nullif(btrim(connect_set_profile.display_name), ''), 60), display_name),
         bio                   = coalesce(left(nullif(btrim(connect_set_profile.bio), ''), 160), bio),
         avatar_url            = coalesce(left(nullif(btrim(connect_set_profile.avatar_url), ''), 500), avatar_url),
         privacy_last_seen     = coalesce(connect_set_profile.privacy_last_seen, privacy_last_seen),
         privacy_discoverable  = coalesce(connect_set_profile.privacy_discoverable, privacy_discoverable),
         updated_at            = now()
   where id = auth.uid();
end;
$$;

create or replace function public.connect_notifications(max_rows int default 30)
returns table (
  id uuid,
  kind text,
  actor_id uuid,
  actor_username text,
  actor_avatar text,
  conversation_id uuid,
  message_id uuid,
  body text,
  read_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.id,
         n.kind,
         n.actor_id,
         pr.username,
         pr.avatar_url,
         n.conversation_id,
         n.message_id,
         n.body,
         n.read_at,
         n.created_at
  from public.notifications n
  left join public.profiles pr on pr.id = n.actor_id
  where n.user_id = auth.uid()
  order by n.created_at desc
  limit greatest(1, least(coalesce(max_rows, 30), 100));
$$;

create or replace function public.connect_mark_notifications_read()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.notifications
     set read_at = now()
   where user_id = auth.uid() and read_at is null;
$$;

-- ── 13. private media bucket + policies ─────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'connect-media',
  'connect-media',
  false,
  26214400,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif',
        'video/mp4', 'video/webm', 'video/quicktime']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "connect media: read as member"   on storage.objects;
drop policy if exists "connect media: upload as member" on storage.objects;
drop policy if exists "connect media: delete own"       on storage.objects;

create policy "connect media: read as member"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'connect-media' and public.connect_can_read_media(name));

create policy "connect media: upload as member"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'connect-media' and public.connect_can_write_media(name));

create policy "connect media: delete own"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'connect-media' and owner::text = auth.uid()::text);

-- ── 14. execute grants ──────────────────────────────────────────────────────
grant execute on function public.connect_can_read_media(text)            to authenticated;
grant execute on function public.connect_can_write_media(text)           to authenticated;
grant execute on function public.connect_threads()                       to authenticated;
grant execute on function public.connect_messages(uuid, int)             to authenticated;
grant execute on function public.connect_send_message(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.connect_mark_read(uuid)                 to authenticated;
grant execute on function public.connect_react(uuid, text)               to authenticated;
grant execute on function public.connect_unreact(uuid, text)             to authenticated;
grant execute on function public.connect_delete_message(uuid)            to authenticated;
grant execute on function public.connect_set_typing(uuid)                to authenticated;
grant execute on function public.connect_typing_status(uuid)             to authenticated;
grant execute on function public.connect_set_profile(text, text, text, boolean, boolean) to authenticated;
grant execute on function public.connect_notifications(int)              to authenticated;
grant execute on function public.connect_mark_notifications_read()       to authenticated;
grant execute on function public.connect_can_read_media(text)            to authenticated;

commit;
