const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('avatar')
        .setDescription('指定したユーザーのアバターを表示します')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('アバターを表示するユーザーを指定します')
        ),
    async execute(interaction) {
        const user = interaction.options.getUser('user') || interaction.user;
        const avatarUrl = user.displayAvatarURL({ dynamic: true, size: 1024 });

        const avatarEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`${user.tag} のアバター`)
            .setImage(avatarUrl)
            .setTimestamp();
        await interaction.reply({ embeds: [avatarEmbed] });
    }
}