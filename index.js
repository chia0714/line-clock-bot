import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import line from '@line/bot-sdk';
import { ensureHeaders, appendClockRecord } from './googleSheets.js';

const app = express();

app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  PORT = 3000,
  WORK_HOURS = 8,
  LUNCH_MINUTES = 60,
  TIMEZONE = 'Asia/Taipei'
} = process.env;

const config = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

app.get('/', (_req, res) => res.status(200).send('OK'));

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).send('OK');
  } catch (e) {
    console.error('handleEvent error:', e);
    res.status(200).send('OK');
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    if (event.replyToken) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '目前僅支援文字訊息，請輸入「打卡上班」。' });
    }
    return null;
  }

  const text = (event.message.text || '').trim();
  if (text !== '打卡上班') {
    return client.replyMessage(event.replyToken, { type: 'text', text: '請輸入或點擊「打卡上班」開始記錄。' });
  }

  const now = new Date();
  const offTime = new Date(now.getTime() + (Number(WORK_HOURS) * 60 + Number(LUNCH_MINUTES)) * 60 * 1000);

  const startStr = now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
  const endStr = offTime.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
  const dateStr = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIMEZONE }).format(now);

  try {
    await ensureHeaders();
    await appendClockRecord({ userId: event.source.userId || 'unknown', dateStr, startStr, endStr });
  } catch (e) {
    console.error('append to sheet error:', e);
  }

  const msg = `✅ 已成功打卡\n🕗 上班時間：${startStr}\n🕔 最早下班時間：${endStr}`;
  return client.replyMessage(event.replyToken, { type: 'text', text: msg });
}

app.listen(PORT, () => {
  console.log('✅ Server running on port ' + PORT);
});
