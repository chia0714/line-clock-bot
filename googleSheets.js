import { google } from 'googleapis';

const SHEET_ID = process.env.SHEET_ID;
const KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/etc/secrets/service-account.json';

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

export async function ensureHeaders() {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '打卡紀錄!A1:D1'
    });
    const rows = res.data.values || [];
    if (!rows.length || rows[0][0] !== 'User ID') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: '打卡紀錄!A1:D1',
        valueInputOption: 'RAW',
        requestBody: { values: [['User ID', '日期', '上班時間', '預估下班時間']] }
      });
    }
  } catch (e) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: '打卡紀錄!A1:D1',
      valueInputOption: 'RAW',
      requestBody: { values: [['User ID', '日期', '上班時間', '預估下班時間']] }
    });
  }
}

// ---- 通知排程 Sheet: A=userId, B=日期(YYYY/MM/DD), C=上班時間, D=offISO, E=notifyISO, F=notified ----
export async function ensureScheduleHeaders() {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '通知排程!A1:F1'
    });
    const rows = res.data.values || [];
    if (!rows.length || rows[0][0] !== 'User ID') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: '通知排程!A1:F1',
        valueInputOption: 'RAW',
        requestBody: { values: [['User ID','日期','上班時間','OffISO','NotifyISO','Notified']] }
      });
    }
  } catch (e) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: '通知排程!A1:F1',
      valueInputOption: 'RAW',
      requestBody: { values: [['User ID','日期','上班時間','OffISO','NotifyISO','Notified']] }
    });
  }
}

export async function appendClockRecord({ userId, dateStr, startStr, endStr }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: '打卡紀錄!A:D',
    valueInputOption: 'RAW',
    requestBody: { values: [[userId, dateStr, startStr, endStr]] }
  });
}

export async function appendLeaveRecord({ userId, dateStr }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: '打卡紀錄!A:D',
    valueInputOption: 'RAW',
    requestBody: { values: [[userId, dateStr, '', '今天請假']] }
  });
}

function normalizeDateStr(input) {
  if (!input) return '';
  const cleaned = String(input).replace(/[年月日]/g, '/').replace(/\s+/g, '');
  const compact = cleaned.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = compact.split('/').filter(Boolean);
  let d;
  if (parts.length >= 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(day)) d = new Date(y, m - 1, day);
  } else {
    const tryDate = new Date(input);
    if (!isNaN(tryDate)) d = tryDate;
  }
  if (d && !isNaN(d)) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd}`;
  }
  return input;
}

export async function getRecentRecords(userId, limit = 5) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: '打卡紀錄!A:D'
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];
  const data = rows.slice(1);
  const result = [];
  for (let i = data.length - 1; i >= 0 && result.length < limit; i--) {
    const [uid, date, start, end] = data[i];
    if (uid === userId) {
      result.push({ date: normalizeDateStr(date), start, end });
    }
  }
  return result;
}

export async function hasRecordForDate(userId, dateStr) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: '打卡紀錄!A:D'
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return false;
  const data = rows.slice(1);
  const target = normalizeDateStr(dateStr);
  for (let i = 0; i < data.length; i++) {
    const [uid, date] = data[i];
    if (uid === userId && normalizeDateStr(date) === target) return true;
  }
  return false;
}

// ---- 通知排程：建立、查 due、標記已通知 ----
export async function scheduleNotification({ userId, dateStr, startStr, offISO, notifyISO }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: '通知排程!A:F',
    valueInputOption: 'RAW',
    requestBody: { values: [[userId, dateStr, startStr, offISO, notifyISO, 'FALSE']] }
  });
}

// 取得所有 notifyISO <= nowISO 且 Notified != TRUE 的項目（回傳附 rowIndex）
export async function getDueNotifications(nowISO) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: '通知排程!A:F'
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];
  const data = rows.slice(1);
  const due = [];
  for (let i = 0; i < data.length; i++) {
    const [userId, dateStr, startStr, offISO, notifyISO, notified] = data[i];
    if (String(notified).toUpperCase() === 'TRUE') continue;
    if (!notifyISO) continue;
    if (new Date(notifyISO).toISOString() <= new Date(nowISO).toISOString()) {
      due.push({
        rowIndex: i + 2, // 1-based（含表頭）
        userId,
        dateStr,
        startStr,
        offISO,
        dateZh: toChinese(dateStr)
      });
    }
  }
  return due;
}

export async function markNotified(rowIndex) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `通知排程!F${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['TRUE']] }
  });
}

// 工具：YYYY/MM/DD -> 中文日期
function toChinese(dateStr) {
  const d = normalizeDateStr(dateStr);
  const parts = d.split('/');
  if (parts.length >= 3) {
    const y = parts[0], m = parts[1], day = parts[2];
    return `${Number(y)}年${Number(m)}月${Number(day)}日`;
  }
  const tryDate = new Date(dateStr);
  if (!isNaN(tryDate)) {
    return `${tryDate.getFullYear()}年${tryDate.getMonth()+1}月${tryDate.getDate()}日`;
  }
  return dateStr;
}
