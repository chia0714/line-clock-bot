# LINE Clock Bot（Node.js）

## 功能
- 使用者傳「打卡上班」→ 回覆上/下班時間
- 紀錄到 Google 試算表（工作表名：打卡紀錄）

## 安裝
```
npm install
cp .env.example .env
# 編輯 .env 填入：
# LINE_CHANNEL_ACCESS_TOKEN=長期 Access Token
# LINE_CHANNEL_SECRET=你的 Channel Secret
# SHEET_ID=你的試算表 ID
```
把你的 `service-account.json` 放在專案根目錄（或在 Render 的 Secret Files 設定 `/service-account.json`）。

## 啟動
```
npm start
```

## 部署（Render）
- Build: `npm install`
- Start: `npm start`
- Env: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `SHEET_ID`, （可選）`WORK_HOURS`, `LUNCH_MINUTES`, `TIMEZONE`
- Secret Files: `/service-account.json`

## LINE Webhook
- 設為：`https://你的網域/webhook`
- Official Account Manager：回應模式 **Bot**；關閉自動回覆與歡迎訊息
