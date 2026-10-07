const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('avatar')
        .setDescription('指定したユーザーのアバターを表示します')
        .addStringOption(option =>
            option.setName('target')
                .setDescription('ユーザーのメンション、またはユーザーIDを入力')
        ),
    async execute(interaction) {
        const input = interaction.options.getString('target');
        let user;

        if (!input) {
            // 未指定なら実行者本人
            user = interaction.user;
        } else {
            // メンション形式 <@1234567890> から数字IDだけを抽出
            const idMatch = input.match(/\d+/);
            const userId = idMatch ? idMatch[0] : input;

            try {
                // APIにリクエストしてIDからユーザー情報をフェッチ（サーバー外のユーザーも取得可能）
                user = await interaction.client.users.fetch(userId);
            } catch (error) {
                return await interaction.reply({
                    content: '指定されたIDのユーザーが見つかりませんでした。正しいIDを入力してください。',
                    ephemeral: true
                });
            }
        }

        const avatarUrl = user.displayAvatarURL({ size: 1024 });

        const avatarEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`${user.tag} のアバター`)
            .setImage(avatarUrl)
            .setTimestamp();

        await interaction.reply({ embeds: [avatarEmbed] });
    }
};