const { SlashCommandBuilder, EmbedBuilder, version: djsVersion } = require('discord.js');
const process = require('node:process');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Botの詳細情報を表示します。'),
    async execute(interaction) {
        const client = interaction.client;

        // 稼働時間（Uptime）の計算
        const uptime = process.uptime();
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        const uptimeString = `${days}日 ${hours}時間 ${minutes}分 ${seconds}秒`;

        // 参加サーバー数・総ユーザー数の取得
        const guildCount = client.guilds.cache.size;
        const userCount = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);

        // Ping値（レイテンシ）
        const wsPing = client.ws.ping;

        // Embedメッセージの構築
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`🤖 ${client.user.username} の基本情報`)
            .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
                { name: '👑 Bot名', value: `${client.user.tag}`, inline: true },
                { name: '🆔 Bot ID', value: `${client.user.id}`, inline: true },
                { name: '🏓 WebSocket Ping', value: `${wsPing} ms`, inline: true },
                { name: '📊 参加サーバー数', value: `${guildCount} サーバー`, inline: true },
                { name: '👥 総ユーザー数', value: `${userCount} 人`, inline: true },
                { name: '⏱️ 稼働時間', value: `${uptimeString}`, inline: false },
                { name: '⚙️ 開発環境', value: `Node.js: \`${process.version}\`\ndiscord.js: \`v${djsVersion}\``, inline: true }
            )
            .setTimestamp()
            .setFooter({
                text: `Requested by ${interaction.user.tag}`,
                iconURL: interaction.user.displayAvatarURL()
            });

        await interaction.reply({ embeds: [embed] });
    },
};