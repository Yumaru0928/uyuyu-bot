const {
    SlashCommandBuilder,
    EmbedBuilder,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");
const LOADING = "<a:load:1559811422261747783>";

module.exports = {
    data: new SlashCommandBuilder()
        .setName("latex")
        .setDescription("LaTeXの数式をレンダリングして画像として表示します")
        .addStringOption(option =>
            option
                .setName("prompt")
                .setDescription("レンダリングしたいLaTeX数式を入力してください (例: x^2 + y^2 = r^2)")
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
        const prompt = interaction.options.getString("prompt");

        // 処理に少し時間がかかる場合を考慮して一時応答（思考中）にする
        await interaction.deferReply();

        let isCompleted = false;
        const slowTimer = setTimeout(async () => {
            if (!isCompleted) {
                try {
                    await interaction.editReply(`${LOADING} 画像を生成しています...`);
                } catch (e) { }
            }
        }, 5000);

        try {
            // 入力された数式の前後の $ マークがもし含まれていればトリムする（オプション）
            const cleanedPrompt = prompt.replace(/^\$+|\$+$/g, '').trim();

            // CodeCogsのAPIを利用してLaTeXの画像URLを生成
            const encodedFormula = encodeURIComponent(cleanedPrompt);
            // ※ dpiや背景色、文字色などをURLパラメータで調整可能です
            const latexImageUrl = `https://latex.codecogs.com/png.latex?${encodedFormula}`;

            // 埋め込み（Embed）を作成
            const embed = new EmbedBuilder()
                .setColor("#3498db")
                .setTitle("📐 LaTeX 数式レンダリング")
                .addFields(
                    { name: "入力コード", value: `\`\`\`latex\n${cleanedPrompt}\n\`\`\`` }
                )
                .setImage(latexImageUrl)
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            isCompleted = true;

        } catch (error) {
            console.error("LaTeX Rendering Error:", error);
            await interaction.editReply("エラーが発生したため、数式をレンダリングできませんでした。数式のエントリを確認してください。");
        }
    }
};