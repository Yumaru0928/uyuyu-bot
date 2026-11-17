const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { GACHA_ALL } = require('../../utils/emojis.js');
const gacha = require('../../utils/gacha.js');
const collection = require('../../utils/gacha-collection.js');
const gachaImage = require('../../utils/gacha-image.js');

const NAME_OF = new Map(GACHA_ALL.map(e => [e.name, e]));

module.exports = {
    // 必須 1: スラッシュコマンドの定義情報
    data: new SlashCommandBuilder()
        .setName('uyuyu-gacha')
        .setDescription('うゆゆ絵文字ガチャを10連引きます（図鑑に記録されます）'),

    // 必須 2: コマンド実行時の処理
    async execute(interaction) {
        await interaction.deferReply();

        const now = new Date();
        const userId = interaction.user.id;
        const won = collection.wonToday(userId, now);
        const night = gacha.isNightJst(now);

        // 抽選（レアリティ＋週替わりお休み＋条件枠）→ 図鑑へ記録
        const drawn = gacha.drawTen({ date: now, wonToday: won });
        const { newNames } = collection.addItems(userId, drawn.map(d => d.name));
        const newSet = new Set(newNames);
        const results = drawn.map(d => ({ ...d, isNew: newSet.has(d.name) }));

        const imageBuffer = await gachaImage.renderGachaResult(results);
        const files = imageBuffer ? [new AttachmentBuilder(imageBuffer, { name: 'gacha-result.png' })] : [];

        const hasSSR = drawn.some(d => d.rarity === 'SSR');
        const embed = new EmbedBuilder()
            .setTitle('うゆゆガチャ結果')
            .setColor(hasSSR ? '#ffd700' : '#0099ff');
        if (imageBuffer) embed.setImage('attachment://gacha-result.png');

        // 引いた内容（画像が見られない環境向けにもテキストで残す）
        embed.setDescription(drawn.map(d => {
            const e = NAME_OF.get(d.name);
            return `<:${e.name}:${e.id}>`;
        }).join(' '));

        if (newNames.length) {
            embed.addFields({
                name: '✨ NEW!',
                value: newNames.map(n => `<:${NAME_OF.get(n).name}:${NAME_OF.get(n).id}> ${n}`).join('\n'),
            });
        }
        const special = drawn.filter(d => d.rarity === 'SP');
        if (special.length) {
            embed.addFields({
                name: '🌟 条件ドロップ!',
                value: special.map(d => `${d.name} が混ざっていた！`).join('\n'),
            });
        }
        const resting = gacha.getRestingNames(now);
        embed.addFields({
            name: '💤 今週のお休み',
            value: resting.join(' / '),
        });
        const notes = [];
        if (night) notes.push('🌙 深夜帯：uyuyu_sleeping がプールに混ざっています');
        if (won) notes.push('🏆 本日対戦で勝利：uyuyu_take がプールに混ざっています');
        if (notes.length) embed.setFooter({ text: notes.join('\n') });

        await interaction.editReply({ embeds: [embed], files });
    }
};
