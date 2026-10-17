-- WingTips — Supabase schema
-- Safe to run multiple times (idempotent) — run this in the Supabase SQL editor.
-- Backs up the client-side @klm.com check (src/App.tsx AuthScreen) with real server-side
-- enforcement: anyone calling the Supabase API directly, bypassing the app's own JS check,
-- gets rejected here too. No profiles table needed — this is a pure gate, not account storage.

create or replace function handle_new_user() returns trigger as $$
begin
  if new.email !~* '@klm\.com$' then
    raise exception 'Only @klm.com e-mail addresses can create an account.';
  end if;
  return new;
end; $$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created before insert on auth.users
  for each row execute procedure handle_new_user();

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
