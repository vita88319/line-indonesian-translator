# LINE 中文 ↔ 印尼文翻譯 Bot

用途：台灣家庭與印尼外傭／照護者在 LINE 群組中溝通。

## 使用方式

群組中：
- `@翻譯Bot 明天早上九點陪阿嬤去散步。`
- Bot 會回覆自然的 Bahasa Indonesia。
- 印尼文 @Bot，則自動翻成繁體中文。
- 沒有 @Bot 的一般群組聊天，Bot 不會回覆。

一對一聊天室：
- 直接傳中文或印尼文即可翻譯。

## 本機安裝

1. 安裝 Node.js 20+
2. 在此資料夾執行：
   npm install
3. 複製 `.env.example` 為 `.env`
4. 填入 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN、OPENAI_API_KEY
5. 執行：
   npm start

正式使用時，需要部署到具有公開 HTTPS 網址的主機，並把：
`https://你的網域/webhook`
填入 LINE Developers 的 Webhook URL。

## 重要安全事項

- `.env` 不要上傳到 GitHub。
- LINE Channel Secret、Channel Access Token、OpenAI API Key 都視為密碼。
- 如果任何 key 不小心公開，請立即撤銷並重新產生。
