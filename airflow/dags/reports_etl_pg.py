from __future__ import annotations

import pendulum
import pandas as pd
from sqlalchemy import text

from airflow.decorators import dag, task
from airflow.providers.postgres.hooks.postgres import PostgresHook

TZ = "UTC"

def _engine(conn_id: str):
    """SQLAlchemy engine из Airflow Connection."""
    return PostgresHook(postgres_conn_id=conn_id).get_sqlalchemy_engine()

@dag(
    dag_id="reports_etl_pg",
    schedule="15 2 * * *",  # ежедневно в 02:15
    start_date=pendulum.datetime(2025, 1, 1, tz=TZ),
    catchup=False,
    max_active_runs=1,
    tags=["reports", "postgres"],
)
def reports_etl_pg():

    @task
    def extract_crm(data_interval_start=None, data_interval_end=None) -> str:
        """
        Берём изменённых пользователей из CRM в окне выполнения
        и сохраняем parquet во временный файл.
        """
        eng = _engine("crm_pg")
        query = """
            SELECT
              u.id::bigint          AS user_id,
              u.prosthesis_id::text AS prosthesis_id,
              u.region::text        AS region,
              u.doctor_id::bigint   AS doctor_id,
              u.plan_tier::text     AS plan_tier,
              u.updated_at          AS updated_at
            FROM crm.users u
            WHERE u.updated_at >= %(f)s AND u.updated_at < %(t)s
        """
        df = pd.read_sql_query(
            query, eng,
            params={"f": data_interval_start, "t": data_interval_end}
        )
        path = "/tmp/crm.parquet"
        df.to_parquet(path, index=False)
        return path

    @task
    def extract_telemetry(data_interval_start=None, data_interval_end=None) -> str:
        """
        Агрегируем телеметрию по дням/пользователям в окне выполнения,
        сохраняем parquet.
        """
        eng = _engine("app_pg")
        query = """
            SELECT
              t.user_id::bigint AS user_id,
              date_trunc('day', t.ts)::date AS d,
              count(*)::int AS sessions,
              avg(t.load)::real AS avg_load,
              sum(t.steps)::bigint AS steps,
              sum(t.usage_minutes)::bigint AS usage_minutes,
              max(t.ts) AS last_seen_at
            FROM app.telemetry t
            WHERE t.ts >= %(f)s AND t.ts < %(t)s
            GROUP BY 1,2
        """
        df = pd.read_sql_query(
            query, eng,
            params={"f": data_interval_start, "t": data_interval_end}
        )
        path = "/tmp/tel.parquet"
        df.to_parquet(path, index=False)
        return path

    @task
    def load_staging(crm_path: str, tel_path: str) -> None:
        """
        Грузим parquet-файлы в стейджинг таблицы в схеме reports.
        """
        eng = _engine("olap_pg")

        # CRM → reports.stg_crm_users
        df_crm = pd.read_parquet(crm_path)
        if not df_crm.empty:
            df_crm.to_sql(
                "stg_crm_users", eng,
                schema="reports",
                if_exists="append", index=False,
                method="multi", chunksize=5000
            )

        # Telemetry (суточная) → reports.stg_telemetry_daily
        df_tel = pd.read_parquet(tel_path)
        if not df_tel.empty:
            df_tel.to_sql(
                "stg_telemetry_daily", eng,
                schema="reports",
                if_exists="append", index=False,
                method="multi", chunksize=5000
            )

    @task
    def build_datamart(data_interval_start=None, data_interval_end=None) -> None:
        """
        Пересобираем витрину за окно выполнения:
        - удаляем срез из dm_user_usage_daily
        - вставляем свежий слой из стейджинга
        """
        eng = _engine("olap_pg")
        f_date = data_interval_start.date()
        t_date = data_interval_end.date()
        t_ts   = data_interval_end  # для среза "актуальное состояние CRM к концу окна"

        with eng.begin() as conn:
            # Идемпотентность: удаляем целевой срез
            conn.execute(
                text("""
                    DELETE FROM reports.dm_user_usage_daily
                    WHERE d >= :f AND d < :t
                """),
                {"f": f_date, "t": t_date}
            )

            # Вставляем объединённые данные
            conn.execute(
                text("""
                    INSERT INTO reports.dm_user_usage_daily (
                      user_id, d, prosthesis_id, region, doctor_id, plan_tier,
                      sessions, avg_load, steps, usage_minutes, last_seen_at
                    )
                    SELECT
                      t.user_id, t.d,
                      c.prosthesis_id, c.region, c.doctor_id, c.plan_tier,
                      t.sessions, t.avg_load, t.steps, t.usage_minutes, t.last_seen_at
                    FROM reports.stg_telemetry_daily t
                    LEFT JOIN (
                      SELECT DISTINCT ON (user_id)
                        user_id, prosthesis_id, region, doctor_id, plan_tier, updated_at
                      FROM reports.stg_crm_users
                      WHERE updated_at < :t_ts
                      ORDER BY user_id, updated_at DESC
                    ) c USING (user_id)
                    WHERE t.d >= :f AND t.d < :t
                """),
                {"f": f_date, "t": t_date, "t_ts": t_ts}
            )

    c = extract_crm()
    t = extract_telemetry()
    load_staging(c, t) >> build_datamart()

reports_etl_pg()
