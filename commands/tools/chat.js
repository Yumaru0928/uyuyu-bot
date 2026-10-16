const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");
const {
    LOADING,
    NO_MENTIONS,
    CHAT_MODELS,
    CHAT_SYSTEM_INSTRUCTION,
    getAI,
    describeError,
    withModelFallback,
    urlToGenerativePart,
    splitMessage,
    processLongCodeBlocks
} = require("../../gemini.js");

async function generateWithFallback(selectedModel, contents, interaction) {
    const modelsToTry = [selectedModel, ...CHAT_MODELS.filter(m => m !== selectedModel)];
    return withModelFallback(
        modelsToTry,
        model => getAI().models.generateContent({
            model,
            config: { systemInstruction: CHAT_SYSTEM_INSTRUCTION },
            contents
        }),
        model => interaction.editReply({
            content: `${LOADING} モデル ${model} がレート制限か混雑中のため、次のモデルに切り替えています...`,
            allowedMentions: NO_MENTIONS
        }),
        "chat"
    );
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
        const selectedModel = interaction.options.getString("model") || CHAT_MODELS[0];
        const attachment = interaction.options.getAttachment("attachment");

        await interaction.deferReply();
        
        let isCompleted = false;
        const slowTimer = setTimeout(async () => {
            if (!isCompleted) {
                try {
                    await interaction.editReply(`${LOADING} AIが考え込んでいます…（少々お時間がかかります）`);
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

            // 長いコードのファイル化処理（プレフィックスなし）
            const { processedText, attachments } = processLongCodeBlocks(replyText);
            const textChunks = splitMessage(processedText);

            for (let i = 0; i < textChunks.length; i++) {
                const chunk = textChunks[i];
                const content = (i === 0) ? chunk : `(続き)\n${chunk}`;
                // AI の出力に含まれる @everyone / @role / @user では誰にも通知しない
                const options = {
                    content: content,
                    files: (i === 0) ? attachments : [],
                    allowedMentions: NO_MENTIONS
                };

                if (i === 0) {
                    await interaction.editReply(options);
                } else {
                    await interaction.followUp(options);
                }
            }

        } catch (error) {
            isCompleted = true;
            clearTimeout(slowTimer);
            console.error("Gemini API Call Error:", error);
            try {
                await interaction.editReply({ content: describeError(error, "AI"), files: [], allowedMentions: NO_MENTIONS });
            } catch (replyError) {
                console.error("[chat] エラー応答の送信に失敗しました:", replyError.message);
            }
        }
    }
};