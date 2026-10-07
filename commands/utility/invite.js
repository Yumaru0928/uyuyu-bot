const {SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder} = require('discord.js');

const invitelink = 'https://discord.com/oauth2/authorize?client_id=1556620719494930562&permissions=8&integration_type=0&scope=bot'

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Botをサーバーに招待するためのリンクを表示します。'),
    async execute(interaction) {
        const inviteButton = new ButtonBuilder()
            .setLabel('Botを招待する')
            .setURL(invitelink)
            .setStyle(ButtonStyle.Link);

        const row = new ActionRowBuilder().addComponents(inviteButton);

        await interaction.reply({ components: [row] });
    }
};