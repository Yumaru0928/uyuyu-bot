const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { GACHA_ALL } = require('../../utils/emojis.js');
const gacha = require('../../utils/gacha.js');
const collection = require('../../utils/gacha-collection.js');
const gachaImage = require('../../utils/gacha-image.js');

const TIER_LABEL = { gold: '🥇金枠', silver: '🥈銀枠', normal: '登録済み', none: '未所持' };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('uyuyu-zukan')
        .setDescription('うゆゆ絵文字の図鑑（自分の所持状況）を表示します'),

    async execute(interaction) {
        await interaction.deferReply();

        const userId = interaction.user.id;
        const { items, total } = collection.getCollection(userId);

        // 図鑑の並び順は GACHA_ALL（通常プール→条件枠）
        const entries = GACHA_ALL.map(e => {
            const count = items[e.name] ?? 0;
            return { ...e, count, tier: gacha.frameTier(count) };
        });

        const imageBuffer = await gachaImage.renderZukan(entries);
        const files = imageBuffer ? [new AttachmentBuilder(imageBuffer, { name: 'uyuyu-zukan.png' })] : [];

        const kinds = entries.filter(e => e.count > 0).length;
        const percent = Math.floor((kinds / GACHA_ALL.length) * 100);
        const golds = entries.filter(e => e.tier === 'gold').length;
        const silvers = entries.filter(e => e.tier === 'silver').length;

        const embed = new EmbedBuilder()
            .setTitle(`📖 ${interaction.user.displayName ?? interaction.user.username} のうゆゆ図鑑`)
            .setColor(kinds === GACHA_ALL.length ? '#ffd700' : '#0099ff')
            .addFields(
                { name: 'コンプリート率', value: `${kinds} / ${GACHA_ALL.length} 種（${percent}%）`, inline: true },
                { name: '総所持数', value: `${total} 個`, inline: true },
                { name: '育成枠', value: `金枠 ${golds} 種 / 銀枠 ${silvers} 種（銀枠=${gacha.FRAME_SILVER}個・金枠=${gacha.FRAME_GOLD}個で進化）`, inline: true },
            );
        if (imageBuffer) embed.setImage('attachment://uyuyu-zukan.png');

        // 所持一覧（名前と個数）。Discord のフィールド上限（1024字）を超える場合は行単位で分割する
        const owned = entries.filter(e => e.count > 0);
        if (owned.length) {
            const lines = owned.map(e => `<:${e.name}:${e.id}> ${e.name} ×${e.count}（${TIER_LABEL[e.tier]}）`);
            const chunks = [];
            let cur = '';
            for (const line of lines) {
                if (cur && cur.length + 1 + line.length > 1000) { chunks.push(cur); cur = ''; }
                cur = cur ? cur + '\n' + line : line;
            }
            if (cur) chunks.push(cur);
            chunks.forEach((value, i) => {
                embed.addFields({ name: i === 0 ? '所持中' : '所持中（続き）', value });
            });
        }
        // 未所持の条件枠はヒントだけ出す（答えは書かない）
        const missingCond = entries.filter(e => e.count === 0 && e.condition);
        if (missingCond.length) {
            embed.addFields({
                name: '？？？（隠し枠のヒント）',
                value: missingCond.map(e => `・${e.hint}`).join('\n'),
            });
        }
        const resting = gacha.getRestingNames(new Date());
        embed.addFields({ name: '💤 今週のお休み（ガチャに出ない）', value: resting.join(' / ') });

        await interaction.editReply({ embeds: [embed], files });
    }
};
