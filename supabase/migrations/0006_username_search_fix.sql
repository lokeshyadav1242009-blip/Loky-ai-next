-- LOKY AI Next — username search fix.
--
-- SYMPTOM
--   Searching for a username that exists showed "Nobody matched that
--   username." even though the account was there.
--
-- ROOT CAUSE
--   public.search_profiles() matched with
--       p.username like lower(btrim(term)) || '%'
--   which is a PREFIX-ONLY match using the LIKE operator:
--     * typing any part of a username that is not its prefix (for example
--       "sharma" for "sunita_sharma") returns no rows;
--     * "_" is a single-character wildcard in LIKE, so usernames containing
--       an underscore match unpredictably;
--     * LIKE is not case-insensitive by itself.
--   The RPC therefore succeeded and returned zero rows, which the UI renders
--   as the empty state — not an error.
--
-- WHAT THIS DOES
--   Replaces ONLY the function body. The return signature is deliberately
--   unchanged (id, username, display_name, avatar_seed) so that:
--     * CREATE OR REPLACE cannot fail with "cannot change return type";
--     * the currently deployed client keeps working before and after;
--     * no column, table, policy or grant outside this function is touched.
--
-- SECURITY
--   * Still SECURITY DEFINER, so the owner-only "profiles: read own" RLS
--     policy is bypassed for discovery — RLS is NOT weakened or disabled.
--   * Returns only id, username, display_name, avatar_seed.
--     Email addresses are never selected, so they cannot leak.
--   * Excludes the caller, non-active accounts and rows without a username.
--   * EXECUTE is granted to authenticated only (anon cannot enumerate users).
--
-- Safe to re-run: single CREATE OR REPLACE.

create or replace function public.search_profiles(term text)
returns table (id uuid, username text, display_name text, avatar_seed text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select auth.uid() as uid
  ),
  needle as (
    -- Trim, drop any leading '@', lowercase. Empty becomes NULL so the
    -- length guard below short-circuits instead of matching everything.
    select nullif(
             lower(btrim(regexp_replace(coalesce(term, ''), '^@+', ''))),
             ''
           ) as q
  )
  select p.id, p.username, p.display_name, p.avatar_seed
    from public.profiles p
    cross join me
    cross join needle
   where me.uid is not null
     -- Never offer the caller as a contact.
     and p.id <> me.uid
     and needle.q is not null
     and char_length(needle.q) >= 2
     and p.username is not null
     and coalesce(p.status, 'active') = 'active'
     -- Case-insensitive exact OR partial match. strpos() is used instead of
     -- LIKE/ILIKE so that '_' and '%' inside a username are literal
     -- characters rather than wildcards.
     and (
       p.username = needle.q
       or strpos(lower(p.username), needle.q) > 0
     )
   order by
     -- Exact matches first, then earliest substring position, then A–Z.
     (p.username = needle.q) desc,
     strpos(lower(p.username), needle.q) asc,
     p.username asc
   limit 10;
$$;

revoke all on function public.search_profiles(text) from public;
revoke all on function public.search_profiles(text) from anon;
grant execute on function public.search_profiles(text) to authenticated;
