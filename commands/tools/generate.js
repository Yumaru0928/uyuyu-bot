const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType,
    AttachmentBuilder,
    MessageFlags
} = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");

// config.json を安全に読み込む（存在しないRender環境などではスキップ）
let config = {};
const configPath = path.join(__dirname, "../../config.json"); // パスはプロジェクト構成に合わせて調整してください
if (fs.existsSync(configPath)) {
    try {
        config = require(configPath);
    } catch (e) {
        console.warn("[Cloudflare AI] config.json の読み込みに失敗しました:", e.message);
    }
}

const LOADING = "<a:load:1559811422261747783>";

// 環境変数を優先し、無ければ config.json から読み込む
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || config.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || config.CLOUDFLARE_API_TOKEN;
// 利用するモデル
const MODELS_TO_TRY = [
    '@cf/black-forest-labs/flux-1-schnell'
];

// Cloudflare Workers AI を呼び出して画像を生成する関数
async function generateImageWithCloudflare(prompt, onFallback) {
    let lastError = null;

    for (const modelName of MODELS_TO_TRY) {
        try {
            const response = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${modelName}`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        prompt: prompt,
                        steps: 4 // schnellの推奨ステップ数（最大8）
                    })
                }
            );

            const result = await response.json();

            if (!result.success) {
                const errorMsg = result.errors?.[0]?.message || 'APIのエラーが発生しました。';
                throw new Error(errorMsg);
            }

            const base64Data = result.result?.image;
            if (!base64Data) {
                throw new Error(`モデル ${modelName} から画像データが返されませんでした。`);
            }

            return {
                image: base64Data,
                modelLabel: modelName
            };

        } catch (error) {
            lastError = error;
            console.warn(`[Cloudflare AI] モデル ${modelName} でエラーが発生しました:`, error.message);
            
            if (onFallback) {
                await onFallback(modelName, error.message);
            }
        }
    }
    throw lastError;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("generate")
        .setDescription("Cloudflare Workers AI (FLUX.1 schnell) で画像を生成します")
        .addStringOption(option =>
            option.setName("prompt")
                .setDescription("生成したい画像の内容を入力してください")
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName("attachments")
                .setDescription("参考画像（現状のAPI仕様上、テキストプロンプトが優先されます）")
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
                    await interaction.editReply(`${LOADING} Cloudflareで画像を生成しています…（少々お時間がかかります）`);
                } catch (e) { }
            }
        }, 5000);

        try {
            const result = await generateImageWithCloudflare(userPrompt, async (failedModel, msg) => {
                try {
                    await interaction.editReply(`${LOADING} モデル \`${failedModel}\` が混雑中またはエラーのため切り替えています...`);
                } catch (e) { }
            });

            isCompleted = true;
            clearTimeout(slowTimer);

            const buffer = Buffer.from(result.image, "base64");
            const fileName = `generated_${Date.now()}.jpg`;
            const file = new AttachmentBuilder(buffer, { name: fileName });

            const shortPrompt = userPrompt.length > 500 ? `${userPrompt.slice(0, 500)}…` : userPrompt;
            const lines = [
                `-# プロンプト: ${shortPrompt.replace(/\n/g, " ")}`,
                '-# ヒント：`/chat`でAIにプロンプトを生成させることができます！'
            ];

            await interaction.editReply({
                content: lines.join("\n"),
                files: [file]
            });

        } catch (error) {
            isCompleted = true;
            clearTimeout(slowTimer);

            console.error("Cloudflare Image Generate Error:", error);
            await interaction.editReply("現在、画像生成APIの制限や混雑のため画像を生成できませんでした。設定ファイルの値やアカウントの状態を確認して再度お試しください。");
        }
    }
};