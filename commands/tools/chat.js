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

// URLからファイルをダウンロードして、Geminiが扱えるInlineData形式に変換する関数
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

async function generateWithFallback(selectedModel, contents, interaction) {
    // 選択されたモデルを最初に試し、ダメだったら他のモデルに順次フォールバックする配列を作成
    const defaultModels = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-4-argon'];
    const modelsToTry = [selectedModel, ...defaultModels.filter(m => m !== selectedModel)];
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
                    await interaction.editReply(`<a:load:1559811422261747783> モデル ${modelName} がレート制限か混雑中のため、次のモデルに切り替えています...`);
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
        .addStringOption(option =>
            option.setName("model")
                .setDescription("使用するGeminiモデルを選択してください（省略時はデフォルト）")
                .setRequired(false)
                .addChoices(
                    { name: 'Gemini 3.8 Flash', value: 'gemini-3.8-flash' },
                    { name: 'Gemini 3.7 Flash', value: 'gemini-3.7-flash' },
                    { name: 'Gemini 3.6 Flash', value: 'gemini-3.6-flash' },
                    { name: 'Gemini 3.5 Flash Lite', value: 'gemini-3.5-flash-lite' },
                    { name: 'Gemini 3.1 Flash Lite', value: 'gemini-3.1-flash-lite' },
                    { name: 'Gemini 3.1 Pro Preview', value: 'gemini-3.1-pro-preview' },
                    { name: 'Gemini 4 Argon', value: 'gemini-4-argon' }
                )
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
        const selectedModel = interaction.options.getString("model") || 'gemini-3.8-flash';
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

            const response = await generateWithFallback(selectedModel, contents, interaction);

            isCompleted = true;
            clearTimeout(slowTimer);

            const replyText = response.text || "応答を取得できませんでした。";
            const textChunks = splitMessage(replyText);

            for (let i = 0; i < textChunks.length; i++) {
                const chunk = textChunks[i];
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
            await interaction.editReply("現在、すべてのGeminiモデルがAPI/レート制限のため一時的に利用できません。少し時間をおいてから再度お試しください。");
        }
    }
};