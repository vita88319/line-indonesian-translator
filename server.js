import "dotenv/config";
import crypto from "crypto";
import express from "express";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 3000;

const required = [
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "OPENAI_API_KEY",
];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

// LINE signature verification needs the exact raw request body.
app.use(express.raw({ type: "application/json" }));

function verifyLineSignature(rawBody, signature) {
  if (!signature) return false;
  const digest = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");

  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function removeBotMentions(text, mention) {
  const selfMentions = (mention?.mentionees || [])
    .filter((m) => m.type === "user" && m.isSelf === true)
    .sort((a, b) => b.index - a.index);

  let result = text;
  for (const m of selfMentions) {
    // LINE mention indices/lengths are positions in the message text.
    result = result.slice(0, m.index) + result.slice(m.index + m.length);
  }
  return result.trim();
}

function wasBotMentioned(message) {
  return (message.mention?.mentionees || []).some(
    (m) => m.type === "user" && m.isSelf === true
  );
}

async function translate(text) {
  const instructions = `
You are a translation assistant used in a Taiwanese household to communicate
between Traditional-Chinese-speaking family members and an Indonesian domestic
worker/caregiver.

Your only job is translation.

Rules:
1. If the input is primarily Traditional/Simplified Chinese, translate it into
   natural, polite, easy-to-understand Bahasa Indonesia.
2. If the input is primarily Bahasa Indonesia, translate it into natural
   Traditional Chinese used in Taiwan.
3. Preserve names, dates, times, numbers, money amounts, addresses, medication
   names, dosages, and quantities exactly unless language formatting requires a
   harmless change.
4. Do not add instructions, advice, explanations, or facts that are not present.
5. For household chores, meals, schedules, elder care, childcare, shopping, and
   daily communication, prefer clear everyday wording over formal/literary wording.
6. Do not make the speaker sound commanding if the original is a normal request.
7. If a medically important or safety-critical sentence is genuinely ambiguous,
   translate conservatively and append one short warning in the TARGET language
   saying the original may be ambiguous and should be confirmed.
8. Return ONLY the translated message. Do not label the language and do not put
   the translation in quotation marks.
`;

  const response = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: "none" },
    instructions,
    input: text,
  });

  return response.output_text?.trim() || "翻譯失敗，請再試一次。";
}

async function replyToLine(replyToken, text, quoteToken) {
  const message = { type: "text", text: text.slice(0, 5000) };
  if (quoteToken) message.quoteToken = quoteToken;

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [message],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE reply failed: ${response.status} ${body}`);
  }
}

async function handleEvent(event) {
  if (event.type !== "message" || event.message?.type !== "text") return;

  // In groups: translate only when the bot is @mentioned.
  // In a 1-to-1 chat: translate every text message.
  const isGroup = event.source?.type === "group" || event.source?.type === "room";
  if (isGroup && !wasBotMentioned(event.message)) return;

  const input = isGroup
    ? removeBotMentions(event.message.text, event.message.mention)
    : event.message.text.trim();

  if (!input) {
    await replyToLine(
      event.replyToken,
      "請在 @我 後面輸入要翻譯的中文或印尼文。\nSilakan tulis pesan yang ingin diterjemahkan setelah @mention saya.",
      event.message.quoteToken
    );
    return;
  }

  const translated = await translate(input);
  await replyToLine(event.replyToken, translated, event.message.quoteToken);
}

app.get("/", (_req, res) => {
  res.status(200).send("LINE Chinese ↔ Indonesian translator is running.");
});

app.post("/webhook", async (req, res) => {
  const signature = req.get("x-line-signature");

  if (!verifyLineSignature(req.body, signature)) {
    return res.status(401).send("Invalid LINE signature");
  }

  let body;
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  // Acknowledge LINE quickly, then process events.
  res.status(200).send("OK");

  for (const event of body.events || []) {
    try {
      await handleEvent(event);
    } catch (error) {
      console.error("Event processing error:", error);
      // We deliberately don't expose API/server details into the family group.
      try {
        if (event.replyToken) {
          await replyToLine(
            event.replyToken,
            "翻譯暫時沒有成功，請稍後再試一次。\nTerjemahan sementara gagal. Silakan coba lagi sebentar lagi."
          );
        }
      } catch (replyError) {
        console.error("Error reply failed:", replyError);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`Translator bot listening on port ${PORT}`);
});
