const { SlashCommandBuilder,
    EmbedBuilder,
} = require('discord.js');
module.exports = {
    data: new SlashCommandBuilder()
        .setName('dice')
        .setDescription('サイコロを振ります。')
        .addStringOption(option =>
            option.setName('dices')
                .setDescription('振るサイコロの種類を指定します。例: 1d6, 2d10, 3d20')
                .setRequired(true)
        ),
    async execute(interaction) {
        const dices = interaction.options.getString('dices');
        const dicemultiple = dices.split('d')[0];
        const dicetype = dices.split('d')[1];
        const dicePattern = /^(\d+)d(\d+)$/;
        const match = dices.match(dicePattern);
        let results = [];
        let total = 0;
        for (let i = 0; i < dicemultiple; i++) {
            if (!match) {
                await interaction.reply('正しい形式でサイコロを指定してください。例: 1d6, 2d10, 3d20');
                return;
            }
            const sides = parseInt(match[2]);
            const roll = Math.floor(Math.random() * sides) + 1;
            results.push(roll);
            total += roll;
        }
        
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(dices)
            .addFields(
                { name: '結果', value: results.join(', '), inline: true },
                { name: '合計', value: total.toString(), inline: true }
            );

        await interaction.reply({ embeds: [embed] });
    }
};