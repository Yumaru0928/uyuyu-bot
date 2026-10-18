const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('avatar')
        .setDescription('指定したユーザーのアバターを表示します')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('アバターを表示するユーザー（省略すると自分）')
        ),
    async execute(interaction) {
        // 未指定なら実行者本人
        const user = interaction.options.getUser('target') || interaction.user;

        const avatarEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`${user.displayName} のアバター`)
            .setImage(user.displayAvatarURL({ size: 1024 }))
            .setTimestamp();

        await interaction.reply({ embeds: [avatarEmbed] });
    }
};
