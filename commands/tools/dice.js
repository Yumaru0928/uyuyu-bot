const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

// 荒らし・フリーズ防止の上限
const MAX_DICE = 100;   // 一度に振れる個数
const MAX_SIDES = 1000; // サイコロの面数

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dice')
        .setDescription('サイコロを振ります。')
        .addStringOption(option =>
            option.setName('dices')
                .setDescription(`振るサイコロの種類を指定します。例: 1d6, 2d10, 3d20（最大 ${MAX_DICE}d${MAX_SIDES}）`)
                .setRequired(true)
        ),
    async execute(interaction) {
        const dices = interaction.options.getString('dices').trim().toLowerCase();

        // 先に形式を検証する（検証前に個数を使ってループしない）
        const match = dices.match(/^(\d{1,4})d(\d{1,6})$/);
        if (!match) {
            await interaction.reply({
                content: '正しい形式でサイコロを指定してください。例: 1d6, 2d10, 3d20',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const count = parseInt(match[1], 10);
        const sides = parseInt(match[2], 10);
        if (count < 1 || sides < 1 || count > MAX_DICE || sides > MAX_SIDES) {
            await interaction.reply({
                content: `サイコロは 1〜${MAX_DICE} 個、面数は 1〜${MAX_SIDES} までにしてください。`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const results = [];
        let total = 0;
        for (let i = 0; i < count; i++) {
            const roll = Math.floor(Math.random() * sides) + 1;
            results.push(roll);
            total += roll;
        }

        // Embed のフィールドは 1024 文字まで。収まらない分は省略する
        let rolls = results.join(', ');
        if (rolls.length > 1000) {
            let shown = 0;
            let length = 0;
            for (const r of results) {
                length += String(r).length + 2;
                if (length > 950) break;
                shown++;
            }
            rolls = `${results.slice(0, shown).join(', ')} …ほか ${results.length - shown} 個`;
        }

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(`${count}d${sides}`)
            .addFields(
                { name: '結果', value: rolls, inline: true },
                { name: '合計', value: total.toString(), inline: true }
            );

        await interaction.reply({ embeds: [embed] });
    }
};
