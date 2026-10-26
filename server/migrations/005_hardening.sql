-- Step 6: claims against groups, per-member confirmations, resume codes, review decisions.
alter table claims
  add column target_group_id  uuid references collision_groups(id),
  add column resume_code_hash text unique,
  add column review_decision  text check (review_decision in ('rejected', 'reopened')),
  add column reviewed_at      timestamptz;

-- At most one in-progress claim per group (the per-identity index stays too).
create unique index claims_one_open_per_group on claims(target_group_id)
  where target_group_id is not null and state in ('open', 'owner_confirmed', 'both_live', 'challenged');

-- Every current member of the target must confirm a claim.
create table claim_confirmations (
  claim_id     uuid not null references claims(id),
  identity_id  uuid not null references identities(id),
  confirmed_at timestamptz not null default now(),
  primary key (claim_id, identity_id)
);
