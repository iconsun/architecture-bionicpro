### Задание1
Задача 1 - лежит в task1
Задача 2 - в общем коде
Задача 3 - в общем коде
Задача 4 - в общем коде
Задача 5 - keycloak\keycloak-results-export.json
Задача 6 - Как я понял, надо использовать identity hub - но на данный момент он в стадии preview, доступ к которому нужно еще предварительно запросить. Я запросил доступ, но ждать некогда — поэтому использовал специальнй хак с OIDC. Но он работает криво. 

#### Что реализовано
- Authorization Code + PKCE (BFF генерирует verifier, хранит в сессии).
- BFF получает access/refresh, хранит refresh защищённо, access - в кэше.
- Session cookie HttpOnly + Secure, ротация session id.
- Keycloak: Access Token TTL < 2 мин, Refresh включён.
- MFA (OTP) - включен, Configure OTP = Default action.
- LDAP (OpenLDAP) - User Federation + group-mapper + role mappings.
- Яндекс через хак.


### Задание2
Задание выполнено без ClickHouse (сначал пропустил вниманием в условии), вместо него Postgres, а ClickHouse стал использовать в последнем задании.

Построить витрину в Postgres
task2/create_postgres.sql

Поднять:
docker compose up airflow-init
docker compose up -d airflow-webserver airflow-scheduler

UI: http://localhost:8082 (admin/admin)

Connections:
	crm_pg: Postgres - Host keycloak_db, Port 5432, DB keycloak_db, Extras {"options":"-c search_path=crm"}
	app_pg: Postgres - Host keycloak_db, Port 5432, DB keycloak_db, Extras {"options":"-c search_path=app"}
	olap_pg: Postgres - Host keycloak_db, Port 5432, DB keycloak_db
	DAG: reports_etl_pg (расписание 15 2 * * *), запустить: кнопка Trigger.

	Результат: таблица reports.dm_user_usage_daily в БД keycloak_db (схема reports).
	Порты: Airflow 8082, pgAdmin 5050, Keycloak 8080.


Залить демо данные, чтобы не ждать суточный DAG.
```sql
docker compose exec -T keycloak_db psql -U keycloak_user -d keycloak_db <<'SQL'
-- CRM: юзер изменён "сегодня 01:30 UTC" (это < 02:15, значит попадёт в окно)
INSERT INTO crm.users (id, prosthesis_id, region, doctor_id, plan_tier, updated_at)
VALUES (1001, 'PX-001', 'RU-MOW', 5001, 'gold',
        date_trunc('day', now()) + interval '1 hour 30 minutes')
ON CONFLICT (id) DO UPDATE
  SET updated_at = EXCLUDED.updated_at;

-- Телеметрия: события "сегодня между 01:00 и 02:00 UTC"
INSERT INTO app.telemetry (user_id, ts, load, steps, usage_minutes)
SELECT 1001,
       date_trunc('day', now()) + interval '1 hour' + (g || ' minutes')::interval,
       0.65, 120 + g, 6 + (g % 5)
FROM generate_series(0, 40, 5) g;
SQL
```

Запустить DAG для теста
```
docker compose exec airflow-webserver bash -lc "airflow dags trigger reports_etl_pg"
```


### Задание 3 
Кеширование отчётов (MinIO + Nginx CDN)

#### Доступ в MinIO
* URL: `http://localhost:9001/login`
* Логин/пароль: minio / minio12345

##### Что сделано
* Бэкенд `bionicpro-auth` по запросу генерирует CSV-отчёт, кладёт его в MinIO (S3) и отдаёт ссылку на CDN (Nginx).
* CDN берёт файлы из MinIO и кеширует их (разгружает OLAP/бэкенд).
* В S3 хранится «версионный» файл и «алиас»:

```
reports/users/{userId}/daily/{YYYY-MM-DD}/
report-YYYYMMDDHHmm.csv   # immutable, Cache-Control: 1 год
latest.csv                # алиас, Cache-Control: 60 сек
  ```

