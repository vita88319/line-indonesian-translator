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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

// Check whether the LINE message actually mentioned this Bot.
function wasBotMentioned(message) {
  return (message.mention?.mentionees || []).some(
    (m) => m.type === "user" && m.isSelf === true
  );
}

// Remove the @Translate mention before sending the text to OpenAI.
function removeBotMentions(text, mention) {
  const selfMentions = (mention?.mentionees || [])
    .filter(
      (m) => m.type === "user" && m.isSelf === true
    )
    .sort((a, b) => b.index - a.index);

  let result = text;

  for (const m of selfMentions) {
    result =
      result.slice(0, m.index) +
      result.slice(m.index + m.length);
  }

  // Backup cleanup in case LINE sends unusual mention metadata.
  result = result.replace(
    /^\s*@Translate\b[\s,:：，-]*/i,
    ""
  );

  return result.trim();
}

// Also support:
// 翻譯 明天九點出門
// Terjemahkan Besok jam sembilan...
function stripTextCommand(text) {
  const trimmed = text.trim();

  const chineseCommand = trimmed.match(
    /^翻譯(?:一下)?[\s,:：，-]*(.*)$/s
  );

  if (chineseCommand) {
    return {
      triggered: true,
      text: chineseCommand[1].trim(),
    };
  }

  const indonesianCommand = trimmed.match(
    /^terjemahkan[\s,:：，-]*(.*)$/is
  );

  if (indonesianCommand) {
    return {
      triggered: true,
      text: indonesianCommand[1].trim(),
    };
  }

  return {
    triggered: false,
    text: trimmed,
  };
}

// Detect Chinese characters.
// Chinese input = translate to Indonesian.
// Otherwise = translate to Traditional Chinese.
function containsChinese(text) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(
    text
  );
}

async function translate(text) {
  const targetLanguage = containsChinese(text)
    ? "Bahasa Indonesia"
    : "Traditional Chinese used in Taiwan";

  const instructions = `
You are a translation assistant used by a Taiwanese family
to communicate with an Indonesian domestic worker/caregiver.

Translate the user's message into ${targetLanguage}.

STRICT RULES:

1. The output MUST be in ${targetLanguage}.
2. Never return the original source language unchanged.
3. Return ONLY the translated message.
4. Do not include headings such as "Translation:".
5. Do not put the translation in quotation marks.
6. Do not add explanations or information that is not in
   the original message.
7. Preserve names, dates, times, numbers, money amounts,
   addresses, medication names, dosages, and quantities
   accurately.
8. Use natural, polite, easy everyday language suitable
   for household communication.
9. Preserve the speaker's original tone. A normal request
   should not become a harsh command.
10. For elder care, meals, schedules, household chores,
    shopping, and family communication, prioritize clarity
    and natural language rather than literal word-for-word
    translation.
11. If the source is Chinese, use natural Bahasa Indonesia
    that an Indonesian caregiver can easily understand.
12. If the source is Indonesian, use natural Traditional
    Chinese as commonly used in Taiwan.
`;

  const response = await openai.responses.create({
    model: MODEL,
    reasoning: {
      effort: "none",
    },
    instructions,
    input: text,
  });

  const output = response.output_text?.trim();

  if (!output) {
    throw new Error(
      "OpenAI returned an empty translation."
    );
  }

  // Extra protection:
  // if Chinese input accidentally comes back as Chinese,
  // force one more Indonesian-only translation.
  if (containsChinese(text) && containsChinese(output)) {
    const retry = await openai.responses.create({
      model: MODEL,
      reasoning: {
        effort: "none",
      },
      instructions: `
Translate the following Chinese message into natural
Bahasa Indonesia.

Output Bahasa Indonesia ONLY.
Do not repeat any Chinese text.
Do not add explanations.
`,
      input: text,
    });

    return retry.output_text?.trim() || output;
  }

  return output;
}

async function replyToLine(
  replyToken,
  text,
  quoteToken
) {
  const message = {
    type: "text",
    text: text.slice(0, 5000),
  };

  // Makes the Bot reply visually reference the
  // original message in LINE.
  if (quoteToken) {
    message.quoteToken = quoteToken;
  }

  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [message],
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `LINE reply failed: ${response.status} ${body}`
    );
  }
}

async function handleEvent(event) {
  if (
    event.type !== "message" ||
    event.message?.type !== "text"
  ) {
    return;
  }

  const sourceType = event.source?.type;

  const isGroup =
    sourceType === "group" ||
    sourceType === "room";

  let input = event.message.text.trim();

  if (isGroup) {
    const mentioned =
      wasBotMentioned(event.message);

    const command =
      stripTextCommand(input);

    // In a group, stay silent unless:
    // 1. @Translate was used
    // OR
    // 2. "翻譯" / "Terjemahkan" command was used.
    if (!mentioned && !command.triggered) {
      return;
    }

    if (mentioned) {
      input = removeBotMentions(
        input,
        event.message.mention
      );
    }

    // Allows combinations such as:
    // @Translate 翻譯 明天九點...
    input = stripTextCommand(input).text;
  } else {
    // Private chat:
    // every text message gets translated.
    input = stripTextCommand(input).text;
  }

  if (!input) {
    await replyToLine(
      event.replyToken,
      "請輸入要翻譯的內容。\n" +
        "Silakan masukkan pesan yang ingin diterjemahkan.",
      event.message.quoteToken
    );

    return;
  }

  const translated = await translate(input);

  await replyToLine(
    event.replyToken,
    translated,
    event.message.quoteToken
  );
}

app.get("/", (_req, res) => {
  res
    .status(200)
    .send(
      "LINE Chinese ↔ Indonesian translator is running."
    );
});

app.post("/webhook", async (req, res) => {
  const signature =
    req.get("x-line-signature");

  if (
    !verifyLineSignature(
      req.body,
      signature
    )
  ) {
    return res
      .status(401)
      .send("Invalid LINE signature");
  }

  let body;

  try {
    body = JSON.parse(
      req.body.toString("utf8")
    );
  } catch {
    return res
      .status(400)
      .send("Invalid JSON");
  }

  // Tell LINE immediately that the webhook
  // was successfully received.
  res.status(200).send("OK");

  for (const event of body.events || []) {
    try {
      await handleEvent(event);
    } catch (error) {
      console.error(
        "Event processing error:",
        error
      );

      try {
        if (event.replyToken) {
          await replyToLine(
            event.replyToken,
            "翻譯暫時沒有成功，請稍後再試一次。\n" +
              "Terjemahan sementara gagal. " +
              "Silakan coba lagi sebentar lagi."
          );
        }
      } catch (replyError) {
        console.error(
          "Error reply failed:",
          replyError
        );
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(
    `Translator bot listening on port ${PORT}`
  );
});
