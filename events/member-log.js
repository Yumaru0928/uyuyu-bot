const { Events, EmbedBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

// 共通のログ送信先取得関数
function getLogChannel(guild) {
    const configPath = path.join(__dirname, '..', 'config-channels.json');
    if (!fs.existsSync(configPath)) return null;

    try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        // チャンネル設定のキー名（例: memberLogChannel または共通のログ用キー）
        const logChannelId = configData[guild.id]?.memberLogChannel;
        if (!logChannelId) return null;

        return guild.channels.cache.get(logChannelId);
    } catch (e) {
        console.error('設定ファイルの読み込みエラー:', e);
        return null;
    }
}

module.exports = [
    // 1. メンバー参加時 (GuildMemberAdd)
    {
        name: Events.GuildMemberAdd,
        async execute(member) {
            const guild = member.guild;
            const logChannel = getLogChannel(guild);
            if (!logChannel) return;

            const user = member.user;
            const avatar = user.displayAvatarURL({ dynamic: true });
            const createdAt = Math.floor(user.createdTimestamp / 1000);

            const embed = new EmbedBuilder()
                .setTitle('📥 メンバーが参加しました')
                .setColor(0x00FF00) // 緑
                .setThumbnail(avatar)
                .addFields(
                    { name: 'ユーザー', value: `${user.tag} (<@${user.id}>)`, inline: false },
                    { name: 'アカウント作成日', value: `<t:${createdAt}:F> (<t:${createdAt}:R>)`, inline: false },
                    { name: '現在のサーバーメンバー数', value: `${guild.memberCount}人`, inline: true }
                )
                .setTimestamp();

            try {
                await logChannel.send({ embeds: [embed] });
            } catch (error) {
                console.error('入室ログの送信に失敗しました:', error);
            }
        }
    },

    // 2. メンバー退出時 (GuildMemberRemove)
    {
        name: Events.GuildMemberRemove,
        async execute(member) {
            const guild = member.guild;
            const logChannel = getLogChannel(guild);
            if (!logChannel) return;

            const user = member.user;
            const avatar = user.displayAvatarURL({ dynamic: true });
            // サーバーに参加していた期間（joinedTimestampが取得できる場合）
            const joinedAt = member.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;

            const embed = new EmbedBuilder()
                .setTitle('📤 メンバーが退出しました')
                .setColor(0xFF0000) // 赤
                .setThumbnail(avatar)
                .addFields(
                    { name: 'ユーザー', value: `${user.tag} (<@${user.id}>)`, inline: false },
                    { name: '参加期間 / 参加日', value: joinedAt ? `<t:${joinedAt}:F> (<t:${joinedAt}:R> 参加)` : '不明', inline: false },
                    { name: '現在のサーバーメンバー数', value: `${guild.memberCount}人`, inline: true }
                )
                .setTimestamp();

            try {
                await logChannel.send({ embeds: [embed] });
            } catch (error) {
                console.error('退出ログの送信に失敗しました:', error);
            }
        }
    }
];