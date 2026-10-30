-- LOKY AI Next — username system + real multi-user Mini Chat.
--
-- ADDITIVE ONLY. Creates four new tables and their helpers. It never drops,
-- renames or alters an existing object, so the AI assistant tables/behaviour
-- and the local Messages history are untouched.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / CREATE OR
-- REPLACE / DROP POLICY IF EXISTS before CREATE POLICY).
--
-- Security model
--   * profiles            : readable/writable only by its owner (id = auth.uid()).
--   * conversations       : readable only by members.
--   * conversation_members: readable only by members of that conversation.
--   * messages            : readable only by members; insertable only as yourself.
--   * username search     : the ONLY way to discover other users, through a
--                           SECURITY DEFINER function that returns just
--                           id/username/display_name/avatar_seed.
--   * no service-role key is used anywhere; RLS is the enforcement point.

-- --------------------------------------------------------------------------
-- 1. profiles
-- --------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null,
  display_name text,
  avatar_seed  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Mirrors public/username-utils.js exactly: 3-20 chars, a-z 0-9 _ only.
  -- Because stored usernames are already normalised to lowercase, this CHECK
  -- plus the unique index below also blocks case variants ("Alice"/"alice").
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$')
);

-- Case-insensitive uniqueness enforced by the database, not the frontend.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists "profiles: read own"   on public.profiles;
drop policy if exists "profiles: insert own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;

create policy "profiles: read own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy "profiles: insert own"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy "profiles: update own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No DELETE policy: profiles disappear only when the auth user is deleted.

-- Keep updated_at honest without trusting the client.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------------------
-- 2. conversations
-- --------------------------------------------------------------------------
create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null default 'direct' check (kind in ('direct', 'group')),
  created_by      uuid not null references auth.users (id) on delete cascade,
  -- Sorted "a:b" pair for direct chats -> at most ONE conversation per pair.
  dedupe_key      text unique,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

alter table public.conversations enable row level security;

-- Membership test used by several policies. SECURITY DEFINER so the policy can
-- read conversation_members without recursing into that table's own RLS.
create or replace function public.is_conversation_member(conv uuid, uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv and m.user_id = uid
  );
$$;

revoke all on function public.is_conversation_member(uuid, uuid) from public;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;

drop policy if exists "conversations: read as member"  on public.conversations;
drop policy if exists "conversations: insert as creator" on public.conversations;
drop policy if exists "conversations: update as member"  on public.conversations;

create policy "conversations: read as member"
  on public.conversations for select
  to authenticated
  using (public.is_conversation_member(id));

create policy "conversations: insert as creator"
  on public.conversations for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "conversations: update as member"
  on public.conversations for update
  to authenticated
  using (public.is_conversation_member(id))
  with check (public.is_conversation_member(id));

-- --------------------------------------------------------------------------
-- 3. conversation_members
-- --------------------------------------------------------------------------
create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id);

alter table public.conversation_members enable row level security;

drop policy if exists "members: read own conversations" on public.conversation_members;

-- A member can see the roster of conversations they belong to (needed to show
-- the other participant's name). Nothing outside their conversations leaks.
create policy "members: read own conversations"
  on public.conversation_members for select
  to authenticated
  using (public.is_conversation_member(conversation_id));

-- No INSERT/DELETE policies on purpose: memberships are created only by
-- public.start_conversation(), which runs as the definer and validates both
-- sides. This stops a user from adding themselves to someone else's chat.

-- --------------------------------------------------------------------------
-- 4. messages
-- --------------------------------------------------------------------------
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null references auth.users (id) on delete cascade,
  body            text not null,
  created_at      timestamptz not null default now(),
  constraint messages_body_length check (char_length(body) between 1 and 4000)
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

alter table public.messages enable row level security;

drop policy if exists "messages: read as member" on public.messages;
drop policy if exists "messages: insert as self" on public.messages;

create policy "messages: read as member"
  on public.messages for select
  to authenticated
  using (public.is_conversation_member(conversation_id));

-- sender_id must be you AND you must belong to the conversation: this is what
-- makes it impossible to post into a stranger's chat.
create policy "messages: insert as self"
  on public.messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_conversation_member(conversation_id)
  );

-- No UPDATE/DELETE policies: messages are immutable from the client.

-- Bump the conversation ordering timestamp on every new message.
create or replace function public.bump_conversation_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists messages_bump_activity on public.messages;
create trigger messages_bump_activity
  after insert on public.messages
  for each row execute function public.bump_conversation_activity();

-- --------------------------------------------------------------------------
-- 5. search_profiles(term) — the only user-discovery path
-- --------------------------------------------------------------------------
-- Returns a minimal, non-sensitive projection. Deliberately NOT a profiles
-- SELECT policy: a broad select policy would let any authenticated user dump
-- the whole directory. Requires >= 2 characters to avoid enumeration by
-- brute force, excludes yourself, caps the result set at 10.
create or replace function public.search_profiles(term text)
returns table (id uuid, username text, display_name text, avatar_seed text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.display_name, p.avatar_seed
    from public.profiles p
   where p.id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
     and char_length(btrim(coalesce(term, ''))) >= 2
     and p.username like lower(btrim(term)) || '%'
   order by p.username
   limit 10;
$$;

revoke all on function public.search_profiles(text) from public;
grant execute on function public.search_profiles(text) to authenticated;

-- --------------------------------------------------------------------------
-- 6. start_conversation(other_user) — idempotent, one chat per pair
-- --------------------------------------------------------------------------
-- Returns the existing direct conversation id when one already exists, so
-- "Add contact" twice can never create a duplicate thread.
create or replace function public.start_conversation(other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me      uuid := auth.uid();
  pairkey text;
  conv    uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if other_user is null or other_user = me then
    raise exception 'invalid_recipient' using errcode = '22023';
  end if;

  -- Only real, onboarded profiles can be messaged.
  if not exists (select 1 from public.profiles p where p.id = other_user) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  pairkey := least(me::text, other_user::text) || ':' || greatest(me::text, other_user::text);

  select c.id into conv
    from public.conversations c
   where c.dedupe_key = pairkey;

  if conv is null then
    insert into public.conversations (kind, created_by, dedupe_key)
    values ('direct', me, pairkey)
    on conflict (dedupe_key) do nothing
    returning id into conv;

    -- Lost a race: another request created it first, so read it back.
    if conv is null then
      select c.id into conv from public.conversations c where c.dedupe_key = pairkey;
    else
      insert into public.conversation_members (conversation_id, user_id)
      values (conv, me), (conv, other_user)
      on conflict do nothing;
    end if;
  end if;

  return conv;
end;
$$;

revoke all on function public.start_conversation(uuid) from public;
grant execute on function public.start_conversation(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- 7. my_conversations() — the Messages sidebar for the signed-in user
-- --------------------------------------------------------------------------
create or replace function public.my_conversations()
returns table (
  conversation_id uuid,
  other_id        uuid,
  other_username  text,
  other_display   text,
  other_avatar    text,
  last_message_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id,
         peer.user_id,
         p.username,
         p.display_name,
         p.avatar_seed,
         c.last_message_at
    from public.conversations c
    join public.conversation_members me
      on me.conversation_id = c.id and me.user_id = auth.uid()
    left join public.conversation_members peer
      on peer.conversation_id = c.id and peer.user_id <> auth.uid()
    left join public.profiles p on p.id = peer.user_id
   where c.kind = 'direct'
   order by c.last_message_at desc
   limit 100;
$$;

revoke all on function public.my_conversations() from public;
grant execute on function public.my_conversations() to authenticated;
