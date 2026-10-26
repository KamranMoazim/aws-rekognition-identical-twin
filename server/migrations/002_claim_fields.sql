-- Step 3: claim bookkeeping.
alter table claims
  add column owner_confirmed_at timestamptz,
  add column review_reason      text,
  add column closed_at          timestamptz;

create index claims_active_expiry_idx on claims(expires_at)
  where state in ('open', 'owner_confirmed', 'both_live', 'challenged');
