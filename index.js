import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import line from '@line/bot-sdk';
import {
  ensureHeaders,
  appendClockRecord,
  appendLeaveRecord,
  getRecentRecords,
  hasRecordForDate,
  ensureScheduleHeaders,
  scheduleNotification,
  getDueNotifications,
  markNotified
} from './googleSheets.js';

const app = express();
app.use(bodyParser.json({ verify: (req, res, buf) => (req.rawBody = buf.toString()) }));

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  PORT = 3000,
  WORK_HOURS = 8,
  LUNCH_MINUTES = 60,
  TIMEZONE = 'Asia/Taipei',
  ALLOWED_USER_IDS = '',
  FAMILY_USER_IDS = '',
  FAMILY_GROUP_IDS = '',
  FAMILY_NOTIFY_LEAD_MINUTES = 15,
  NOTIFY_FIRST_CLOCK_ONLY = '1',
  CRON_KEY = '',
  NOTIFY_MAX_LAG_MINUTES = '240'
} = process.env;

const config = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};
const client = new line.Client(config);

// Health check
app.get('/', (_req, res) => res.status(200).send('OK'));

// ---------- 白名單 ----------
const ALLOWED = new Set(ALLOWED_USER_IDS.split(',').map(s => s.trim()).filter(Boolean));
const WHITELIST_MODE = ALLOWED.size > 0;
function isEmployee(userId) {
  if (!WHITELIST_MODE) return true;
  return ALLOWED.has(userId);
}

// ---------- 工具 ----------
function fmtTime(d) {
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
}
function fmtDate(d) {
  const y = d.toLocaleString('zh-TW', { year: 'numeric', timeZone: TIMEZONE });
  const m = d.toLocaleString('zh-TW', { month: '2-digit', timeZone: TIMEZONE });
  const da = d.toLocaleString('zh-TW', { day: '2-digit', timeZone: TIMEZONE });
  return `${y}/${m}/${da}`;
}
function fmtDateChinese(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
}

// ---------- 推播 ----------
async function notifyFamily(text) {
  const userIds = FAMILY_USER_IDS.split(',').map(s => s.trim()).filter(Boolean);
  const groupIds = FAMILY_GROUP_IDS.split(',').map(s => s.trim()).filter(Boolean);
  const msg = [{ type: 'text', text }];
  const tasks = [
    ...userIds.map(id => client.pushMessage(id, msg)),
    ...groupIds.map(id => client.pushMessage(id, msg))
  ];
  if (tasks.length) await Promise.allSettled(tasks);
}

// ---------- Flex ----------
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
                  { type: "box", layout: "baseline", contents: [
                      { type: "text", text: "打卡地點", size: "sm", color: "#64748B", flex: 2 },
                      { type: "text", text: location, size: "sm", color: "#0F172A", flex: 5, wrap: true }
                  ]},
                  { type: "box", layout: "baseline", contents: [
                      { type: "text", text: "備註", size: "sm", color: "#64748B", flex: 2 },
                      { type: "text", text: note, size: "sm", color: "#0F172A", flex: 5, wrap: true }
                  ]},
                  { type: "box", layout: "baseline", contents: [
                      { type: "text", text: "異常紀錄", size: "sm", color: "#64748B", flex: 2 },
                      { type: "text", text: delay, size: "sm", color: "#0F172A", flex: 5 }
                  ]}
                ]
              },
              {
                type: "box",
                layout: "vertical",
                margin: "md",
                spacing: "sm",
                contents: [
                  { type: "button", style: "link", height: "sm",
                    action: { type: "message", label: "出勤記錄", text: "出勤記錄" } },
                  { type: "button", style: "link", height: "sm",
                    action: { type: "message", label: "我要請假", text: "我要請假" } }
                ]
              }
            ]
          }
        ]
      }
    }
  };
}

function buildRecordsFlex(records) {
  const items = records.map(r => ({
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: r.dateZh || "-", size: "sm", color: "#64748B", flex: 6 },
      { type: "text", text: r.leave ? r.leave : (r.start || '-'), size: "sm", color: "#0F172A", flex: 4 }
    ]
  }));
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
          { type: "box", layout: "vertical", margin: "md", spacing: "xs", contents: items.length ? items : [
            { type: "text", text: "尚無出勤紀錄。", size: "sm", color: "#64748B" }
          ]}
        ]
      }
    }
  };
}

// ---------- 便捷 ID ----------
async function replyIdHelpers(event, text) {
  if (['/myid','綁定個人通知'].includes(text) && event.source?.userId) {
    return client.replyMessage(event.replyToken, { type: 'text', text: event.source.userId });
  }
  if (['/groupid','綁定群組通知'].includes(text)) {
    const gid = event.source?.groupId || event.source?.roomId;
    if (gid) return client.replyMessage(event.replyToken, { type: 'text', text: gid });
  }
  return null;
}

