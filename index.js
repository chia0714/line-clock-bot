import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import line from '@line/bot-sdk';
import {
  ensureHeaders,
  appendClockRecord,
  appendLeaveRecord
} from './googleSheets.js';

const app = express();
app.use(bodyParser.json({ verify: (req, res, buf) => (req.rawBody = buf.toString()) }));

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

// 健康檢查
app.get('/', (_req, res) => res.status(200).send('OK'));

// Webhook
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).send('OK');
  } catch (e) {
    console.error('handleEvent error:', e);
    res.status(200).send('OK'); // 永遠回 200，避免重試風暴
  }
});

function fmtTime(d) {
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
}
function fmtDate(d) {
  return new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIMEZONE })
    .format(d)
    .replace(/\//g, '/');
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    if (event.replyToken) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '目前僅支援文字，請點「我要打卡」或「我要請假」。'
      });
    }
    return null;
  }

  const raw = (event.message.text || '').trim();
  // 同義字支援
  const text = raw.replace(/\s/g, '');

  const isClockIn = ['打卡上班', '我要打卡', '打卡'].includes(text);
  const isLeave   = ['我要請假', '請假'].includes(text);

  if (!isClockIn && !isLeave) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '請點選下方選單：「我要打卡」或「我要請假」。'
    });
  }

  await ensureHeaders();
  const userId = event.source?.userId || 'unknown';
  const now = new Date();
  const dateStr = fmtDate(now);

  if (isClockIn) {
    const minutes = Number(WORK_HOURS) * 60 + Number(LUNCH_MINUTES);
    const off = new Date(now.getTime() + minutes * 60 * 1000);
    const startStr = fmtTime(now);
    const endStr = fmtTime(off);

    try {
      await appendClockRecord({ userId, dateStr, startStr, endStr });
    } catch (e) {
      console.error('appendClockRecord error:', e);
    }

    const msg = `✅ 已成功打卡\n🕗 上班時間：${startStr}\n🕔 最早下班時間：${endStr}`;
    return client.replyMessage(event.replyToken, { type: 'text', text: msg });
  }

  if (isLeave) {
    try {
      await appendLeaveRecord({ userId, dateStr });
    } catch (e) {
      console.error('appendLeaveRecord error:', e);
    }

    const msg = `📅 請假完成\n今日狀態已更新為「請假」。`;
    return client.replyMessage(event.replyToken, { type: 'text', text: msg });
  }
}

app.listen(PORT, () => console.log('✅ Server running on port ' + PORT));
