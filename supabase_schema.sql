-- WingTips — Supabase schema
-- Safe to run multiple times (idempotent) — run this in the Supabase SQL editor.
-- Backs up the client-side @klm.com check (src/App.tsx AuthScreen) with real server-side
-- enforcement: anyone calling the Supabase API directly, bypassing the app's own JS check,
-- gets rejected here too.

-- Logged once someone actually confirms their e-mail (clicks the confirmation/invite link), not
-- at signup-request time -- "a row got created" only means someone started the process, not that
-- they're a real user; the owner wants to know when someone's actually in, see
-- handle_user_confirmed further down. Readable only by the owner's own account (matched by email,
-- not a role/admin column -- there's exactly one owner); written only by that function, which runs
-- as security definer so it can insert here regardless of whose account just got confirmed.
create table if not exists admin_signup_log (
  id bigint generated always as identity primary key,
  email text not null,
  created_at timestamptz not null default now()
);
alter table admin_signup_log enable row level security;
drop policy if exists "admin_signup_log_select_owner" on admin_signup_log;
create policy "admin_signup_log_select_owner" on admin_signup_log for select using (lower(auth.jwt()->>'email') = 'roland.witkamp@klm.com');

-- Named exceptions to the @klm.com check below, for test accounts (e.g. a non-KLM person helping
-- test the app) that should be able to sign up anyway. Manage this from the Supabase dashboard's
-- Table Editor -- add or remove a row, no SQL needed. Not exposed via the API (no RLS policy
-- grants anon/authenticated access), only handle_new_user reads it, as security definer.
create table if not exists signup_allowlist (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);
alter table signup_allowlist enable row level security;

-- Schema-qualified (public.x) and search_path pinned below: the role that runs this trigger for
-- an admin-initiated "Invite user" turned out to have a different/narrower search_path than the
-- one used for normal self-signup, so the unqualified table names resolved fine during testing
-- earlier (self-signup) but failed with "relation does not exist" the first time this ran via
-- Invite user. Qualifying explicitly is also the standard safe pattern for a security definer
-- function regardless -- it shouldn't depend on whatever search_path the caller happens to have.
create or replace function handle_new_user() returns trigger as $$
begin
  if new.email !~* '@klm\.com$' and not exists (
    select 1 from public.signup_allowlist where lower(email) = lower(new.email)
  ) then
    raise exception 'Only @klm.com e-mail addresses can create an account.';
  end if;
  return new;
end; $$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created before insert on auth.users
  for each row execute procedure handle_new_user();

-- Fires once, exactly when email_confirmed_at first goes from null to set -- that's the same
-- underlying event for both self-signup (clicking the confirmation link) and an admin invite
-- (accepting it), so this one trigger covers both without caring which path created the account.
create or replace function handle_user_confirmed() returns trigger as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    insert into public.admin_signup_log (email) values (new.email);
  end if;
  return new;
end; $$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update on auth.users
  for each row execute procedure handle_user_confirmed();

-- Dashboard changes needed too (can't be done via SQL):
-- Authentication -> Providers -> Email -> "Allow new users to sign up" ON, "Confirm email" ON.

-- Lets a signed-in user delete their own account (Profile -> Account -> Delete account) without
-- exposing the service-role key client-side: this function runs with elevated privileges
-- (security definer) but only ever deletes auth.uid()'s own row — a regular user only needs
-- EXECUTE on the function itself, nothing more.
create or replace function delete_own_account() returns void as $$
begin
  delete from auth.users where id = auth.uid();
end; $$ language plpgsql security definer;
grant execute on function delete_own_account() to authenticated;

-- ─── Cross-device sync ──────────────────────────────────────────────────────
-- Everything below used to live only in each browser's localStorage, so logging in on a
-- second device (or a new browser) started from scratch, and recommendations a crew member
-- added were never visible to anyone else -- only that one browser ever read them back.
-- These tables make it all real, shared, account-bound data.

-- One row per signed-in user: display profile plus small per-user UI state (which
-- destinations they've visited, which saved tips they've already seen) that doesn't
-- warrant its own table.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade
);
-- create table if not exists is a no-op when the table already exists, so if `profiles` was
-- created earlier (even just as a bare id column) with a since-updated version of this file,
-- the columns added later here never actually landed -- hence "PGRST204: could not find the
-- 'base' column" even though this script had "succeeded" every time it was run. Each column is
-- added individually and idempotently so the table is always brought up to the current shape
-- regardless of how or when it was first created.
alter table profiles add column if not exists name text not null default '';
alter table profiles add column if not exists role text not null default 'Cabin Crew';
alter table profiles add column if not exists base text not null default 'AMS';
alter table profiles add column if not exists bio text not null default '';
alter table profiles add column if not exists recent_destinations text[] not null default '{}';
alter table profiles add column if not exists favorites_seen text[] not null default '{}';
alter table profiles add column if not exists updated_at timestamptz not null default now();
-- This table turned out to predate this file, left over from an earlier approval-gated design
-- (approved/rejected/is_admin, same pattern as Pillow Report) that WingTips doesn't use -- those
-- three columns all have a false default so they don't block anything, but email is required with
-- no default, which rejected every insert that didn't set it. Not used by the app for anything
-- (crew tips show the display name, not the login email), so the simplest fix is to stop
-- requiring it rather than having every write carry it just to satisfy the column.
alter table profiles alter column email drop not null;
alter table profiles enable row level security;
-- Was select-own-only, but every tip already copies the author's name/role onto the
-- recommendation row itself (author_name/author_role) and shows it to any signed-in crew member
-- -- so a display name isn't private within the app. Broadened to let any signed-in user look up
-- another profile's id/name/role, which the connections feature needs to show who a pending
-- request or an accepted connection actually is.
drop policy if exists "profiles_select_own" on profiles;
drop policy if exists "profiles_select_all" on profiles;
create policy "profiles_select_all" on profiles for select using (auth.role() = 'authenticated');
drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles for insert with check (auth.uid() = id);
drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles for update using (auth.uid() = id);

