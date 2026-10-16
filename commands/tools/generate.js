const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType,
    AttachmentBuilder,
    MessageFlags
} = require("discord.js");
const { GoogleGenAI } = require("@google/genai");

const LOADING = "<a:load:1559811422261747783>";

// GoogleGenAIクライアントの初期化（環境変数 GEMINI_API_KEY が自動で読み込まれます）
const ai = new GoogleGenAI({});

// 指定された順序でフォールバックしながら画像を生成する関数
async function generateImageWithFallback(contents, onFallback) {
    const modelsToTry = [
        'gemini-nano-banana-2.1',
        'gemini-3.1-flash-lite-image',
        'gemini-3.1-flash-image',
        'gemini-2.5-flash-image'
    ];
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            const interactionResult = await ai.interactions.create({
                model: modelName,
                input: contents,
            });

            const generatedImage = interactionResult.output_image;
            if (!generatedImage) {
                // 画像データが含まれていない場合はエラーとして扱って次へ
                throw new Error(`モデル ${modelName} から画像が返されませんでした。`);
            }

            return {
                image: generatedImage,
                modelLabel: modelName
            };
        } catch (error) {
            lastError = error;
            // 404, 503, 429 や混雑エラーなどの場合に次のモデルへフォールバック
            const status = error.status;
            const message = error.message || "";
            if (
                status === 404 || 
                status === 503 || 
                status === 429 || 
                message.includes('503') || 
                message.includes('429') || 
                message.includes('404') || 
                message.includes('not found') || 
                message.includes('overloaded') ||
                message.includes('画像が返されませんでした')
            ) {
                console.warn(`[Image Generate] モデル ${modelName} が利用できないか混雑中のため、次のモデルにフォールバックします...`, error);
                if (onFallback) {
                    await onFallback(modelName);
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
        .setName("generate")
        .setDescription("Gemini モデルで画像を生成します")
        .addStringOption(option =>
            option.setName("prompt")
                .setDescription("生成したい画像の内容を入力してください")
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName("attachments")
                .setDescription("参考にする画像（編集したい画像、スタイル参考など）")
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
        const attachment = interaction.options.getAttachment("attachments");

        // 画像以外のファイルは受け付けない
        if (attachment && !(attachment.contentType || "").startsWith("image/")) {
            await interaction.reply({
                content: `添付できるのは画像ファイルのみです（\`${attachment.name}\` は画像ではありません）。`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply();

        let isCompleted = false;
        const slowTimer = setTimeout(async () => {
            if (!isCompleted) {
                try {
                    await interaction.editReply(`${LOADING} 画像を生成しています…（少々お時間がかかります）`);
                } catch (e) { }
            }
        }, 5000);

        try {
            // 入力データの組み立て
            // ※必要に応じて添付画像のフェッチ・マルチモーダル対応部分を適宜組み込んでください
            const contents = attachment 
                ? [userPrompt, { inlineData: { data: "", mimeType: attachment.contentType } }] 
                : userPrompt;

            // フォールバック機構付きの画像生成呼び出し
            const result = await generateImageWithFallback(contents, async (failedModel) => {
                try {
                    await interaction.editReply(`${LOADING} ${failedModel} がレート制限か混雑中のため、次のモデルに切り替えています...`);
                } catch (e) { }
            });

            isCompleted = true;
            clearTimeout(slowTimer);

            // Base64データをBufferに変換
            const buffer = Buffer.from(result.image.data, "base64");
            const fileName = `generated_${Date.now()}.png`;
            const file = new AttachmentBuilder(buffer, { name: fileName });

            const shortPrompt = userPrompt.length > 500 ? `${userPrompt.slice(0, 500)}…` : userPrompt;
            const lines = [
                `-# 🎨 ${result.modelLabel} で生成`,
                `-# プロンプト: ${shortPrompt.replace(/\n/g, " ")}`
            ];

            await interaction.editReply({
                content: lines.join("\n"),
                files: [file]
            });

        } catch (error) {
            isCompleted = true;
            clearTimeout(slowTimer);

            console.error("Gemini Image Generate Error:", error);
            await interaction.editReply("現在、すべての画像生成モデルがAPI制限や混雑のため一時的に利用できません。少し時間をおいてから再度お試しください。");
        }
    }
};