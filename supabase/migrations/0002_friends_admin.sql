-- LOKY AI Next — Friend Requests + Admin Dashboard (RBAC + moderation audit).
--
-- ADDITIVE ONLY. Nothing here drops, renames or truncates an existing object.
-- The AI assistant, the local Messages history and the existing Mini Chat
-- tables/functions from 0001 are left exactly as they are.
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- ADD COLUMN IF NOT EXISTS and DROP ... IF EXISTS before CREATE.
--
-- Security model
--   * Friend requests are only written through SECURITY DEFINER functions, so
--     the client can never forge a request as somebody else, never create a
--     friendship directly, and never respond to a request it does not own.
--   * RLS stays ON for every new table. Reads are limited to the two people
--     involved (or to admins, for the audit log only).
--   * Admin powers are checked in the database (public.is_admin()), not in the
--     browser. The server also re-checks them per request before calling these
--     functions, so a frontend-only flag can never grant moderation access.
--   * public.profiles.is_admin / status cannot be changed by a normal user:
--     the columns are not granted for UPDATE and a trigger rejects any change
--     that was not made by an authorised admin function.
--   * admin_audit_log is append-only (trigger blocks UPDATE/DELETE).
--   * No service-role key is used by the browser or by these functions.

-- ---------------------------------------------------------------------------
-- 1. Profile columns: admin flag, account status, presence
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists status text not null default 'active';
alter table public.profiles add column if not exists last_seen_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_status_check'
  ) then
    alter table public.profiles
      add constraint profiles_status_check
      check (status in ('active', 'suspended', 'deactivated'));
  end if;
end $$;

-- Column-level privilege: a user may update only their own descriptive fields.
-- is_admin and status are deliberately excluded, so privilege escalation via a
-- plain PATCH /rest/v1/profiles is impossible even if an UPDATE policy allows
-- the row. Table-level UPDATE is revoked first, otherwise the column grant
-- would be irrelevant (a table grant covers every column).
revoke update on public.profiles from authenticated;
grant update (username, display_name, avatar_seed, last_seen_at, updated_at)
  on public.profiles to authenticated;

-- Second layer: even an owner-run update cannot flip privileges unless an
-- authorised admin function asked for it in this transaction.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_admin is distinct from old.is_admin or new.status is distinct from old.status then
    if coalesce(current_setting('loky.admin_write', true), '') <> 'on' then
      raise exception 'privilege_change_not_allowed' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_privileges on public.profiles;
create trigger profiles_guard_privileges
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ---------------------------------------------------------------------------
-- 2. is_admin() — the single source of truth for RBAC
-- ---------------------------------------------------------------------------

create or replace function public.is_admin(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = uid
      and p.is_admin is true
      and p.status = 'active'
  );
$$;

revoke all on function public.is_admin(uuid) from public;
revoke all on function public.is_admin(uuid) from anon;
grant execute on function public.is_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Friend requests + friendships
-- ---------------------------------------------------------------------------

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  receiver_id uuid not null references auth.users (id) on delete cascade,
  -- unordered pair key: the database itself blocks a second pending request
  -- between the same two people in either direction.
  pair_key text not null,
  status text not null default 'pending',
  note text,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint friend_requests_status_check
    check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  constraint friend_requests_not_self check (sender_id <> receiver_id),
  constraint friend_requests_note_len check (note is null or char_length(note) <= 200)
);

create unique index if not exists friend_requests_one_pending_per_pair
  on public.friend_requests (pair_key)
  where status = 'pending';

create index if not exists friend_requests_receiver_idx
  on public.friend_requests (receiver_id, status);
create index if not exists friend_requests_sender_idx
  on public.friend_requests (sender_id, status);

create table if not exists public.friendships (
  user_a uuid not null references auth.users (id) on delete cascade,
  user_b uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint friendships_ordered check (user_a < user_b)
);

create index if not exists friendships_user_b_idx on public.friendships (user_b);

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;

