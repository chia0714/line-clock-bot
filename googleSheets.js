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

// 讀取該 userId 的最近 N 筆紀錄（倒序）
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
      result.push({ date, start, end });
    }
  }
  return result;
}
