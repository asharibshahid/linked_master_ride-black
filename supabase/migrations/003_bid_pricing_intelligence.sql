alter table bids
  add column if not exists estimated_cost numeric(10, 2),
  add column if not exists estimated_profit numeric(10, 2),
  add column if not exists margin_percent numeric(6, 2),
  add column if not exists linked_saving numeric(10, 2),
  add column if not exists ai_decision text,
  add column if not exists pricing_confidence text,
  add column if not exists pricing_payload jsonb;

create index if not exists idx_bids_ai_decision
  on bids (ai_decision)
  where deleted_at is null;
