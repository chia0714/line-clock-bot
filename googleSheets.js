import { google } from 'googleapis';

const SHEET_ID = process.env.SHEET_ID;

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: './service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  return sheets;
}

export async function ensureHeaders() {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '打卡紀錄!A1:D1'
    });
    const rows = res.data.values || [];
    if (rows.length === 0 || rows[0][0] !== 'User ID') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: '打卡紀錄!A1:D1',
        valueInputOption: 'RAW',
        resource: { values: [['User ID', '日期', '上班時間', '預估下班時間']] }
      });
    }
  } catch (e) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: '打卡紀錄!A1:D1',
      valueInputOption: 'RAW',
      resource: { values: [['User ID', '日期', '上班時間', '預估下班時間']] }
    });
  }
}

export async function appendClockRecord({ userId, dateStr, startStr, endStr }) {
  const sheets = await getSheetsClient();
  const values = [[userId, dateStr, startStr, endStr]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: '打卡紀錄!A:D',
    valueInputOption: 'RAW',
    resource: { values }
  });
}