drop policy if exists "friend_requests: read own" on public.friend_requests;
create policy "friend_requests: read own"
  on public.friend_requests for select to authenticated
  using (sender_id = auth.uid() or receiver_id = auth.uid());

drop policy if exists "friendships: read own" on public.friendships;
create policy "friendships: read own"
  on public.friendships for select to authenticated
  using (user_a = auth.uid() or user_b = auth.uid());

-- No INSERT/UPDATE/DELETE policies on purpose: writes go through the
-- functions below, which validate the caller.

-- ---------------------------------------------------------------------------
-- 4. Reports (user-submitted, for the moderation queue)
-- ---------------------------------------------------------------------------

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  message_id uuid references public.messages (id) on delete cascade,
  reason text not null,
  details text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_by uuid references auth.users (id),
  resolution_note text,
  constraint reports_status_check
    check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  constraint reports_target_present
    check (conversation_id is not null or message_id is not null),
  constraint reports_reason_len check (char_length(reason) between 1 and 120),
  constraint reports_details_len
    check (details is null or char_length(details) <= 2000)
);

create index if not exists reports_status_idx on public.reports (status, created_at desc);
create index if not exists reports_conversation_idx on public.reports (conversation_id);
create index if not exists reports_reporter_idx on public.reports (reporter_id);

alter table public.reports enable row level security;

drop policy if exists "reports: read own" on public.reports;
create policy "reports: read own"
  on public.reports for select to authenticated
  using (reporter_id = auth.uid());

drop policy if exists "reports: insert own" on public.reports;
create policy "reports: insert own"
  on public.reports for insert to authenticated
  with check (reporter_id = auth.uid());

-- Admins read the queue through admin_list_reports(), never through RLS.

-- ---------------------------------------------------------------------------
-- 5. Append-only admin audit log
-- ---------------------------------------------------------------------------

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_id uuid not null references auth.users (id),
  action text not null,
  target_type text,
  target_id text,
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_admin_idx
  on public.admin_audit_log (admin_id, created_at desc);

create or replace function public.admin_audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log_is_append_only' using errcode = '42501';
end;
$$;

drop trigger if exists admin_audit_log_no_change on public.admin_audit_log;
create trigger admin_audit_log_no_change
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_log_immutable();

alter table public.admin_audit_log enable row level security;

-- Only admins may read the log, and only through the function below.
drop policy if exists "admin_audit_log: admins read" on public.admin_audit_log;
create policy "admin_audit_log: admins read"
  on public.admin_audit_log for select to authenticated
  using (public.is_admin());

revoke update, delete on public.admin_audit_log from authenticated;
revoke update, delete on public.admin_audit_log from anon;

-- ---------------------------------------------------------------------------
-- 6. Realtime (ignore errors when the table is already published)
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    alter publication supabase_realtime add table public.friend_requests;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.friendships;
  exception when others then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Friend request RPCs
-- ---------------------------------------------------------------------------

