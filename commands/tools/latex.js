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
        .setDescription("LaTeXの数式（改行対応）をレンダリングして画像として表示します")
        .addStringOption(option =>
            option
                .setName("prompt")
                .setDescription("レンダリングしたいLaTeX数式を入力してください (\\nで改行できます)")
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

        // 一時応答を開始
        await interaction.deferReply();

        let isCompleted = false;
        // 5秒以上かかる場合の待機メッセージ表記
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

            // 改行（\n やテキスト上の改行）を LaTeX の改行コード (\\) に置換
            cleanedPrompt = cleanedPrompt.replace(/\\n/g, '\\\\');

            // QuickLaTeX APIを利用して数式画像を生成
            // &formula= 数式
            // &fcolor=ffffff (文字色: 白)
            // &bcolor=000000 (背景色: 黒)
            // &fsize=18px   (フォントサイズ)
            const encodedFormula = encodeURIComponent(cleanedPrompt);
            const latexImageUrl = `https://quicklatex.com/cache3/render.cgi?formula=${encodedFormula}&fcolor=ffffff&bcolor=000000&fsize=18px&mode=0&out=1`;

            isCompleted = true;
            clearTimeout(slowTimer);

            // 埋め込み（Embed）を作成
            const embed = new EmbedBuilder()
                .setColor("#2b2d31") // Discordのダークモードになじむ色
                .setTitle("📐 LaTeX 数式レンダリング")
                .addFields(
                    { name: "入力コード", value: `\`\`\`latex\n${rawPrompt}\n\`\`\`` }
                )
                .setImage(latexImageUrl)
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp();

            await interaction.editReply({
                content: null,
                embeds: [embed]
            });

        } catch (error) {
            isCompleted = true;
            clearTimeout(slowTimer);

            console.error("LaTeX Rendering Error:", error);
            await interaction.editReply("エラーが発生したため、数式をレンダリングできませんでした。数式の記述を確認してください。");
        }
    }
};