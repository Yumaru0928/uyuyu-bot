const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType,
    AttachmentBuilder,
    MessageFlags
} = require("discord.js");
const {
    GENERATED_FILE_PREFIX,
    NoImageError,
    urlToGenerativePart,
    mimeToExtension,
    generateImageWithFallback
} = require("../../image-generate.js");

const LOADING = "<a:load:1559811422261747783>";

module.exports = {
    data: new SlashCommandBuilder()
        .setName("generate")
        .setDescription("Gemini Nano Banana で画像を生成します（生成後に返信すると追加の修正もできます）")
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
        .addAttachmentOption(option =>
            option.setName("attachments2")
                .setDescription("参考にする画像 その2")
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option.setName("attachments3")
                .setDescription("参考にする画像 その3")
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
        const attachments = ["attachments", "attachments2", "attachments3"]
            .map(name => interaction.options.getAttachment(name))
            .filter(Boolean);

        // 画像以外のファイルは受け付けない
        const invalid = attachments.find(a => !(a.contentType || "").startsWith("image/"));
        if (invalid) {
            await interaction.reply({
                content: `添付できるのは画像ファイルのみです（\`${invalid.name}\` は画像ではありません）。`,
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
            const contents = [userPrompt];
            for (const attachment of attachments) {
                contents.push(await urlToGenerativePart(attachment.url, attachment.contentType));
            }

            const result = await generateImageWithFallback(contents, async (label) => {
                await interaction.editReply(`${LOADING} ${label} がレート制限か混雑中のため、次のモデルに切り替えています...`);
            });

            isCompleted = true;
            clearTimeout(slowTimer);

            const fileName = `${GENERATED_FILE_PREFIX}${Date.now()}.${mimeToExtension(result.image.mimeType)}`;
            const file = new AttachmentBuilder(result.image.buffer, { name: fileName });

            // reply-generate が元のプロンプトを拾えるように「-# プロンプト:」行を残す
            const shortPrompt = userPrompt.length > 500 ? `${userPrompt.slice(0, 500)}…` : userPrompt;
            const lines = [
                `-# 🎨 ${result.modelLabel} で生成`,
                `-# プロンプト: ${shortPrompt.replace(/\n/g, " ")}`,
                `-# このメッセージに返信すると、追加の要望を反映して作り直します`
            ];
            if (result.text) {
                lines.unshift(result.text.slice(0, 1000));
            }

            await interaction.editReply({
                content: lines.join("\n"),
                files: [file]
            });
        } catch (error) {
            isCompleted = true;
            clearTimeout(slowTimer);

            if (error instanceof NoImageError) {
                console.warn("[generate] 画像が返りませんでした:", error.modelText);
                const reason = error.modelText ? `\n> ${error.modelText.slice(0, 500)}` : "";
                await interaction.editReply(`画像を生成できませんでした。プロンプトを変えて試してみてください。${reason}`);
                return;
            }

            console.error("Gemini Image Generate Error:", error);
            await interaction.editReply("現在、すべての画像生成モデルがAPI/レート制限のため一時的に利用できません。少し時間をおいてから再度お試しください。");
        }
    }
};