// ---------- 定時檢查並推播 ----------
async function checkAndNotifyDue() {
  try {
    await ensureScheduleHeaders();
    const nowISO = new Date().toISOString();
    const due = await getDueNotifications(nowISO);
    if (!due.length) return;

    const MAX_LAG_MIN = Number(NOTIFY_MAX_LAG_MINUTES || 240);

    const tasks = due.map(async item => {
      // 過期太久就不補發，只標記已通知以防止重複
      const lagMs = Date.now() - new Date(item.offISO).getTime();
      if (lagMs > MAX_LAG_MIN * 60 * 1000) {
        await markNotified(item.rowIndex);
        return;
      }
      const endStr = new Date(item.offISO).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
      const text =
        `📣 即將到達最早下班時間\n` +
        `📅 ${item.dateZh}\n` +
        `🕗 上班：${item.startStr}\n` +
        `🕔 最早下班：${endStr}`;
      await notifyFamily(text);
      await markNotified(item.rowIndex);
    });
    await Promise.allSettled(tasks);
  } catch (e) {
    console.error('checkAndNotifyDue error:', e);
  }
}

// 每 60 秒檢查一次；服務啟動時先掃一次
setInterval(checkAndNotifyDue, 60 * 1000);
checkAndNotifyDue();

// 手動 / Cron 觸發（帶密碼保護）
app.get('/tasks/notify-due', async (req, res) => {
  if (CRON_KEY && req.query.key !== CRON_KEY) {
    return res.status(403).send('Forbidden');
  }
  await checkAndNotifyDue();
  res.status(200).send('OK');
});

// ---------- Webhook ----------
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
        text: '目前僅支援文字，請點「我要打卡／我要請假／出勤記錄」。'
      });
    }
    return null;
  }

  const raw = (event.message.text || '').trim();
  const text = raw.replace(/\s/g, '');
  const userId = event.source?.userId || 'unknown';

  // 便捷取得ID
  const idHelper = await replyIdHelpers(event, text);
  if (idHelper) return idHelper;

  const isClockIn = ['打卡上班', '我要打卡', '打卡', '/clockin'].includes(text);
  const isLeave   = ['我要請假', '請假', '/leave'].includes(text);
  const isRecords = ['出勤記錄', '查看出勤紀錄', '/records'].includes(text);
  const isProtectedCmd = isClockIn || isLeave || isRecords;

  // 白名單限制
  if (isProtectedCmd && !isEmployee(userId)) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '此功能僅限本人使用。' });
    }

  await ensureHeaders();
  try { await ensureScheduleHeaders(); } catch (e) { console.error('ensureScheduleHeaders error:', e); }

  const now = new Date();
  const dateStr = fmtDate(now);

  if (isClockIn) {
    const minutes = Number(WORK_HOURS) * 60 + Number(LUNCH_MINUTES);
    const off = new Date(now.getTime() + minutes * 60 * 1000);
    const startStr = fmtTime(now);
    const endStr = fmtTime(off);

    let shouldSchedule = true;
    if (NOTIFY_FIRST_CLOCK_ONLY === '1') {
      try {
        const already = await hasRecordForDate(userId, dateStr);
        shouldSchedule = !already;
      } catch (e) {
        console.error('hasRecordForDate error:', e);
      }
    }

    try {
      await appendClockRecord({ userId, dateStr, startStr, endStr });
    } catch (e) {
      console.error('appendClockRecord error:', e);
    }

    if (shouldSchedule) {
      const leadMin = Number(FAMILY_NOTIFY_LEAD_MINUTES) || 15;
      const notifyAt = new Date(off.getTime() - leadMin * 60 * 1000);
      try {
        await scheduleNotification({
          userId,
          dateStr,
          startStr,
          offISO: off.toISOString(),
          notifyISO: notifyAt.toISOString(),
        });
      } catch (e) {
        console.error('scheduleNotification error:', e);
      }
    }

    const flex = buildClockInFlex({
      timeStr: startStr,
      dateStr,
      location: '台北辦公室（GPS）',
      note: `最早下班 ${endStr}`,
      delay: '—'
    });
    return client.replyMessage(event.replyToken, flex);
  }

  if (isLeave) {
    try {
      await appendLeaveRecord({ userId, dateStr });
    } catch (e) {
      console.error('appendLeaveRecord error:', e);
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: `📅 請假完成\n今日狀態已更新為「請假」。` });
  }

  if (isRecords) {
    try {
      const list = await getRecentRecords(userId, 5);
      const mapped = list.map(r => ({
        dateZh: fmtDateChinese(r.date),
        start: r.start,
        leave: r.end === '今天請假' ? '今天請假' : undefined
      }));
      const flex = buildRecordsFlex(mapped);
      return client.replyMessage(event.replyToken, flex);
    } catch (e) {
      console.error('getRecentRecords error:', e);
      return client.replyMessage(event.replyToken, { type: 'text', text: '讀取出勤紀錄時發生錯誤，稍後再試。' });
    }
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '請點選下方選單：「我要打卡」、「我要請假」或「出勤記錄」。'
  });
}

app.listen(PORT, () => console.log('✅ Server running on port ' + PORT));
