-- Step 5: PINs. Failed group logins are throttled per group (never a member lock).
alter table group_login_attempts add column kind text not null default 'pin'
  check (kind in ('pin', 'recovery'));
alter table credentials add column pin_set_at timestamptz;
