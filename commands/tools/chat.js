const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");
const { GoogleGenAI } = require("@google/genai");
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(__dirname, "../../config.json");
let apiKey = process.env.GEMINI_API_KEY;

if (fs.existsSync(configPath)) {
    const config = require(configPath);
    apiKey = config.GEMINI_API_KEY || config.apiKey || apiKey;
}

const ai = new GoogleGenAI({ apiKey: apiKey });

function splitMessage(text, maxLength = 1900) {
    const chunks = [];
    let currentIndex = 0;
    while (currentIndex < text.length) {
        chunks.push(text.slice(currentIndex, currentIndex + maxLength));
        currentIndex += maxLength;
    }
    return chunks;
}

// URLからファイルをダウンロードして、Geminiが扱えるInlineData形式に変換する関数（画像・PDF・テキスト等に対応）
async function urlToGenerativePart(url, mimeType) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ファイルの取得に失敗しました: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    return {
        inlineData: {
            data: Buffer.from(buffer).toString("base64"),
            mimeType
        },
    };
}

async function generateWithFallback(contents, interaction) {
    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            return await ai.models.generateContent({
                model: modelName,
                contents: contents,
            });
        } catch (error) {
            lastError = error;
            if (error.status === 404 || error.status === 503 || error.status === 429 || (error.message && (error.message.includes('503') || error.message.includes('not found') || error.message.includes('overloaded')))) {
                console.warn(`[chat] モデル ${modelName} が利用できないか混雑中のため、次のモデルにフォールバックします...`);
                try {
                    await interaction.editReply(`<a:load:1559811422261747783> モデル ${modelName} が混雑中のため、次のモデルに切り替えています...`);
                } catch (e) {}
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("chat")
        .setDescription("Gemini モデルと対話します")
        .addStringOption(option =>
            option.setName("prompt")
                .setDescription("AIに送るメッセージを入力してください")
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName("attachment")
                .setDescription("一緒に送信するファイル（画像、PDF、テキストなど）")
                .setRequired(false)
        )
        .setIntegrationTypes([
            ApplicationIntegrationType.GuildInstall,
            ApplicationIntegrationType.UserInstall
        ])
        .setContexts([
            InteractionContextType.Guild,
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel
        ]),

    async execute(interaction) {
        const userPrompt = interaction.options.getString("prompt");
        const attachment = interaction.options.getAttachment("attachment");

        await interaction.deferReply();
        
        let isCompleted = false;
        const slowTimer = setTimeout(async () => {
            if (!isCompleted) {
                try {
                    await interaction.editReply("<a:load:1559811422261747783> AIが考え込んでいます…（少々お時間がかかります）");
                } catch (e) {}
            }
        }, 5000);

        try {
            let contents = userPrompt;

            if (attachment) {
                const mimeType = attachment.contentType || "application/octet-stream";
                const filePart = await urlToGenerativePart(attachment.url, mimeType);
                contents = [userPrompt, filePart];
            }

            const response = await generateWithFallback(contents, interaction);

            isCompleted = true;
            clearTimeout(slowTimer);

            const replyText = response.text || "応答を取得できませんでした。";
            const textChunks = splitMessage(replyText);

            for (let i = 0; i < textChunks.length; i++) {
                const chunk = textChunks[i];
                // **Gemini:** を除き、本文のみを出力
                const content = (i === 0) ? `${chunk}` : `(続き)\n${chunk}`;

                if (i === 0) {
                    await interaction.editReply({ content: content });
                } else {
                    await interaction.followUp({ content: content });
                }
            }

        } catch (error) {
            isCompleted = true;
            clearTimeout(slowTimer);
            console.error("Gemini API Call Error:", error);
            await interaction.editReply("現在、すべてのGeminiモデルが混雑しているか一時的に利用できません。少し時間をおいてから再度お試しください。");
        }
    }
};