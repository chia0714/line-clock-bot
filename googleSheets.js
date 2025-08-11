import { google } from 'googleapis';

const SHEET_ID = process.env.SHEET_ID;

// 讀取 service account 金鑰（Render Secret Files 會放在這條路徑）
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
  // 確保「打卡紀錄」存在且 A1:D1 有表頭
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
        requestBody: {
          values: [['User ID', '日期', '上班時間', '預估下班時間']]
        }
      });
    }
  } catch {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: '打卡紀錄!A1:D1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [['User ID', '日期', '上班時間', '預估下班時間']]
      }
    });
  }
}

export async function appendClockRecord({ userId, dateStr, startStr, endStr }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: '打卡紀錄!A:D',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[userId, dateStr, startStr, endStr]]
    }
  });
}

export async function appendLeaveRecord({ userId, dateStr }) {
  // 上班時間留空，預估下班時間填「今天請假」
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: '打卡紀錄!A:D',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[userId, dateStr, '', '今天請假']]
    }
  });
}

