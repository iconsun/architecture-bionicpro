import express from 'express';
import axios from 'axios';

export const yandexUserinfoProxy = express.Router();

yandexUserinfoProxy.get('/broker-proxy/yandex/userinfo', async (req, res) => {
  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'No Bearer token' });
  const yandexToken = m[1];

  try {
    const r = await axios.get('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: `OAuth ${yandexToken}` },
      timeout: 5000
    });
    res.status(200).json(r.data);
  } catch (e: any) {
    res.status(e.response?.status || 502).json({ error: 'userinfo proxy failed', details: e.message });
  }
});
