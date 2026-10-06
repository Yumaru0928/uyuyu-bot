const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas'); // Canvasの読み込み

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
 * @returns {Promise<Buffer>} 画像バッファ
 */
async function generateEmojiGridImage() {
    // 1. ガチャ等で10個の絵文字IDをランダム選出
    const selectedIds = [];
    for (let i = 0; i < 10; i++) {
        const rand = Math.floor(Math.random() * Emojis.length);
        selectedIds.push(Emojis[rand]);
    }

    // 2. レイアウトのパラメータ設定
    const emojiSize = 128; // 1つの絵文字の解像度（ピクセル）
    const padding = 16;   // 絵文字同士の間隔（余白）
    const columns = 5;    // 横5列
    const rows = 2;       // 縦2行

    // 全体のキャンバスサイズ計算
    const width = columns * emojiSize + (columns + 1) * padding;
    const height = rows * emojiSize + (rows + 1) * padding;

    // 3. Canvasの作成と背景描画
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 背景（ダークモード風の背景色、透過にしたい場合はコメントアウト）
    ctx.fillStyle = '#2f3136';
    ctx.fillRect(0, 0, width, height);

    // 4. 10個の絵文字画像を順に描画
    for (let i = 0; i < selectedIds.length; i++) {
        const emojiId = selectedIds[i];
        const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.png`;

        try {
            // CDNから絵文字画像を読み込み
            const img = await loadImage(emojiUrl);

            // グリッド位置（列 index, 行 index）の計算
            const col = i % columns;
            const row = Math.floor(i / columns);

            // 描画座標（X, Y）の計算
            const x = padding + col * (emojiSize + padding);
            const y = padding + row * (emojiSize + padding);

            // Canvasへ描画
            ctx.drawImage(img, x, y, emojiSize, emojiSize);
        } catch (error) {
            console.error(`絵文字画像 (${emojiId}) の読み込みに失敗しました:`, error);
        }
    }

    // PNG画像バッファとして出力
    return await canvas.encode('png');
}

// --- スラッシュコマンド等での使用例 ---
module.exports = {
    // execute(interaction) 等の中で呼び出す場合
    async execute(interaction) {
        await interaction.deferReply(); // 画像作成処理のため一時応答

        // 5x2の合成画像を生成
        const imageBuffer = await generateEmojiGridImage();

        // Discord送信用の添付ファイルオブジェクトを作成
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'gacha-result.png' });

        // Embedに画像をセットして送信する場合
        const embed = new EmbedBuilder()
            .setTitle('うゆゆガチャ結果')
            .setColor('#0099ff')
            .setImage('attachment://gacha-result.png');

        await interaction.editReply({
            embeds: [embed],
            files: [attachment] // 添付ファイルとして送信
        });
    }
};