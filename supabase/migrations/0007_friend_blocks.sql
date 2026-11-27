-- LOKY AI Next — Friend management (remove friend, block user, unblock user).
--
-- ADDITIVE ONLY. Nothing here drops, renames or truncates an existing object and
-- no existing row is deleted except the friendship/pending-request rows that a
-- remove/block action is explicitly meant to change. Chat history is untouched:
-- messages, conversations, media and memories all stay exactly as they are.
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- CREATE INDEX IF NOT EXISTS and DROP ... IF EXISTS before CREATE TRIGGER/POLICY.
--
-- Security model
--   * user_blocks is readable by its owner only (blocker_id = auth.uid()).
--     There is deliberately NO insert/update/delete policy, so the table can
--     only be written by the SECURITY DEFINER functions below. A blocked user
--     can therefore never read, forge or delete the block row.
--   * Blocks are enforced in the database, not the browser: BEFORE INSERT
--     triggers on messages / friend_requests / message_reactions / connect_typing
--     raise `user_blocked` even when someone calls PostgREST directly with a
--     valid JWT and skips the app UI entirely.
--   * The messages INSERT policy is additionally hardened with
--     `not conversation_blocked(...)` as defence in depth.
--   * Unblocking is allowed only for the person who created the block.
--   * EXECUTE is least-privilege. PostgreSQL grants EXECUTE to PUBLIC on every
--     new function, so "grant ... to authenticated" on its own still left these
--     callable by anon. Every function below is explicitly revoked from PUBLIC
--     and anon; only the four client-facing RPCs are granted back to
--     authenticated, plus conversation_blocked because an RLS policy invokes it
--     as the caller. is_blocked stays owner-only: only SECURITY DEFINER code
--     calls it, and that code runs with the owner's privileges.
--   * Trigger functions keep their default grants on purpose: PostgreSQL
--     requires the role that fires a trigger to hold EXECUTE on the trigger
--     function, so revoking there would break message sending itself. They
--     return type `trigger`, which PostgREST cannot expose as an RPC.

begin;

/* --------------------------------- blocks --------------------------------- */

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

-- Reverse lookups ("did anyone block me?") are the hot path for every guard.
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);

alter table public.user_blocks enable row level security;

