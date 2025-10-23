import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import axios from 'axios';
import crypto from 'crypto';
import { nanoid } from 'nanoid';

function parseSameSite(v?: string): boolean | 'lax' | 'strict' | 'none' | undefined {
  if (!v) return 'strict';
  const s = v.toLowerCase();
  if (s === 'lax' || s === 'strict' || s === 'none') return s;
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return 'strict';
}


const {
  PORT = '8081',
  FRONTEND_ORIGIN = 'http://localhost:3000',
  KC_AUTH, KC_TOKEN, KC_LOGOUT, KC_USERINFO,
  KC_CLIENT_ID, KC_CLIENT_SECRET,
  
  KC_PUBLIC_AUTH,
  KC_PUBLIC_LOGOUT,
    
  REDIRECT_URI,
  REDIS_URL,
  COOKIE_NAME = 'bpa.sid',
  COOKIE_DOMAIN = 'localhost',
  COOKIE_SECURE = 'false',
  COOKIE_SAMESITE = 'Strict',
  SESSION_TTL_SECONDS = '1800',
  ACCESS_EXPIRE_SKEW = '10',
  ENC_KEY_HEX
} = process.env as Record<string, string>;

const app = express();
app.use(cookieParser());
app.use(express.json());

// CORS для фронта + cookies
app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true
}));

const redis = new Redis(REDIS_URL);
const ENC_KEY = Buffer.from(ENC_KEY_HEX!, 'hex');

// --- утилиты шифрования refresh_token (AES-256-GCM) ---
function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(b64: string): string {
  const raw = Buffer.from(b64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

// --- временное хранение PKCE и state ---
const OAUTH_TMP_PREFIX = 'oauth:';
async function saveOauthTemp(state: string, data: any) {
  await redis.setex(OAUTH_TMP_PREFIX + state, 300, JSON.stringify(data));
}
async function loadOauthTemp(state: string) {
  const s = await redis.get(OAUTH_TMP_PREFIX + state);
  return s ? JSON.parse(s) : null;
}
async function delOauthTemp(state: string) {
  await redis.del(OAUTH_TMP_PREFIX + state);
}

// --- хранение сессий ---
const SESS_PREFIX = 'sess:';

type SessionData = {
  sub: string;
  username?: string;
  access_token: string;
  access_expires_at: number; // epoch secs
  refresh_token_enc: string;
};

async function setSession(sid: string, data: SessionData, ttlSec: number) {
  await redis.set(SESS_PREFIX + sid, JSON.stringify(data), 'EX', ttlSec);
}
async function getSession(sid: string): Promise<SessionData | null> {
  const s = await redis.get(SESS_PREFIX + sid);
  return s ? JSON.parse(s) : null;
}
async function delSession(sid: string) {
  await redis.del(SESS_PREFIX + sid);
}

function setSidCookie(res: express.Response, sid: string) {
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    secure: COOKIE_SECURE === 'true',
    sameSite: parseSameSite(COOKIE_SAMESITE),
    domain: COOKIE_DOMAIN,
    path: '/',
    maxAge: parseInt(SESSION_TTL_SECONDS, 10) * 1000
  });
}

function clearSidCookie(res: express.Response) {
  res.clearCookie(COOKIE_NAME, { domain: COOKIE_DOMAIN, path: '/' });
}

