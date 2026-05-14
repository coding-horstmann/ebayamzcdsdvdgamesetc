-- MediaScout DE - Railway Postgres schema.
-- Wird beim App-Start automatisch angewendet, kann aber auch manuell ausgefuehrt werden.

create table if not exists products (
  id              bigserial primary key,
  asin            text not null unique,
  product_type    text not null check (product_type in ('BOARD_GAME','CD','DVD','GAME','FIGURE','PUZZLE','VINYL','MODEL_KIT')),
  product_code    text,
  title           text,
  brand           text,
  manufacturer    text,
  product_group   text,
  image_amazon    text,
  image_ebay      text,
  amazon_price    numeric(10,2),
  ebay_price      numeric(10,2),
  ebay_shipping   numeric(10,2),
  ebay_url        text,
  ebay_condition  text check (ebay_condition in ('NEW','USED')),
  ebay_buying_option text check (ebay_buying_option in ('FIXED_PRICE','AUCTION')),
  ebay_fixed_price numeric(10,2),
  ebay_fixed_shipping numeric(10,2),
  ebay_fixed_url text,
  ebay_fixed_image text,
  ebay_fixed_condition text check (ebay_fixed_condition in ('NEW','USED')),
  ebay_fixed_last_checked timestamptz,
  ebay_auction_price numeric(10,2),
  ebay_auction_shipping numeric(10,2),
  ebay_auction_url text,
  ebay_auction_image text,
  ebay_auction_condition text check (ebay_auction_condition in ('NEW','USED')),
  ebay_auction_end_time timestamptz,
  ebay_auction_bid_count integer,
  ebay_auction_last_checked timestamptz,
  bsr             integer,
  monthly_sales   integer,
  profit_euro     numeric(10,2) generated always as (
                    amazon_price - (ebay_price + ebay_shipping)
                  ) stored,
  roi_pct         numeric(10,2) generated always as (
                    case when (ebay_price + ebay_shipping) > 0
                    then ((amazon_price - (ebay_price + ebay_shipping))
                          / (ebay_price + ebay_shipping)) * 100
                    else null end
                  ) stored,
  fixed_profit_euro numeric(10,2) generated always as (
                    case when (ebay_fixed_price + ebay_fixed_shipping) > 0
                    then amazon_price - (ebay_fixed_price + ebay_fixed_shipping)
                    else null end
                  ) stored,
  fixed_roi_pct   numeric(10,2) generated always as (
                    case when (ebay_fixed_price + ebay_fixed_shipping) > 0
                    then ((amazon_price - (ebay_fixed_price + ebay_fixed_shipping))
                          / (ebay_fixed_price + ebay_fixed_shipping)) * 100
                    else null end
                  ) stored,
  auction_profit_euro numeric(10,2) generated always as (
                    case when (ebay_auction_price + ebay_auction_shipping) > 0
                    then amazon_price - (ebay_auction_price + ebay_auction_shipping)
                    else null end
                  ) stored,
  auction_roi_pct numeric(10,2) generated always as (
                    case when (ebay_auction_price + ebay_auction_shipping) > 0
                    then ((amazon_price - (ebay_auction_price + ebay_auction_shipping))
                          / (ebay_auction_price + ebay_auction_shipping)) * 100
                    else null end
                  ) stored,
  last_checked    timestamptz default now(),
  created_at      timestamptz default now()
);

alter table products
  drop constraint if exists products_product_type_check;

alter table products
  add constraint products_product_type_check
  check (product_type in ('BOARD_GAME','CD','DVD','GAME','FIGURE','PUZZLE','VINYL','MODEL_KIT'));

create index if not exists products_product_type_idx on products (product_type);
create index if not exists products_product_code_idx on products (product_code);
create index if not exists products_roi_pct_idx on products (roi_pct desc);
create index if not exists products_profit_euro_idx on products (profit_euro desc);
create index if not exists products_bsr_idx on products (bsr);
create index if not exists products_last_checked_idx on products (last_checked);
create index if not exists products_fixed_profit_euro_idx on products (fixed_profit_euro desc);
create index if not exists products_fixed_roi_pct_idx on products (fixed_roi_pct desc);
create index if not exists products_auction_profit_euro_idx on products (auction_profit_euro desc);
create index if not exists products_auction_roi_pct_idx on products (auction_roi_pct desc);
create index if not exists products_ebay_fixed_last_checked_idx on products (ebay_fixed_last_checked);
create index if not exists products_ebay_auction_last_checked_idx on products (ebay_auction_last_checked);

create table if not exists worker_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

create table if not exists worker_runs (
  id bigserial primary key,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_minutes numeric(10,2),
  status text not null check (status in ('running','done','done_with_warnings','aborted','error')),
  bsr_from integer,
  bsr_to integer,
  bsr_target integer,
  run_limit integer,
  keepa_upserts integer not null default 0,
  scanned integer not null default 0,
  fixed_hits integer not null default 0,
  auction_hits integer not null default 0,
  deals integer not null default 0,
  ebay_searches integer not null default 0,
  ebay_rate_limits integer not null default 0,
  ebay_errors integer not null default 0,
  gc_stale integer not null default 0,
  gc_missing_price integer not null default 0,
  error_messages text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists worker_runs_started_at_idx on worker_runs (started_at desc);
create index if not exists worker_runs_status_idx on worker_runs (status);