drop policy if exists "blocks: read own" on public.user_blocks;
create policy "blocks: read own"
  on public.user_blocks for select
  to authenticated
  using (blocker_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies on purpose: writes go through the RPCs.

/* --------------------------------- helpers -------------------------------- */

-- A block is symmetric for enforcement purposes: it does not matter who
-- blocked whom, the two people may no longer interact.
create or replace function public.is_blocked(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_blocks bl
    where (bl.blocker_id = a and bl.blocked_id = b)
       or (bl.blocker_id = b and bl.blocked_id = a)
  );
$$;

-- True when the caller and any other member of the conversation have blocked
-- each other. Used by triggers and the messages INSERT policy.
create or replace function public.conversation_blocked(conv uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.conversation_members me
    join public.conversation_members peer
      on peer.conversation_id = me.conversation_id
     and peer.user_id <> me.user_id
    where me.conversation_id = conv
      and me.user_id = auth.uid()
      and public.is_blocked(me.user_id, peer.user_id)
  );
$$;

-- Least privilege on the internal helpers.
--   is_blocked is never referenced by an RLS policy: it is called only from
--   conversation_blocked and the BEFORE INSERT/UPDATE trigger functions, all of
--   which are SECURITY DEFINER and therefore run as the owner. No signed-in or
--   anonymous client needs EXECUTE on it, so it is removed from every role.
revoke all on function public.is_blocked(uuid, uuid) from public, anon, authenticated;

--   conversation_blocked IS referenced by the messages INSERT policy, and policy
--   expressions are evaluated as the invoking role, so authenticated keeps
--   EXECUTE. PUBLIC and anon lose it.
revoke all on function public.conversation_blocked(uuid) from public, anon;
grant execute on function public.conversation_blocked(uuid) to authenticated;

/* ------------------------------- remove friend ---------------------------- */

create or replace function public.remove_friend(other_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  removed int := 0;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if other_user is null then
    raise exception 'invalid_recipient' using errcode = '22023';
  end if;
  if other_user = me then
    raise exception 'cannot_remove_self' using errcode = '22023';
  end if;

  delete from public.friendships f
   where (f.user_a = me and f.user_b = other_user)
      or (f.user_a = other_user and f.user_b = me);
  get diagnostics removed = row_count;

  -- Deliberately no block row: the two people may become friends again.
  return jsonb_build_object(
    'removed', removed > 0,
    'user_id', other_user,
    'blocked', false
  );
end;
$$;

/* ---------------------------------- block --------------------------------- */

create or replace function public.block_user(other_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if other_user is null then
    raise exception 'invalid_recipient' using errcode = '22023';
  end if;
  if other_user = me then
    raise exception 'cannot_block_self' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.id = other_user) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  insert into public.user_blocks (blocker_id, blocked_id)
  values (me, other_user)
  on conflict (blocker_id, blocked_id) do nothing;

  -- Blocking ends the friendship in both directions...
  delete from public.friendships f
   where (f.user_a = me and f.user_b = other_user)
      or (f.user_a = other_user and f.user_b = me);

  -- ...and clears any request either of them still has in flight.
  update public.friend_requests r
     set status = 'cancelled',
         responded_at = now()
   where r.status = 'pending'
     and ((r.sender_id = me and r.receiver_id = other_user)
       or (r.sender_id = other_user and r.receiver_id = me));

  return jsonb_build_object('blocked', true, 'user_id', other_user);
end;
$$;

/* --------------------------------- unblock -------------------------------- */

create or replace function public.unblock_user(other_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  removed int := 0;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if other_user is null then
    raise exception 'invalid_recipient' using errcode = '22023';
  end if;

  -- Only the blocker may undo their own block.
  delete from public.user_blocks bl
   where bl.blocker_id = me and bl.blocked_id = other_user;
  get diagnostics removed = row_count;

  if removed = 0 then
    raise exception 'block_not_found' using errcode = 'P0002';
  end if;

  -- Being unblocked does not silently restore a friendship.
  return jsonb_build_object('blocked', false, 'user_id', other_user);
end;
$$;

/* ----------------------------- blocked list ------------------------------- */

create or replace function public.my_blocked_users()
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_seed text,
  blocked_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id,
         p.username,
         p.display_name,
         p.avatar_seed,
         bl.created_at
  from public.user_blocks bl
  join public.profiles p on p.id = bl.blocked_id
  where bl.blocker_id = auth.uid()
  order by bl.created_at desc;
$$;

-- The four client-callable RPCs. Revoking from PUBLIC is what actually removes
-- the implicit anon access; the explicit anon/authenticated revoke keeps the
-- intent readable and makes the script safe to re-run.
revoke all on function public.remove_friend(uuid)     from public, anon, authenticated;
revoke all on function public.block_user(uuid)        from public, anon, authenticated;
revoke all on function public.unblock_user(uuid)      from public, anon, authenticated;
revoke all on function public.my_blocked_users()      from public, anon, authenticated;

grant execute on function public.remove_friend(uuid)     to authenticated;
grant execute on function public.block_user(uuid)        to authenticated;
grant execute on function public.unblock_user(uuid)      to authenticated;
grant execute on function public.my_blocked_users()      to authenticated;

/* ---------------------- database-side block enforcement ------------------- */

-- Messages: covers connect_send_message AND a raw PostgREST insert.
create or replace function public.enforce_no_blocked_messages()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.conversation_blocked(new.conversation_id) then
    raise exception 'user_blocked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_block_guard on public.messages;
create trigger messages_block_guard
  before insert on public.messages
  for each row execute function public.enforce_no_blocked_messages();

-- Friend requests: nobody blocked may open a request, and a request cannot be
-- accepted across a block. Cancelling (used by block_user) stays allowed.
create or replace function public.enforce_no_blocked_requests()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_blocked(new.sender_id, new.receiver_id) then
      raise exception 'user_blocked' using errcode = 'P0001';
    end if;
  elsif new.status = 'accepted' and coalesce(old.status, '') <> 'accepted' then
    if public.is_blocked(new.sender_id, new.receiver_id) then
      raise exception 'user_blocked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists friend_requests_block_guard on public.friend_requests;
create trigger friend_requests_block_guard
  before insert or update on public.friend_requests
  for each row execute function public.enforce_no_blocked_requests();

-- Reactions: a blocked person cannot react in your conversation.
create or replace function public.enforce_no_blocked_reactions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  conv uuid;
begin
  select m.conversation_id into conv from public.messages m where m.id = new.message_id;
  if conv is not null and public.conversation_blocked(conv) then
    raise exception 'user_blocked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists reactions_block_guard on public.message_reactions;
create trigger reactions_block_guard
  before insert on public.message_reactions
  for each row execute function public.enforce_no_blocked_reactions();

-- Typing indicators: stops the "typing…" flicker from a blocked account.
create or replace function public.enforce_no_blocked_typing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.conversation_blocked(new.conversation_id) then
    raise exception 'user_blocked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists typing_block_guard on public.connect_typing;
create trigger typing_block_guard
  before insert or update on public.connect_typing
  for each row execute function public.enforce_no_blocked_typing();

/* ------------------------- defence in depth on RLS ------------------------ */

-- Same intent as the 0001 policy, plus the block check, so even a policy-only
-- path refuses the insert.
drop policy if exists "messages: insert as self" on public.messages;
create policy "messages: insert as self"
  on public.messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_conversation_member(conversation_id)
    and not public.conversation_blocked(conversation_id)
  );

commit;
