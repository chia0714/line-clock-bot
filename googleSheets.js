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

// 將各種日期字串格式（含「2025年/08月/12日」）轉成 YYYY/MM/DD
function normalizeDateStr(input) {
  if (!input) return '';
  // 移除「年」「月」「日」中文字與空白
  const cleaned = String(input).replace(/[年月日]/g, '/').replace(/\s+/g, '');
  // 有些情況會變成 '2025///08//12/'，簡單收斂多重斜線
  const compact = cleaned.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = compact.split('/').filter(Boolean);
  // 若可解析成日期就用 Date；否則原樣回傳
  let d;
  if (parts.length >= 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(day)) {
      d = new Date(y, m - 1, day);
    }
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

// 讀取該 userId 的最近 N 筆紀錄（倒序），並把日期標準化成 YYYY/MM/DD
export async function getRecentRecords(userId, limit = 5) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: '打卡紀錄!A:D'
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];
  const data = rows.slice(1); // 去表頭
  const result = [];
  for (let i = data.length - 1; i >= 0 && result.length < limit; i--) {
    const [uid, date, start, end] = data[i];
    if (uid === userId) {
      result.push({
        date: normalizeDateStr(date),
        start,
        end
      });
    }
  }
  return result;
}
