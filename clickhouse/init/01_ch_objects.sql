CREATE DATABASE IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.customers_kafka
(
  id UInt64,
  name String,
  email String,
  op String,
  `source.ts_ms` Nullable(Int64)
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'crm.public.customers',
  kafka_group_name = 'ch-customers',
  kafka_format = 'JSONEachRow';

CREATE TABLE IF NOT EXISTS analytics.orders_kafka
(
  id UInt64,
  customer_id UInt64,
  amount Float64,
  status String,
  op String,
  `source.ts_ms` Nullable(Int64)
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'crm.public.orders',
  kafka_group_name = 'ch-orders',
  kafka_format = 'JSONEachRow';

CREATE TABLE IF NOT EXISTS analytics.customers_raw
(
  id UInt64,
  name String,
  email String,
  created_at DateTime,
  source_ts_ms Int64
)
ENGINE = ReplacingMergeTree(source_ts_ms)
ORDER BY id;

CREATE TABLE IF NOT EXISTS analytics.orders_raw
(
  id UInt64,
  customer_id UInt64,
  amount Float64,
  status String,
  created_at DateTime,
  source_ts_ms Int64
)
ENGINE = ReplacingMergeTree(source_ts_ms)
ORDER BY id;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_customers_to_raw
TO analytics.customers_raw AS
SELECT
  id,
  name,
  email,
  toDateTime(ifNull(`source.ts_ms`, 0) / 1000) AS created_at,
  ifNull(`source.ts_ms`, 0) AS source_ts_ms
FROM analytics.customers_kafka
WHERE op != 'd';

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_orders_to_raw
TO analytics.orders_raw AS
SELECT
  id,
  customer_id,
  amount,
  status,
  toDateTime(ifNull(`source.ts_ms`, 0) / 1000) AS created_at,
  ifNull(`source.ts_ms`, 0) AS source_ts_ms
FROM analytics.orders_kafka
WHERE op != 'd';

CREATE TABLE IF NOT EXISTS analytics.orders_summary
(
  customer_id UInt64,
  orders_count UInt64,
  total_amount Float64
)
ENGINE = SummingMergeTree
ORDER BY customer_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_raw_to_summary
TO analytics.orders_summary AS
SELECT
  customer_id,
  countIf(status = 'paid') AS orders_count,
  sumIf(amount, status = 'paid') AS total_amount
FROM analytics.orders_raw
GROUP BY customer_id;

CREATE OR REPLACE VIEW analytics.vw_customer_revenue AS
SELECT
  s.customer_id,
  c.customer_name,
  s.orders_count,
  s.total_amount
FROM
(
  SELECT
    customer_id,
    sum(orders_count) AS orders_count,
    sum(total_amount) AS total_amount
  FROM analytics.orders_summary
  GROUP BY customer_id
) AS s
LEFT JOIN
(
  SELECT
    id AS customer_id,
    argMax(name, source_ts_ms) AS customer_name
  FROM analytics.customers_raw
  GROUP BY id
) AS c
ON c.customer_id = s.customer_id;
