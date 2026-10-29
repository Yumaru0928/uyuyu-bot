const {
    SlashCommandBuilder,
    EmbedBuilder,
    AttachmentBuilder,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");
const { createCanvas, loadImage } = require('@napi-rs/canvas');

// MathJax (LaTeX -> SVG)
const { mathjax } = require('mathjax-full/js/mathjax.js');
const { TeX } = require('mathjax-full/js/input/tex.js');
const { SVG } = require('mathjax-full/js/output/svg.js');
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js');

const LOADING = "<a:load:1559811422261747783>";

// ---- MathJax 初期化（起動時に1回だけ） ----
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const texInput = new TeX({
    packages: AllPackages,
    // 構文エラー時に例外を投げる（デフォルトだとエラー表示の画像になる）
    formatError: (jax, err) => { throw err; }
});
const svgOutput = new SVG({ fontCache: 'none' });
const mjDocument = mathjax.document('', { InputJax: texInput, OutputJax: svgOutput });

const SCALE = 2.5;        // 数式の拡大率（大きくしたい場合はここを増やす）
const EX_TO_PX = 8 * SCALE; // MathJaxは 1ex = 8px 基準

/** LaTeX 1行 -> { img, width, height } */
async function renderLine(tex) {
    const node = mjDocument.convert(tex, { display: true });
    let svg = adaptor.innerHTML(node);

    // ex 単位の幅・高さを px に変換
    const w = parseFloat(svg.match(/width="([\d.]+)ex"/)?.[1] ?? 0) * EX_TO_PX;
    const h = parseFloat(svg.match(/height="([\d.]+)ex"/)?.[1] ?? 0) * EX_TO_PX;

    svg = svg
        .replace(/width="[\d.]+ex"/, `width="${w}px"`)
        .replace(/height="[\d.]+ex"/, `height="${h}px"`)
        .replace(/currentColor/g, '#ffffff'); // 文字色を白に

    const img = await loadImage(Buffer.from(svg));
    return { img, width: w, height: h };
}

/** LaTeX（複数行対応）-> PNG Buffer */
async function generateLatexImage(formulaText) {
    const paddingX = 40;
    const paddingY = 30;
    const lineGap = 16;

    const lines = formulaText.split('\n');
    const rendered = [];
    for (const line of lines) {
        if (line.trim() === '') {
            rendered.push({ img: null, width: 0, height: 24 }); // 空行
        } else {
            rendered.push(await renderLine(line));
        }
    }

    const maxWidth = Math.max(...rendered.map(r => r.width));
    const totalHeight = rendered.reduce((sum, r) => sum + r.height, 0)
        + lineGap * (rendered.length - 1);

    const width = Math.ceil(Math.max(maxWidth + paddingX * 2, 300));
    const height = Math.ceil(totalHeight + paddingY * 2);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 黒背景
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // 各行を中央揃えで描画
    let y = paddingY;
    for (const r of rendered) {
        if (r.img) {
            const x = (width - r.width) / 2;
            ctx.drawImage(r.img, x, y, r.width, r.height);
        }
        y += r.height + lineGap;
    }

    return await canvas.encode('png');
}

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