// --- PKCE helpers ---
function base64url(input: Buffer) {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sha256(verifier: string) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

// 1) Старт логина: редирект на Keycloak с PKCE
app.get('/auth/login', async (req, res) => {
  const state = nanoid(16);
  const code_verifier = base64url(crypto.randomBytes(32));
  const code_challenge = sha256(code_verifier);

  await saveOauthTemp(state, { code_verifier });

  const url = new URL(KC_PUBLIC_AUTH!);
  url.searchParams.set('client_id', KC_CLIENT_ID!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI!);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', code_challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  res.redirect(url.toString());
});

// 2) Callback: меняем code на токены, сохраняем сессию, отдаём cookie
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query as any;
  if (!code || !state) return res.status(400).send('Missing code/state');

  const tmp = await loadOauthTemp(state);
  if (!tmp) return res.status(400).send('State expired/invalid');
  await delOauthTemp(state);

  try {
    const tokenRes = await axios.post(
      KC_TOKEN!,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: KC_CLIENT_ID!,
        client_secret: KC_CLIENT_SECRET!,
        code_verifier: tmp.code_verifier,
        redirect_uri: REDIRECT_URI!
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const {
      access_token, refresh_token, expires_in,
      // refresh_expires_in, id_token
    } = tokenRes.data;

    // Получим немного профиля (sub, preferred_username)
    const ui = await axios.get(KC_USERINFO!, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const now = Math.floor(Date.now() / 1000);
    const sid = nanoid(24);
    const data: SessionData = {
      sub: ui.data.sub,
      username: ui.data.preferred_username || ui.data.name,
      access_token,
      access_expires_at: now + parseInt(expires_in, 10) - parseInt(ACCESS_EXPIRE_SKEW, 10),
      refresh_token_enc: encrypt(refresh_token)
    };

    await setSession(sid, data, parseInt(SESSION_TTL_SECONDS, 10));
    setSidCookie(res, sid);
    res.redirect(FRONTEND_ORIGIN);
  } catch (e: any) {
    res.status(401).send('Token exchange failed');
  }
});

// middleware: проверка сессии + авто-refresh + ротация session id
async function ensureAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const sid = req.cookies[COOKIE_NAME];
  if (!sid) return res.status(401).end();

  const s = await getSession(sid);
  if (!s) return res.status(401).end();

  const now = Math.floor(Date.now() / 1000);
  let session = s;

  // если access истёк — обновим через refresh
  if (now >= s.access_expires_at) {
    try {
      const refresh_token = decrypt(s.refresh_token_enc);
      const r = await axios.post(
        KC_TOKEN!,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token,
          client_id: KC_CLIENT_ID!,
          client_secret: KC_CLIENT_SECRET!
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const { access_token, refresh_token: new_refresh, expires_in } = r.data;
      session.access_token = access_token;
      session.access_expires_at = now + parseInt(expires_in, 10) - parseInt(ACCESS_EXPIRE_SKEW, 10);

      // Keycloak обычно ротирует refresh — сохраняем новый
      if (new_refresh) {
        session.refresh_token_enc = encrypt(new_refresh);
      }
    } catch (e) {
      await delSession(sid);
      clearSidCookie(res);
      return res.status(401).end();
    }
  }

  // --- ротация session id (session fixation mitigation) ---
  const newSid = nanoid(24);
  await setSession(newSid, session, parseInt(SESSION_TTL_SECONDS, 10));
  await delSession(sid);
  setSidCookie(res, newSid);

  // прикрепим к запросу access_token
  (req as any).accessToken = session.access_token;
  next();
}

// 3) Точка статуса
app.get('/auth/me', ensureAuth, async (req, res) => {
  res.json({ ok: true });
});

// 4) Логаут: чистим сессию + сингл-логаут в Keycloak
app.post('/auth/logout', ensureAuth, async (req, res) => {
  const sid = req.cookies[COOKIE_NAME];
  if (sid) await delSession(sid);
  clearSidCookie(res);
  res.status(204).end();
});

// 5) Прокси к защищённому API (пример: /reports)
// фронт будет ходить сюда, cookie шлём credentials: 'include'
app.get('/api/reports', ensureAuth, async (req, res) => {
  try {
    // здесь подставь реальный адрес вашего API
    // пример: const API_URL = 'http://api:8080/reports';
    const API_URL = process.env.API_URL || 'http://api:8080/reports';

    const r = await axios.get(API_URL, {
      headers: { Authorization: `Bearer ${(req as any).accessToken}` },
      responseType: 'arraybuffer'
    });
    // пробрасываем как есть (например PDF)
    res.status(r.status);
    Object.entries(r.headers).forEach(([k, v]) => {
      if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v as any);
    });
    res.send(r.data);
  } catch (e: any) {
    res.status(502).send('Upstream error');
  }
});

app.listen(parseInt(PORT, 10), () => {
  console.log(`bionicpro-auth on :${PORT}`);
});
