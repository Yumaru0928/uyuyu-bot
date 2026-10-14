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

// スラッシュコマンド側でも指定のモデルリストを使ってフォールバックしつつ返信を編集する関数
async function generateWithFallback(prompt, interaction) {
    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            return await ai.models.generateContent({
                model: modelName,
                contents: prompt,
            });
        } catch (error) {
            lastError = error;
            if (error.status === 404 || error.status === 503 || error.status === 429 || (error.message && (error.message.includes('503') || error.message.includes('not found') || error.message.includes('overloaded')))) {
                console.warn(`[chat] モデル ${modelName} が利用できないか混雑中のため、次のモデルにフォールバックします...`);
                try {
                    // モデルを切り替える際にDiscord側のメッセージを編集して通知
                    await interaction.editReply(`<a:loading:1559775162734219284> モデル '${modelName}' が混雑中のため、次のモデル${modelsToTry[modelsToTry.indexOf(modelName) + 1]}に切り替えています...`);
                } catch (e) {
                    // 編集エラー時の無視
                }
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

        await interaction.deferReply();
        
        // 5秒以上かかった場合のタイマー演出
        let isCompleted = false;
        const slowTimer = setTimeout(async () => {
            if (!isCompleted) {
                try {
                    await interaction.editReply("<a:loading:1559775162734219284> AIが考え込んでいます…（少々お時間がかかります）");
                } catch (e) {
                    // すでに返信が終わっている場合などのエラーを無視
                }
            }
        }, 5000);

        try {
            // interaction を渡してフォールバック＆返信編集付きで実行
            const response = await generateWithFallback(userPrompt, interaction);

            isCompleted = true;
            clearTimeout(slowTimer);

            const replyText = response.text || "応答を取得できませんでした。";
            const textChunks = splitMessage(replyText);

            for (let i = 0; i < textChunks.length; i++) {
                const chunk = textChunks[i];
                const content = (i === 0) ? chunk : `(続き)\n${chunk}`;

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