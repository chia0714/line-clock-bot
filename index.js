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
  TIMEZONE = 'Asia/Taipei',
  OWNER_USER_ID
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

// 轉 YYYY/MM/DD -> YYYY年M月D日（用於出勤記錄顯示）
function toChineseDate(dateStr) {
  const m = String(dateStr).match(/^(\d{4})[\/](\d{1,2})[\/](\d{1,2})$/);
  if (m) return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
  const dt = new Date(dateStr);
  if (!isNaN(dt)) return `${dt.getFullYear()}年${dt.getMonth()+1}月${dt.getDate()}日`;
  return dateStr;
}

// Flex：打卡成功卡片
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

// Flex：最近出勤紀錄（中文日期＋只顯示上班時間或今天請假）
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

function isOwner(uid) {
  return uid && OWNER_USER_ID && uid === OWNER_USER_ID;
}

// Webhook
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
  const userId = event.source?.userId || 'unknown';

  // 特殊指令：/whoami 取得 userId（設定白名單/家人）
  if (['/whoami','我的代號'].includes(text)) {
    return client.replyMessage(event.replyToken, { type: 'text', text: userId });
  }

  // 管理指令：/whichmenu （僅 OWNER）
  if (['/whichmenu', '我的選單'].includes(text)) {
    if (!isOwner(userId)) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '只有本人可以查詢喔～' });
    }
    try {
      const personal = await client.getRichMenuIdOfUser(userId).catch(() => null);
      const defaultId = await client.getDefaultRichMenuId().catch(() => null);
      const list = await client.getRichMenuList().catch(() => ({ richmenus: [] }));
      const lines = [];
      lines.push(`👤 你的個人 Rich Menu：${personal || '（未指派，使用預設）'}`);
      lines.push(`⭐ 預設 Rich Menu：${defaultId || '（未設定）'}`);
      if (list.richmenus && list.richmenus.length) {
        lines.push('📋 目前存在的 Rich Menu：');
        list.richmenus.forEach((m, i) => {
          lines.push(`${i+1}. ${m.richMenuId}｜${m.name || '(no name)'}｜${m.size?.width}x${m.size?.height}`);
        });
      }
      return client.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') });
    } catch (e) {
      console.error('whichmenu error:', e);
      return client.replyMessage(event.replyToken, { type: 'text', text: '查詢選單時發生錯誤。' });
    }
  }

  // 同義字（含 /clockin、/leave、/records）
  const isClockIn = ['打卡上班', '我要打卡', '打卡', '/clockin'].includes(text);
  const isLeave   = ['我要請假', '請假', '/leave'].includes(text);
  const isRecords = ['出勤記錄', '查看出勤紀錄', '/records'].includes(text);

  // 權限管控：只有 OWNER 可用三大功能
  if (isClockIn || isLeave || isRecords) {
    if (!isOwner(userId)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '這些功能僅限本人使用喔～你會在每天 17:30 收到他的下班時間通知。'
      });
    }
  } else {
    // 其他訊息：友善引導
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '請點選單：「我要打卡」、「我要請假」或「出勤記錄」。'
    });
  }

  await ensureHeaders();
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
