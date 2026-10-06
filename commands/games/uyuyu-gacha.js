const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

// 対象の絵文字IDリスト
const Emojis = [
    '1549375294614540409',
    '1524698363532935248',
    '1521842573314887762',
    '1528488334014283806',
    '1537390880934203392',
    '1551217609880510534',
    '1512638117268685020',
    '1528265962984439970',
    '1528093863573585924',
    '1527287285446344704',
    '1528036666936131715',
    '1529686813071900814',
    '1539487778553729064'
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