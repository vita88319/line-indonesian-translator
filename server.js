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

// LINE needs the exact raw request body for signature verification.
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

/*
 * Detect whether this LINE message actually mentioned the Bot.
 */
function wasBotMentioned(message) {
  return (message.mention?.mentionees || []).some(
    (m) =>
      m.type === "user" &&
      m.isSelf === true
  );
}

/*
 * Remove @Translate from a LINE group message.
 *
 * Supports:
 *
 * @Translate你好
 * @Translate 你好
 * @Translate　你好
 * @Translate: 你好
 * @Translate：你好
 * @Translate, 你好
 * @Translate，您好
 */
function removeBotMentions(text, mention) {
  const selfMentions =
    (mention?.mentionees || [])
      .filter(
        (m) =>
          m.type === "user" &&
          m.isSelf === true
      )
      .sort(
        (a, b) =>
          b.index - a.index
      );

  let result = text;

  // Primary method:
  // remove the real LINE mention according to webhook metadata.
  for (const m of selfMentions) {
    result =
      result.slice(0, m.index) +
      result.slice(
        m.index + m.length
      );
  }

  /*
   * Backup cleanup.
   *
   * This protects against differences between
   * LINE clients and also accepts normal/full-width
   * spaces and punctuation after @Translate.
   */
  result = result.replace(
    /^\s*@Translate(?:[\s\u3000]*[:：,，-]?[\s\u3000]*)?/i,
    ""
  );

  // Remove spaces left at the beginning.
  result = result.replace(
    /^[\s\u3000]+/,
    ""
  );

  return result.trim();
}

/*
 * Group-chat text commands.
 *
 * These work even if the user doesn't @mention the Bot.
 *
 * Chinese:
 * 翻譯 明天九點出門
 * 翻譯明天九點出門
 *
 * Indonesian:
 * Terjemahkan Besok jam sembilan...
 */
function stripTextCommand(text) {
  const trimmed = text.trim();

  const chineseCommand =
    trimmed.match(
      /^翻譯(?:一下)?[\s\u3000,:：，-]*(.*)$/s
    );

  if (chineseCommand) {
    return {
      triggered: true,
      text:
        chineseCommand[1].trim(),
    };
  }

  const indonesianCommand =
    trimmed.match(
      /^terjemahkan[\s\u3000,:：，-]*(.*)$/is
    );

  if (indonesianCommand) {
    return {
      triggered: true,
      text:
        indonesianCommand[1].trim(),
    };
  }

  return {
    triggered: false,
    text: trimmed,
  };
}

/*
 * Simple language-direction detection.
 *
 * Chinese present:
 * Chinese → Bahasa Indonesia
 *
 * No Chinese present:
 * Bahasa Indonesia → Traditional Chinese
 */
function containsChinese(text) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(
    text
  );
}

async function translate(text) {
  const sourceIsChinese =
    containsChinese(text);

  const targetLanguage =
    sourceIsChinese
      ? "Bahasa Indonesia"
      : "Traditional Chinese used in Taiwan";

  const instructions = `
You are a translation assistant for communication between
a Taiwanese family and an Indonesian domestic worker/caregiver.

Translate the user's message into ${targetLanguage}.

STRICT RULES:

1. The output MUST be in ${targetLanguage}.

2. Never simply repeat the source text.

3. Return ONLY the translated message.

4. Do not include labels such as:
   "Translation:"
   "Indonesian:"
   "Chinese:"

5. Do not put the translation in quotation marks.

6. Do not add explanations, advice, opinions, or information
   that does not appear in the original message.

7. Preserve names accurately.

8. Preserve dates, times, numbers, money amounts, addresses,
   medication names, dosages, and quantities accurately.

9. Use natural, polite, easy everyday language suitable for
   communication inside a household.

10. Preserve the speaker's original tone.

11. A normal request must not become a harsh command.

12. For elder care, meals, schedules, household chores,
    shopping, transportation, appointments, and family
    communication, prioritize clarity and natural language.

13. If the source is Chinese:
    translate it into natural Bahasa Indonesia that an
    Indonesian caregiver can easily understand.

14. If the source is Indonesian:
    translate it into natural Traditional Chinese as commonly
    used in Taiwan.

15. Do not translate a person's name unless necessary.

16. Do not change the meaning of family relationship terms
    such as 阿嬤 / 奶奶 / 外婆 without context.

17. If a sentence contains medically or safety-critical
    information, translate conservatively and do not invent
    missing details.
`;

  const response =
    await openai.responses.create({
      model: MODEL,

      reasoning: {
        effort: "none",
      },

      instructions,

      input: text,
    });

  let output =
    response.output_text?.trim();

  if (!output) {
    throw new Error(
      "OpenAI returned an empty translation."
    );
  }

  /*
   * Safety check:
   *
   * If Chinese input somehow comes back mainly as Chinese,
   * ask the model again with a stricter Indonesian-only prompt.
   */
  if (
    sourceIsChinese &&
    containsChinese(output)
  ) {
    const retry =
      await openai.responses.create({
        model: MODEL,

        reasoning: {
          effort: "none",
        },

        instructions: `
Translate the following Chinese message into natural
Bahasa Indonesia.

STRICT REQUIREMENTS:

- Output Bahasa Indonesia ONLY.
- Do not repeat the Chinese source.
- Do not add explanations.
- Preserve names, numbers, dates, times, quantities,
  medication information, and meaning accurately.
- Use natural everyday Indonesian suitable for communication
  between a family and a domestic worker/caregiver.
`,

        input: text,
      });

    const retryOutput =
      retry.output_text?.trim();

    if (retryOutput) {
      output = retryOutput;
    }
  }

  return output;
}

