const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require("discord.js");

// 静止画IDまたはアニメーション絵文字フォーマットを統一・直接定義
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
    '1539487778553729064',
    'a:rolling_uyuyu:1529182253207392267'
];

// ガチャを10回引くヘルパー関数
function drawGacha() {
    const result = [];
    for (let i = 0; i < 10; i++) {
        const rand = Math.floor(Math.random() * Emojis.length);
        const item = Emojis[rand];
        
        // 'a:' で始まる（アニメーション絵文字）かどうかの判定
        if (item.startsWith('a:')) {
            result.push(`<${item}>`);
        } else {
            result.push(`<:emoji:${item}>`);
        }
    }
    return result.join(" ");
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("uyuyu-gacha")
        .setDescription("うゆゆガチャを回します。"),
    async execute(interaction) {
        // ガチャ結果の生成
        const gachaResult = drawGacha();

        const embed = new EmbedBuilder()
            .setColor("#0099ff")
            .setTitle("うゆゆガチャ結果")
            .setDescription(gachaResult);

        const rerollButton = new ButtonBuilder()
            .setCustomId("reroll")
            .setLabel("もう一度回す")
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(rerollButton);

        const response = await interaction.reply({
            embeds: [embed],
            components: [row],
            fetchReply: true
        });

        // ボタンのインタラクション監視設定
        const collector = response.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 15000
        });

        collector.on('collect', async i => {
            // 実行した本人のみ操作可能
            if (i.user.id !== interaction.user.id) {
                await i.reply({ content: 'このボタンは実行した本人のみ使用できます。', ephemeral: true });
                return;
            }

            // 再度ガチャを引いて埋め込みを更新
            const newGachaResult = drawGacha();
            const newEmbed = new EmbedBuilder()
                .setColor("#0099ff")
                .setTitle("うゆゆガチャ結果")
                .setDescription(newGachaResult);

            await i.update({ embeds: [newEmbed], components: [row] });
        });

        // タイムアウト時にボタンを無効化
        collector.on('end', async () => {
            rerollButton.setDisabled(true);
            const disabledRow = new ActionRowBuilder().addComponents(rerollButton);
            await interaction.editReply({ components: [disabledRow] }).catch(() => {});
        });
    }
};