const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

// 対象の絵文字IDリスト
const Emojis = [
    '1549375294614540409',
    '1557748837194403972',
    '1557748839035838626',
    '1557409093059219457',
    '1557407745676943392',
    '1557409243311644846',
    '1557407749556408381',
    '1557407765704478900',
    '1557407751259291698',
    '1557407738919919666',
    '1557407767600570418',
    '1557407760986017853',
    '1557407743931842610',
    '1557407787221516289',
    '1557407747627294761'
];

/**
 * 10個の絵文字を選出して5×2のグリッド画像を生成する関数
 */
async function generateEmojiGridImage() {
    const selectedIds = [];
    for (let i = 0; i < 10; i++) {
        const rand = Math.floor(Math.random() * Emojis.length);
        selectedIds.push(Emojis[rand]);
    }

    const emojiSize = 128;
    const padding = 16;
    const columns = 5;
    const rows = 2;

    const width = columns * emojiSize + (columns + 1) * padding;
    const height = rows * emojiSize + (rows + 1) * padding;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 背景色（ダークモード風）
    ctx.fillStyle = '#2f3136';
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < selectedIds.length; i++) {
        const emojiId = selectedIds[i];
        const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.png`;

        try {
            const img = await loadImage(emojiUrl);
            const col = i % columns;
            const row = Math.floor(i / columns);

            const x = padding + col * (emojiSize + padding);
            const y = padding + row * (emojiSize + padding);

            ctx.drawImage(img, x, y, emojiSize, emojiSize);
        } catch (error) {
            console.error(`絵文字画像 (${emojiId}) の読み込みに失敗しました:`, error);
        }
    }

    return await canvas.encode('png');
}

module.exports = {
    // 必須 1: スラッシュコマンドの定義情報
    data: new SlashCommandBuilder()
        .setName('uyuyu-gacha')
        .setDescription('うゆゆ絵文字ガチャを10連引いて画像で表示します'),

    // 必須 2: コマンド実行時の処理
    async execute(interaction) {
        await interaction.deferReply();

        const imageBuffer = await generateEmojiGridImage();
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'gacha-result.png' });

        const embed = new EmbedBuilder()
            .setTitle('うゆゆガチャ結果')
            .setColor('#0099ff')
            .setImage('attachment://gacha-result.png');

        await interaction.editReply({
            embeds: [embed],
            files: [attachment]
        });
    }
};