/*
 * Send the translated message back to LINE.
 */
async function replyToLine(
  replyToken,
  text,
  quoteToken
) {
  const message = {
    type: "text",
    text: text.slice(0, 5000),
  };

  /*
   * Quote the original message so people in a group
   * can immediately see which message was translated.
   */
  if (quoteToken) {
    message.quoteToken =
      quoteToken;
  }

  const response =
    await fetch(
      "https://api.line.me/v2/bot/message/reply",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

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
    const body =
      await response.text();

    throw new Error(
      `LINE reply failed: ${response.status} ${body}`
    );
  }
}

/*
 * Handle incoming LINE events.
 */
async function handleEvent(event) {
  /*
   * Ignore stickers, images, videos, etc.
   * This Bot currently translates text only.
   */
  if (
    event.type !== "message" ||
    event.message?.type !== "text"
  ) {
    return;
  }

  const sourceType =
    event.source?.type;

  const isGroup =
    sourceType === "group" ||
    sourceType === "room";

  let input =
    event.message.text.trim();

  /*
   * GROUP CHAT
   */
  if (isGroup) {
    const mentioned =
      wasBotMentioned(
        event.message
      );

    const initialCommand =
      stripTextCommand(input);

    /*
     * Stay completely silent during normal group conversation.
     *
     * Respond only when:
     *
     * 1. The Bot is actually @mentioned
     *
     * OR
     *
     * 2. The message begins with
     *    翻譯
     *    or
     *    Terjemahkan
     */
    if (
      !mentioned &&
      !initialCommand.triggered
    ) {
      return;
    }

    /*
     * Remove @Translate.
     */
    if (mentioned) {
      input =
        removeBotMentions(
          input,
          event.message.mention
        );
    }

    /*
     * Also remove optional command text.
     *
     * This means this also works:
     *
     * @Translate 翻譯 明天九點...
     */
    input =
      stripTextCommand(input).text;
  }

  /*
   * PRIVATE CHAT
   *
   * Every normal text message is translated automatically.
   */
  else {
    input =
      stripTextCommand(input).text;
  }

  /*
   * User only typed @Translate / 翻譯
   * without giving any actual content.
   */
  if (!input) {
    await replyToLine(
      event.replyToken,

      "請輸入要翻譯的內容。\n" +
        "Silakan masukkan pesan yang ingin diterjemahkan.",

      event.message.quoteToken
    );

    return;
  }

  const translated =
    await translate(input);

  await replyToLine(
    event.replyToken,
    translated,
    event.message.quoteToken
  );
}

/*
 * Health check / homepage for Render.
 */
app.get("/", (_req, res) => {
  res
    .status(200)
    .send(
      "LINE Chinese ↔ Indonesian translator is running."
    );
});

/*
 * LINE Webhook
 */
app.post(
  "/webhook",

  async (req, res) => {
    const signature =
      req.get(
        "x-line-signature"
      );

    /*
     * Reject fake / unsigned requests.
     */
    if (
      !verifyLineSignature(
        req.body,
        signature
      )
    ) {
      return res
        .status(401)
        .send(
          "Invalid LINE signature"
        );
    }

    let body;

    try {
      body =
        JSON.parse(
          req.body.toString(
            "utf8"
          )
        );
    } catch {
      return res
        .status(400)
        .send(
          "Invalid JSON"
        );
    }

    /*
     * Respond to LINE immediately.
     */
    res
      .status(200)
      .send("OK");

    /*
     * Process all LINE events.
     */
    for (
      const event
      of body.events || []
    ) {
      try {
        await handleEvent(
          event
        );
      } catch (error) {
        console.error(
          "Event processing error:",
          error
        );

        /*
         * Friendly bilingual error message.
         */
        try {
          if (
            event.replyToken
          ) {
            await replyToLine(
              event.replyToken,

              "翻譯暫時沒有成功，請稍後再試一次。\n" +
                "Terjemahan sementara gagal. " +
                "Silakan coba lagi sebentar lagi."
            );
          }
        } catch (
          replyError
        ) {
          console.error(
            "Error reply failed:",
            replyError
          );
        }
      }
    }
  }
);

/*
 * Start server.
 */
app.listen(
  PORT,
  () => {
    console.log(
      `Translator bot listening on port ${PORT}`
    );
  }
);