-- Real crew-to-crew connections: a request from one account to another, accepted or still
-- pending. Replaces the old `connections` table below (free-typed name, no real account link, no
-- consent from the other side) -- that table is left in place but unused; there's no reliable way
-- to map its name strings onto real accounts, so anyone who had old-style connections needs to
-- re-send a real request. Declared before `recommendations` because its select policy (further
-- down) checks this table for an accepted connection to decide whether a connections-only tip is
-- visible to the current user.
create table if not exists connection_requests (
  id bigint generated always as identity primary key,
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
alter table connection_requests enable row level security;
drop policy if exists "connreq_select_own" on connection_requests;
create policy "connreq_select_own" on connection_requests for select using (auth.uid() = requester_id or auth.uid() = addressee_id);
drop policy if exists "connreq_insert_own" on connection_requests;
create policy "connreq_insert_own" on connection_requests for insert with check (auth.uid() = requester_id);
-- Either side can update: the addressee accepts a pending request, but either side also needs to
-- be able to delete an accepted row to "remove" a connection (handled by the delete policy below).
drop policy if exists "connreq_update_addressee" on connection_requests;
create policy "connreq_update_addressee" on connection_requests for update using (auth.uid() = addressee_id or auth.uid() = requester_id);
drop policy if exists "connreq_delete_own" on connection_requests;
create policy "connreq_delete_own" on connection_requests for delete using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- Recommendations ("crew tips"): shared with every signed-in crew member, writable only by
-- their own author. author_name/author_role are copied from the profile at post time (same
-- display behaviour as before), so they don't need a join back to profiles to render.
create table if not exists recommendations (
  id bigint generated always as identity primary key,
  destination_code text not null,
  category text not null,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null,
  author_role text not null,
  text text not null,
  price text,
  hours text,
  discount text,
  jetlag_proof boolean not null default false,
  solo_friendly boolean not null default false,
  quick_bite boolean not null default false,
  crew_friendly boolean not null default false,
  visibility text not null default 'public',
  tags text[],
  photo text,
  coords jsonb,
  created_at timestamptz not null default now()
);
alter table recommendations add column if not exists jetlag_proof boolean not null default false;
alter table recommendations add column if not exists solo_friendly boolean not null default false;
alter table recommendations add column if not exists quick_bite boolean not null default false;
alter table recommendations add column if not exists crew_friendly boolean not null default false;
-- Trips & Tours details (mode, guide contact, cost, duration, ...) and up to 6 resized photos.
alter table recommendations add column if not exists trip jsonb;
alter table recommendations add column if not exists photos jsonb;
-- Per-category extras: hiddenGem (any category), classes (fitness), nightlifeType (nightlife).
alter table recommendations add column if not exists extras jsonb;

-- Named lists of saved tips for an upcoming trip, private to their owner.
create table if not exists trip_lists (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  tip_keys text[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table trip_lists enable row level security;
drop policy if exists "trip_lists_own" on trip_lists;
create policy "trip_lists_own" on trip_lists for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
alter table trip_lists add column if not exists notes text;
alter table recommendations add column if not exists visibility text not null default 'public';
alter table recommendations enable row level security;
-- visibility='connections' tips are only readable by the author and their accepted connections
-- -- enforced here, at the database level, not just by hiding them in the UI, so the restriction
-- holds even for someone calling the Supabase API directly (same bar as the @klm.com signup gate
-- above). 'public' tips are unchanged: readable by any signed-in crew member.
drop policy if exists "recommendations_select_all" on recommendations;
drop policy if exists "recommendations_select_visible" on recommendations;
create policy "recommendations_select_visible" on recommendations for select using (
  visibility = 'public'
  or author_id = auth.uid()
  or exists (
    select 1 from connection_requests cr
    where cr.status = 'accepted'
      and ((cr.requester_id = auth.uid() and cr.addressee_id = recommendations.author_id)
        or (cr.addressee_id = auth.uid() and cr.requester_id = recommendations.author_id))
  )
);
drop policy if exists "recommendations_insert_own" on recommendations;
create policy "recommendations_insert_own" on recommendations for insert with check (auth.uid() = author_id);
drop policy if exists "recommendations_delete_own" on recommendations;
create policy "recommendations_delete_own" on recommendations for delete using (auth.uid() = author_id);
drop policy if exists "recommendations_update_own" on recommendations;
create policy "recommendations_update_own" on recommendations for update using (auth.uid() = author_id) with check (auth.uid() = author_id);
-- The app owner can remove anyone's tip (moderation); same single-owner email check as admin_signup_log.
drop policy if exists "recommendations_delete_admin" on recommendations;
create policy "recommendations_delete_admin" on recommendations for delete using (lower(auth.jwt()->>'email') = 'roland.witkamp@klm.com');

create table if not exists recommendation_comments (
  id bigint generated always as identity primary key,
  recommendation_id bigint not null references recommendations(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  role text not null,
  text text not null,
  created_at timestamptz not null default now()
);
alter table recommendation_comments enable row level security;
drop policy if exists "comments_select_all" on recommendation_comments;
create policy "comments_select_all" on recommendation_comments for select using (auth.role() = 'authenticated');
drop policy if exists "comments_insert_own" on recommendation_comments;
create policy "comments_insert_own" on recommendation_comments for insert with check (auth.uid() = author_id);

-- One row per (recommendation, user) so a like is a real toggle instead of an unbounded
-- "+1 on every tap" counter -- the count is just how many rows exist for that recommendation.
create table if not exists recommendation_likes (
  recommendation_id bigint not null references recommendations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (recommendation_id, user_id)
);
alter table recommendation_likes enable row level security;
drop policy if exists "likes_select_all" on recommendation_likes;
create policy "likes_select_all" on recommendation_likes for select using (auth.role() = 'authenticated');
drop policy if exists "likes_insert_own" on recommendation_likes;
create policy "likes_insert_own" on recommendation_likes for insert with check (auth.uid() = user_id);
drop policy if exists "likes_delete_own" on recommendation_likes;
create policy "likes_delete_own" on recommendation_likes for delete using (auth.uid() = user_id);

create table if not exists favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  tip_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, tip_key)
);
alter table favorites enable row level security;
drop policy if exists "favorites_select_own" on favorites;
create policy "favorites_select_own" on favorites for select using (auth.uid() = user_id);
drop policy if exists "favorites_insert_own" on favorites;
create policy "favorites_insert_own" on favorites for insert with check (auth.uid() = user_id);
drop policy if exists "favorites_delete_own" on favorites;
create policy "favorites_delete_own" on favorites for delete using (auth.uid() = user_id);

-- Deprecated: superseded by connection_requests above. Left in place (unused by the app) rather
-- than dropped, since dropping it would destroy whatever old name-tag data is in it.
create table if not exists connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  crew_name text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, crew_name)
);
alter table connections enable row level security;
drop policy if exists "connections_select_own" on connections;
create policy "connections_select_own" on connections for select using (auth.uid() = user_id);
drop policy if exists "connections_insert_own" on connections;
create policy "connections_insert_own" on connections for insert with check (auth.uid() = user_id);
drop policy if exists "connections_delete_own" on connections;
create policy "connections_delete_own" on connections for delete using (auth.uid() = user_id);

-- ─── AI Briefing ────────────────────────────────────────────────────────────
-- Cached per destination+category summary of that category's real crew tips, generated by the
-- generate-summary Edge Function (see supabase/functions/generate-summary). tip_count is the
-- number of recommendations the cached summary was generated from -- the function only
-- regenerates when that count has changed, so opening the same category repeatedly doesn't
-- re-call the AI every time. Clients only ever read this table; only the Edge Function (using the
-- service-role key, which bypasses RLS) writes to it, so there's no insert/update policy at all.
create table if not exists destination_summaries (
  destination_code text not null,
  category text not null,
  summary text not null,
  tip_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (destination_code, category)
);
alter table destination_summaries enable row level security;
drop policy if exists "summaries_select_all" on destination_summaries;
create policy "summaries_select_all" on destination_summaries for select using (auth.role() = 'authenticated');
