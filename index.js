import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import line from '@line/bot-sdk';
import {
  ensureHeaders,
  appendClockRecord,
  appendLeaveRecord,
  getRecentRecords
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

function fmtTime(d) {
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
}
function fmtDate(d) {
  const y = d.toLocaleString('zh-TW', { year: 'numeric', timeZone: TIMEZONE });
  const m = d.toLocaleString('zh-TW', { month: '2-digit', timeZone: TIMEZONE });
  const da = d.toLocaleString('zh-TW', { day: '2-digit', timeZone: TIMEZONE });
  return `${y}/${m}/${da}`;
}

// 轉「YYYY/MM/DD」或其他可解析字串 -> 「YYYY年M月D日」
function toChineseDate(dateStr) {
  if (!dateStr) return '';
  // 優先處理 YYYY/MM/DD
  const m = String(dateStr).match(/^(\d{4})[\/](\d{1,2})[\/](\d{1,2})$/);
  let y, mo, d;
  if (m) {
    y = parseInt(m[1], 10);
    mo = parseInt(m[2], 10);
    d = parseInt(m[3], 10);
  } else {
    const dt = new Date(dateStr);
    if (!isNaN(dt)) {
      y = dt.getFullYear();
      mo = dt.getMonth() + 1;
      d = dt.getDate();
    }
  }
  if (y && mo && d) return `${y}年${mo}月${d}日`;
  return dateStr; // fallback
}

// Flex：打卡成功卡片（維持不變）
function buildClockInFlex({ timeStr, dateStr, location='—', note='—', delay='—' }) {
  return {
    type: "flex",
    altText: `上班打卡 ${timeStr}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#F3F6FA",
            cornerRadius: "16px",
            paddingAll: "16px",
            contents: [
              { type: "text", text: "已打卡成功", size: "xs", color: "#34A853" },
              {
                type: "box",
                layout: "vertical",
                margin: "sm",
                contents: [
                  { type: "text", text: `上班打卡 ${timeStr}`, weight: "bold", size: "xl", color: "#0F172A" },
                  { type: "text", text: dateStr, size: "xs", color: "#64748B", margin: "sm" }
                ]
              },
              { type: "separator", margin: "md", color: "#E2E8F0" },
              {
                type: "box",
                layout: "vertical",
                margin: "md",
                spacing: "xs",
                contents: [
                  {
                    type: "box",
                    layout: "baseline",
                    contents: [
                      { type: "text", text: "打卡地點", size: "sm", color: "#64748B", flex: 2 },
                      { type: "text", text: location, size: "sm", color: "#0F172A", flex: 5, wrap: true }
                    ]
                  },
                  {
                    type: "box",
                    layout: "baseline",
                    contents: [
                      { type: "text", text: "備註", size: "sm", color: "#64748B", flex: 2 },
                      { type: "text", text: note, size: "sm", color: "#0F172A", flex: 5, wrap: true }
                    ]
                  },
                  {
                    type: "box",
                    layout: "baseline",
                    contents: [
                      { type: "text", text: "異常紀錄", size: "sm", color: "#64748B", flex: 2 },
                      { type: "text", text: delay, size: "sm", color: "#0F172A", flex: 5 }
                    ]
                  }
                ]
              },
              {
                type: "box",
                layout: "vertical",
                margin: "md",
                spacing: "sm",
                contents: [
                  {
                    type: "button",
                    style: "link",
                    height: "sm",
                    action: { type: "message", label: "出勤記錄", text: "出勤記錄" }
                  },
                  {
                    type: "button",
                    style: "link",
                    height: "sm",
                    action: { type: "message", label: "我要請假", text: "我要請假" }
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  };
}

// Flex：最近出勤紀錄列表（改為「YYYY年M月D日 → 上班時間或今天請假」）
function buildRecordsFlex(records) {
  const items = records.map(r => {
    const isLeave = (r.end && r.end.includes('今天請假')) || (r.start === '-' || r.start === '');
    const line = isLeave ? `${toChineseDate(r.date)} → 今天請假`
                         : `${toChineseDate(r.date)} → ${r.start || '-'}`;
    return { type: "text", text: line, size: "sm", color: "#0F172A", wrap: true };
  });

  return {
    type: "flex",
    altText: "最近出勤紀錄",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "最近出勤紀錄", weight: "bold", size: "md", color: "#0F172A" },
          { type: "separator", margin: "sm", color: "#E2E8F0" },
          { type: "box", layout: "vertical", margin: "md", spacing: "xs",
            contents: items.length ? items : [{ type: "text", text: "尚無出勤紀錄。", size: "sm", color: "#64748B" }]}
        ]
      }
    }
  };
}

// Webhook（保留原本打卡/請假/出勤記錄流程）
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
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '請點「我要打卡／我要請假／出勤記錄」。'
      });
    }
    return null;
  }

  const raw = (event.message.text || '').trim();
  const text = raw.replace(/\s/g, '');

  const isClockIn = ['打卡上班', '我要打卡', '打卡', '/clockin'].includes(text);
  const isLeave   = ['我要請假', '請假', '/leave'].includes(text);
  const isRecords = ['出勤記錄', '查看出勤紀錄', '/records'].includes(text);

  if (!isClockIn && !isLeave && !isRecords) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '請點選單：「我要打卡／我要請假／出勤記錄」。' });
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

    try { await appendClockRecord({ userId, dateStr, startStr, endStr }); } catch (e) { console.error(e); }
    const flex = buildClockInFlex({
      timeStr: startStr, dateStr, location: '台北辦公室（GPS）', note: `最早下班 ${endStr}`, delay: '—'
    });
    return client.replyMessage(event.replyToken, flex);
  }

  if (isLeave) {
    try { await appendLeaveRecord({ userId, dateStr }); } catch (e) { console.error(e); }
    return client.replyMessage(event.replyToken, { type: 'text', text: '📅 請假完成\n今日狀態已更新為「請假」。' });
  }

  if (isRecords) {
    try {
      const list = await getRecentRecords(userId, 5);
      const flex = buildRecordsFlex(list);
      return client.replyMessage(event.replyToken, flex);
    } catch (e) {
      console.error('getRecentRecords error:', e);
      return client.replyMessage(event.replyToken, { type: 'text', text: '讀取出勤紀錄時發生錯誤，稍後再試。' });
    }
  }
}

app.listen(PORT, () => console.log('✅ Server running on port ' + PORT));
