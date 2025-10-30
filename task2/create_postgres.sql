-- (1) отдельная схема под отчёты
CREATE SCHEMA IF NOT EXISTS reports;

-- (2) staging из CRM
CREATE TABLE IF NOT EXISTS reports.stg_crm_users (
  user_id       BIGINT,
  prosthesis_id TEXT,
  region        TEXT,
  doctor_id     BIGINT,
  plan_tier     TEXT,
  updated_at    TIMESTAMP NOT NULL
);

-- (3) staging суточной телеметрии
CREATE TABLE IF NOT EXISTS reports.stg_telemetry_daily (
  user_id        BIGINT     NOT NULL,
  d              DATE       NOT NULL,
  sessions       INTEGER,
  avg_load       REAL,
  steps          BIGINT,
  usage_minutes  BIGINT,
  last_seen_at   TIMESTAMP
);

-- (4) витрина
CREATE TABLE IF NOT EXISTS reports.dm_user_usage_daily (
  user_id       BIGINT NOT NULL,
  d             DATE   NOT NULL,
  prosthesis_id TEXT,
  region        TEXT,
  doctor_id     BIGINT,
  plan_tier     TEXT,
  sessions      INTEGER,
  avg_load      REAL,
  steps         BIGINT,
  usage_minutes BIGINT,
  last_seen_at  TIMESTAMP,
  PRIMARY KEY (user_id, d)
);

-- индексы на stg по окнам
CREATE INDEX IF NOT EXISTS ix_stg_crm_users_upd ON reports.stg_crm_users(updated_at);
CREATE INDEX IF NOT EXISTS ix_stg_tel_d ON reports.stg_telemetry_daily(d, user_id);