#### Как запустить
docker compose up -d minio cdn bionicpro-auth

#### Как проверить (что сдавать)
1. Запрос отчёта через API (создаётся файл в S3 и возвращается ссылка на CDN):

```bash
curl -s "http://localhost:8081/api/reports/1001/daily?date=$(date -u +%F)" | jq
# {"url":"http://cdn/reports/users/1001/daily/2025-10-30/report-202510300950.csv"}
```
Скрин этого ответа в task3.

2. Два запроса в CDN к алиасу — на первом `MISS`, на втором `HIT`:
```bash
curl -I "http://localhost:8083/reports/users/1001/daily/$(date -u +%F)/latest.csv"
# ... X-Cache: MISS

curl -I "http://localhost:8083/reports/users/1001/daily/$(date -u +%F)/latest.csv"
# ... X-Cache: HIT
```
Скрин терминала с двумя ответами в task3.

3. Скрин из MinIO Console с путём и файлами:
- `http://localhost:9001`  
- Bucket `reports` 
- `users/1001/daily/<сегодня>/` 
- видны `report-*.csv` и `latest.csv`.

Скрин этой страницы в task3.

#### Примечания
* Версионный файл помечен заголовком `Cache-Control: public, max-age=31536000, immutable`.
* Алиас `latest.csv` имеет `Cache-Control: public, max-age=60`, поэтому через ~1 минуту CDN сам обновит содержимое после новой генерации.
* Прямой доступ мимо CDN (для проверки содержимого):
  `http://localhost:9000/reports/users/1001/daily/$(date -u +%F)/latest.csv`.



### Задание 4
Проверка всего конвеера, что инкрементальные изменения из Postgres (INSERT/UPDATE) проходят по конвейеру
Postgres - Debezium/Kafka - ClickHouse (Kafka Engine - MV - ReplacingMergeTree) - витрина
и сразу отражаются в analytics.vw_customer_revenue
cкришотом лежат в папке task4/конвеер.png

**Что именно сделано**
- Завел публикацию в Postgres и настроили Debezium-коннектор (crm-connector-v2) c pgoutput, JSON-конвертерами и SMT ExtractNewRecordState.
- Убедился, что топики Kafka crm.public.customers и crm.public.orders есть и имеют оффсеты.
- Запустили материализованные представления в ClickHouse (SYSTEM START VIEW ...) - сообщения из Kafka начали складываться в analytics.*_raw, а агрегация - в analytics.orders_summary и далее в витрину analytics.vw_customer_revenue.
- Проверил end2end UPDATE: меняем статус заказа в Postgres - Debezium публикует событие - ClickHouse перечитывает и пересобирает агрегаты - строка/сумма клиента обновляется в витрине.


В `docker-compose.yaml` добавлены и настроены сервисы:
* `zookeeper`, `kafka`
* `connect` (Kafka Connect + Debezium, REST на `:8085`)
* `kafka-ui` (удобно смотреть топики, `:8090`)
* `clickhouse` (HTTP `:8123`)
* `crm_db` (Postgres с таблицами `public.customers`, `public.orders`)

## Конфиги и скрипты
* `debezium/connector.json` конфиг коннектора Debezium (Postgres, `pgoutput`, `publication.name=dbz_publication`, `decimal.handling.mode=double`, JSON-конвертеры, SMT `ExtractNewRecordState` с добавлением полей `op` и `source.ts_ms`).
* `clickhouse/01_ch_objects.sql`  создание таблиц `KafkaEngine`, сырых хранения на `ReplacingMergeTree`, агрегирующей таблицы и витрины, плюс MVs из Kafka - raw - summary.
  Скрипт монтируется в контейнер ClickHouse в `/docker-entrypoint-initdb.d/`.

`docker-compose.yaml`  с добавленными сервисами Kafka, Kafka Connect и ClickHouse
`debezium/connector.json`  рабочий конфиг Debezium коннектора.
`clickhouse/01_ch_objects.sql` скрипт с `KafkaEngine` таблицами, `Materialized View` и витриной.


