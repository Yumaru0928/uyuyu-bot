const {
    SlashCommandBuilder,
    EmbedBuilder,
    AttachmentBuilder,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");
const { generateLatexImage } = require("../../latex-render.js");

const LOADING = "<a:load:1559811422261747783>";

module.exports = {
    data: new SlashCommandBuilder()
        .setName("latex")
        .setDescription("LaTeXの数式（改行対応）をレンダリングして画像表示します")
        .addStringOption(option =>
            option
                .setName("prompt")
                .setDescription("数式を入力 (例: \\frac{a}{b} \\n E=mc^2)  ※\\n で改行")
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
        const rawPrompt = interaction.options.getString("prompt");

        await interaction.deferReply();

        let isCompleted = false;
        const slowTimer = setTimeout(async () => {
            if (!isCompleted) {
                try {
                    await interaction.editReply(`${LOADING} LaTeX数式をレンダリングしています…（少々お時間がかかります）`);
                } catch (e) { }
            }
        }, 5000);

        try {
            // 前後の $ をトリム
            let cleanedPrompt = rawPrompt.replace(/^\$+|\$+$/g, '').trim();

            // "\n" を改行に変換。ただし \neq \nabla \newline など
            // 「\n + 英字」はLaTeXコマンドなので変換しない
            cleanedPrompt = cleanedPrompt.replace(/\\n(?![a-zA-Z])/g, '\n');

            const imageBuffer = await generateLatexImage(cleanedPrompt);
            const fileName = `latex_${Date.now()}.png`;
            const file = new AttachmentBuilder(imageBuffer, { name: fileName });

            isCompleted = true;
            clearTimeout(slowTimer);

            const embed = new EmbedBuilder()
                .setColor("#2b2d31")
                .setTitle("📐 LaTeX 数式レンダリング")
                .addFields(
                    { name: "入力コード", value: `\`\`\`latex\n${rawPrompt.slice(0, 1000)}\n\`\`\`` }
                )
                .setImage(`attachment://${fileName}`)
                .setFooter({
                    text: `Requested by ${interaction.user.tag}`,
                    iconURL: interaction.user.displayAvatarURL()
                })
                .setTimestamp();

            await interaction.editReply({
                content: null,
                embeds: [embed],
                files: [file]
            });

        } catch (error) {
            isCompleted = true;
            clearTimeout(slowTimer);

            console.error("LaTeX Rendering Error:", error);
            await interaction.editReply(
                `数式をレンダリングできませんでした。LaTeXの記述を確認してください。\n\`\`\`\n${String(error.message).slice(0, 500)}\n\`\`\``
            );
        }
    }
};