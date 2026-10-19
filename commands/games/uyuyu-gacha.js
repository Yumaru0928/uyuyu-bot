const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { UYUYU_EMOJIS } = require('../../emojis.js');

// 対象の絵文字IDリスト（絵文字の一覧は emojis.js にまとめてある）
const Emojis = UYUYU_EMOJIS.map(emoji => emoji.id);

// 絵文字画像は一度読み込んだらメモリに残す（毎回CDNから10枚ダウンロードしない）
const imageCache = new Map();

async function loadEmojiImage(emojiId) {
    if (!imageCache.has(emojiId)) {
        // 同時に呼ばれても1回しか取りに行かないよう、読み込み中の Promise をそのまま保存する
        const promise = loadImage(`https://cdn.discordapp.com/emojis/${emojiId}.png`).catch(error => {
            imageCache.delete(emojiId); // 失敗したものは次回また試す
            throw error;
        });
        imageCache.set(emojiId, promise);
    }
    return imageCache.get(emojiId);
}

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

    // 画像は並行して読み込む（キャッシュ済みならすぐ終わる）
    const images = await Promise.all(selectedIds.map(async emojiId => {
        try {
            return await loadEmojiImage(emojiId);
        } catch (error) {
            console.error(`絵文字画像 (${emojiId}) の読み込みに失敗しました:`, error);
            return null;
        }
    }));

    images.forEach((img, i) => {
        if (!img) return;
        const col = i % columns;
        const row = Math.floor(i / columns);

        const x = padding + col * (emojiSize + padding);
        const y = padding + row * (emojiSize + padding);

        ctx.drawImage(img, x, y, emojiSize, emojiSize);
    });

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