create or replace function public.send_friend_request(other_user uuid, note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  target public.profiles%rowtype;
  existing public.friend_requests%rowtype;
  new_id uuid;
  key text;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if other_user is null then
    raise exception 'invalid_recipient' using errcode = '22023';
  end if;
  if other_user = me then
    raise exception 'cannot_request_self' using errcode = '22023';
  end if;

  select * into target from public.profiles where id = other_user;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if target.status <> 'active' then
    raise exception 'user_unavailable' using errcode = '42501';
  end if;

  key := case when me < other_user
              then me::text || ':' || other_user::text
              else other_user::text || ':' || me::text end;

  if exists (
    select 1 from public.friendships f
    where (f.user_a = me and f.user_b = other_user)
       or (f.user_a = other_user and f.user_b = me)
  ) then
    raise exception 'already_friends' using errcode = '23505';
  end if;

  -- Any pending request in either direction counts as a duplicate.
  select * into existing
  from public.friend_requests r
  where r.pair_key = key and r.status = 'pending'
  limit 1;
  if found then
    raise exception 'request_pending' using errcode = '23505';
  end if;

  begin
    insert into public.friend_requests (sender_id, receiver_id, pair_key, note)
    values (me, other_user, key, nullif(btrim(coalesce(note, '')), ''))
    returning id into new_id;
  exception when unique_violation then
    -- lost a race with a simultaneous request: still a duplicate, not an error
    raise exception 'request_pending' using errcode = '23505';
  end;

  return jsonb_build_object('id', new_id, 'status', 'pending');
end;
$$;

create or replace function public.respond_friend_request(request_id uuid, decision text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  req public.friend_requests%rowtype;
  a uuid;
  b uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if decision not in ('accept', 'reject') then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;

  select * into req from public.friend_requests where id = request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if req.receiver_id <> me then
    raise exception 'not_your_request' using errcode = '42501';
  end if;
  if req.status <> 'pending' then
    raise exception 'request_already_answered' using errcode = '22023';
  end if;

  if decision = 'accept' then
    update public.friend_requests
      set status = 'accepted', responded_at = now()
      where id = request_id;

    a := case when req.sender_id < req.receiver_id then req.sender_id else req.receiver_id end;
    b := case when req.sender_id < req.receiver_id then req.receiver_id else req.sender_id end;
    insert into public.friendships (user_a, user_b) values (a, b)
      on conflict (user_a, user_b) do nothing;

    return jsonb_build_object('status', 'accepted', 'other_id',
      case when req.sender_id = me then req.receiver_id else req.sender_id end);
  end if;

  update public.friend_requests
    set status = 'rejected', responded_at = now()
    where id = request_id;

  return jsonb_build_object('status', 'rejected');
end;
$$;

create or replace function public.cancel_friend_request(request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  req public.friend_requests%rowtype;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into req from public.friend_requests where id = request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if req.sender_id <> me then
    raise exception 'not_your_request' using errcode = '42501';
  end if;
  if req.status <> 'pending' then
    raise exception 'request_already_answered' using errcode = '22023';
  end if;

  update public.friend_requests
    set status = 'cancelled', responded_at = now()
    where id = request_id;

  return jsonb_build_object('status', 'cancelled');
end;
$$;

create or replace function public.my_friend_requests()
returns table (
  request_id uuid,
  direction text,
  other_id uuid,
  other_username text,
  other_display_name text,
  other_avatar_seed text,
  status text,
  note text,
  created_at timestamptz,
  responded_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id,
         case when r.sender_id = auth.uid() then 'outgoing' else 'incoming' end,
         p.id,
         p.username,
         p.display_name,
         p.avatar_seed,
         r.status,
         r.note,
         r.created_at,
         r.responded_at
  from public.friend_requests r
  join public.profiles p
    on p.id = case when r.sender_id = auth.uid() then r.receiver_id else r.sender_id end
  where (r.sender_id = auth.uid() or r.receiver_id = auth.uid())
  order by r.created_at desc
  limit 100;
$$;

create or replace function public.my_friends()
returns table (
  user_id uuid,
  username text,
  display_name text,
  avatar_seed text,
  friends_since timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.username, p.display_name, p.avatar_seed, f.created_at
  from public.friendships f
  join public.profiles p
    on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
  where f.user_a = auth.uid() or f.user_b = auth.uid()
  order by f.created_at desc;
$$;

create or replace function public.friend_status(other_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth.uid() is null or other_user is null then 'none'
    when other_user = auth.uid() then 'self'
    when exists (
      select 1 from public.friendships f
      where (f.user_a = auth.uid() and f.user_b = other_user)
         or (f.user_a = other_user and f.user_b = auth.uid())
    ) then 'friends'
    when exists (
      select 1 from public.friend_requests r
      where r.status = 'pending' and r.sender_id = auth.uid() and r.receiver_id = other_user
    ) then 'pending_out'
    when exists (
      select 1 from public.friend_requests r
      where r.status = 'pending' and r.sender_id = other_user and r.receiver_id = auth.uid()
    ) then 'pending_in'
    else 'none'
  end;
$$;

create or replace function public.touch_last_seen()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 8. User reporting (feeds the admin moderation queue)
-- ---------------------------------------------------------------------------

create or replace function public.report_content(
  reason text,
  conversation_id uuid default null,
  message_id uuid default null,
  details text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  conv uuid := conversation_id;
  new_id uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if reason is null or char_length(btrim(reason)) = 0 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if conversation_id is null and message_id is null then
    raise exception 'report_target_required' using errcode = '22023';
  end if;

  if message_id is not null then
    select m.conversation_id into conv from public.messages m where m.id = message_id;
    if conv is null then
      raise exception 'message_not_found' using errcode = 'P0002';
    end if;
  end if;

  -- A user may report only conversations they actually take part in.
  if not exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = conv and cm.user_id = me
  ) then
    raise exception 'not_a_participant' using errcode = '42501';
  end if;

  insert into public.reports (reporter_id, conversation_id, message_id, reason, details)
  values (me, conv, message_id, btrim(reason), nullif(btrim(coalesce(details, '')), ''))
  returning id into new_id;

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Admin RPCs — every one re-checks is_admin() and writes an audit row
-- ---------------------------------------------------------------------------

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'totalUsers', (select count(*) from auth.users),
    'activeUsers', (
      select count(*) from public.profiles
      where status = 'active'
        and (last_seen_at is null or last_seen_at > now() - interval '30 days')
    ),
    'suspendedUsers', (select count(*) from public.profiles where status = 'suspended'),
    'deactivatedUsers', (select count(*) from public.profiles where status = 'deactivated'),
    'totalConversations', (select count(*) from public.conversations),
    'totalMessages', (select count(*) from public.messages),
    'pendingFriendRequests', (
      select count(*) from public.friend_requests where status = 'pending'
    ),
    'openReports', (select count(*) from public.reports where status in ('open', 'reviewing')),
    'generatedAt', now()
  );
end;
$$;

create or replace function public.admin_search_users(term text)
returns table (
  id uuid,
  username text,
  display_name text,
  email text,
  status text,
  is_admin boolean,
  created_at timestamptz,
  last_seen_at timestamptz,
  conversation_count bigint,
  message_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  needle text := btrim(coalesce(term, ''));
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
    select p.id,
           p.username,
           p.display_name,
           u.email::text,
           p.status,
           p.is_admin,
           p.created_at,
           p.last_seen_at,
           (select count(*) from public.conversation_members cm where cm.user_id = p.id),
           (select count(*) from public.messages m where m.sender_id = p.id)
    from public.profiles p
    join auth.users u on u.id = p.id
    where needle = ''
       or p.username ilike '%' || needle || '%'
       or coalesce(p.display_name, '') ilike '%' || needle || '%'
       or u.email ilike '%' || needle || '%'
    order by p.created_at desc
    limit 25;
end;
$$;

create or replace function public.admin_set_user_status(
  target uuid,
  new_status text,
  reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  target_admin boolean;
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if new_status not in ('active', 'suspended', 'deactivated') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if reason is null or char_length(btrim(reason)) < 5 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if target = me then
    raise exception 'cannot_change_own_status' using errcode = '42501';
  end if;

  select is_admin into target_admin from public.profiles where id = target;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if target_admin then
    -- admins cannot suspend each other; prevents lockouts and admin wars
    raise exception 'cannot_change_admin_status' using errcode = '42501';
  end if;

  perform set_config('loky.admin_write', 'on', true);

  update public.profiles set status = new_status where id = target;

  insert into public.admin_audit_log (admin_id, action, target_type, target_id, reason, details)
  values (me, 'user.status_changed', 'user', target::text, btrim(reason),
          jsonb_build_object('new_status', new_status));

  return jsonb_build_object('id', target, 'status', new_status);
end;
$$;

create or replace function public.admin_list_reports(status_filter text default null)
returns table (
  id uuid,
  reporter_id uuid,
  reporter_username text,
  conversation_id uuid,
  message_id uuid,
  reason text,
  details text,
  status text,
  created_at timestamptz,
  resolution_note text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
    select r.id,
           r.reporter_id,
           p.username,
           r.conversation_id,
           r.message_id,
           r.reason,
           r.details,
           r.status,
           r.created_at,
           r.resolution_note
    from public.reports r
    left join public.profiles p on p.id = r.reporter_id
    where status_filter is null or r.status = status_filter
    order by r.created_at desc
    limit 100;
end;
$$;

create or replace function public.admin_update_report(
  report_id uuid,
  new_status text,
  note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if new_status not in ('open', 'reviewing', 'resolved', 'dismissed') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  update public.reports
    set status = new_status,
        updated_at = now(),
        resolution_note = nullif(btrim(coalesce(note, '')), ''),
        resolved_by = case when new_status in ('resolved', 'dismissed') then me else null end
    where id = report_id;

  if not found then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;

  insert into public.admin_audit_log (admin_id, action, target_type, target_id, reason, details)
  values (me, 'report.status_changed', 'report', report_id::text,
          nullif(btrim(coalesce(note, '')), ''),
          jsonb_build_object('new_status', new_status));

  return jsonb_build_object('id', report_id, 'status', new_status);
end;
$$;

-- Conversation review is limited to conversations that carry at least one
-- report, and requires a documented reason. Every access is logged.
create or replace function public.admin_review_conversation(conv uuid, reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  payload jsonb;
  msg_count bigint;
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if reason is null or char_length(btrim(reason)) < 10 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if conv is null then
    raise exception 'conversation_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.reports r where r.conversation_id = conv) then
    raise exception 'conversation_not_reported' using errcode = '42501';
  end if;

  select count(*) into msg_count from public.messages m where m.conversation_id = conv;

  select jsonb_build_object(
    'conversationId', conv,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'username', p.username,
        'displayName', p.display_name, 'avatarSeed', p.avatar_seed,
        'status', p.status
      ))
      from public.conversation_members cm
      join public.profiles p on p.id = cm.user_id
      where cm.conversation_id = conv
    ), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'senderId', m.sender_id, 'body', m.body,
        'createdAt', m.created_at
      ) order by m.created_at)
      from (
        select * from public.messages
        where conversation_id = conv
        order by created_at desc
        limit 200
      ) m
    ), '[]'::jsonb)
  ) into payload;

  insert into public.admin_audit_log (admin_id, action, target_type, target_id, reason, details)
  values (me, 'conversation.reviewed', 'conversation', conv::text, btrim(reason),
          jsonb_build_object('message_count', msg_count));

  return payload;
end;
$$;

create or replace function public.admin_audit_logs(max_rows int default 50)
returns table (
  id bigint,
  admin_id uuid,
  admin_username text,
  action text,
  target_type text,
  target_id text,
  reason text,
  details jsonb,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  cap int := least(greatest(coalesce(max_rows, 50), 1), 200);
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
    select l.id, l.admin_id, p.username, l.action, l.target_type,
           l.target_id, l.reason, l.details, l.created_at
    from public.admin_audit_log l
    left join public.profiles p on p.id = l.admin_id
    order by l.created_at desc
    limit cap;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants: authenticated only, never anon
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  fns text[] := array[
    'public.send_friend_request(uuid, text)',
    'public.respond_friend_request(uuid, text)',
    'public.cancel_friend_request(uuid)',
    'public.my_friend_requests()',
    'public.my_friends()',
    'public.friend_status(uuid)',
    'public.touch_last_seen()',
    'public.report_content(text, uuid, uuid, text)',
    'public.admin_dashboard_stats()',
    'public.admin_search_users(text)',
    'public.admin_set_user_status(uuid, text, text)',
    'public.admin_list_reports(text)',
    'public.admin_update_report(uuid, text, text)',
    'public.admin_review_conversation(uuid, text)',
    'public.admin_audit_logs(int)'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
