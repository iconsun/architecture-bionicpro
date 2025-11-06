const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);
const { Pool } = require("pg");
const { HeadObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3 } = require("./s3Client");

const bucket = process.env.S3_BUCKET || "reports";
const cdnBase = process.env.CDN_BASE || "http://cdn/reports";

const pool = new Pool({
  host: process.env.PGHOST || "keycloak_db",
  port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "keycloak_db",
  user: process.env.PGUSER || "keycloak_user",
  password: process.env.PGPASSWORD || "keycloak_password",
});

function toCsv(rows) {
  const head = "date,user_id,prosthesis_id,region,plan_tier,sessions,avg_load,steps,usage_minutes,last_seen_at";
  const body = rows.map((r) => [
    r.d,
    r.user_id,
    r.prosthesis_id ?? "",
    r.region ?? "",
    r.plan_tier ?? "",
    r.sessions ?? 0,
    r.avg_load ?? 0,
    r.steps ?? 0,
    r.usage_minutes ?? 0,
    r.last_seen_at ?? "",
  ].join(","));
  return [head, ...body].join("\\n");
}

function versionKey(userId, dateISO, v) {
  const ver = v || dayjs().utc().format("YYYYMMDDHHmm");
  return `users/${userId}/daily/${dateISO}/report-${ver}.csv`;
}

async function getReportCdnUrl(userId, dateISO) {
  const d = dateISO || dayjs().utc().format("YYYY-MM-DD");

  // 1) сначала пробуем alias latest.csv (короткий TTL у CDN)
  const latestKey = `users/${userId}/daily/${d}/latest.csv`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: latestKey }));
    return `${cdnBase}/${latestKey}`;
  } catch { /* miss -> генерим */ }

  // 2) читаем витрину из OLAP
  const { rows } = await pool.query(`
    SELECT
      to_char(d,'YYYY-MM-DD') AS d,
      user_id, prosthesis_id, region, plan_tier,
      sessions, avg_load, steps, usage_minutes,
      to_char(last_seen_at,'YYYY-MM-DD HH24:MI') AS last_seen_at
    FROM reports.dm_user_usage_daily
    WHERE user_id = $1 AND d = $2::date
    ORDER BY d, user_id
  `, [userId, d]);

  const csv = toCsv(rows);

  // 3) кладем immutable-версию + alias latest
  const verKey = versionKey(userId, d);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: verKey,
    Body: csv,
    ContentType: "text/csv",
    CacheControl: "public, max-age=31536000, immutable",
  }));

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: latestKey,
    Body: csv,
    ContentType: "text/csv",
    CacheControl: "public, max-age=60",
  }));

  return `${cdnBase}/${verKey}`;
}

module.exports = { getReportCdnUrl };
