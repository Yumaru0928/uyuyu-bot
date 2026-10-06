const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('利用可能なコマンドの一覧を表示します'),
    async execute(interaction) {
        // client.commands に登録されている全コマンドを取得
        const commands = interaction.client.commands;

        // コマンド一覧のフィールドを作成
        const commandFields = commands.map(cmd => {
            return {
                name: `/${cmd.data.name}`,
                value: cmd.data.description || '説明なし',
                inline: false, // 縦に並べる場合
            };
        });

        // Embed メッセージの作成
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0099FF) // メインカラー
            .setTitle('📖 コマンド一覧・ヘルプ')
            .setDescription('利用できるスラッシュコマンドの一覧です。')
            .addFields(commandFields)
            .setTimestamp()
            .setFooter({ 
                text: `${interaction.client.user.username} Help System`, 
                iconURL: interaction.client.user.displayAvatarURL() 
            });

        // 自分にだけ見える非公開メッセージ（Ephemeral）で送信したい場合は flags: 64 を指定
        await interaction.reply({ embeds: [helpEmbed] });
    },
};