const {
    SlashCommandBuilder,
    EmbedBuilder,
    AttachmentBuilder,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");
const { createCanvas } = require('@napi-rs/canvas'); //

const LOADING = "<a:load:1559811422261747783>";

/**
 * 簡易的なLaTeX風テキストをCanvasに描画して画像バッファを生成する関数
 * (※本格的なTeXパーサーの代わりに、綺麗にフォーマットされたテキストとしてを描画します)
 */
async function generateLatexImage(formulaText) {
    // 描画設定
    const paddingX = 40;
    const paddingY = 30;
    const fontSize = 28;

    // フォントを指定して横幅・高さを計算するための仮Canvas
    const dummyCanvas = createCanvas(100, 100);
    const dummyCtx = dummyCanvas.getContext('2d');
    dummyCtx.font = `${fontSize}px sans-serif`;

    // 改行で分割して複数行に対応
    const lines = formulaText.split('\n');

    // 各行の最大幅と高さを計算
    let maxWidth = 0;
    lines.forEach(line => {
        const metrics = dummyCtx.measureText(line);
        if (metrics.width > maxWidth) {
            maxWidth = metrics.width;
        }
    });

    const lineHeight = fontSize * 1.5;
    const width = Math.max(maxWidth + paddingX * 2, 300);
    const height = lines.length * lineHeight + paddingY * 2;

    // 本番用Canvasの作成
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 背景を黒に設定
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // 文字を白に設定
    ctx.fillStyle = '#ffffff';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textBaseline = 'top';

    // 各行を描画
    lines.forEach((line, index) => {
        const y = paddingY + index * lineHeight;
        ctx.fillText(line, paddingX, y);
    });

    return await canvas.encode('png');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("latex")
        .setDescription("LaTeXの数式（改行対応）をCanvasでレンダリングして画像表示します")
        .addStringOption(option =>
            option
                .setName("prompt")
                .setDescription("レンダリングしたい数式を入力してください (\\nで改行できます)")
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

            // 改行（\n やリテラルの \n）を実際の改行に変換
            cleanedPrompt = cleanedPrompt.replace(/\\n/g, '\n');

            // Canvasで黒背景・白文字の画像を生成
            const imageBuffer = await generateLatexImage(cleanedPrompt);
            const fileName = `latex_${Date.now()}.png`;
            const file = new AttachmentBuilder(imageBuffer, { name: fileName });

            isCompleted = true;
            clearTimeout(slowTimer);

            // 埋め込み（Embed）を作成
            const embed = new EmbedBuilder()
                .setColor("#2b2d31")
                .setTitle("📐 LaTeX 数式レンダリング")
                .addFields(
                    { name: "入力コード", value: `\`\`\`latex\n${rawPrompt}\n\`\`\`` }
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
            await interaction.editReply("エラーが発生したため、数式をレンダリングできませんでした。数式の記述を確認してください。");
        }
    }
};