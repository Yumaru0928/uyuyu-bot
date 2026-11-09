const { Events, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { updateChannelConfig, ensureGuildConfig } = require('../channel-config.js'); // ※配置場所に合わせてパスを調整

const PUNISHMENT_LABELS = {
    kick: 'キック',
    ban: 'BAN',
    timeout: 'タイムアウト',
};
const TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // タイムアウト最大期間（28日）

// 設定の取得（/honeypot コマンドと共有している client.honeypotCache を利用）
function getSettings(client, guildId) {
    client.honeypotCache ??= new Map();
    if (!client.honeypotCache.has(guildId)) {
        let settings = null;
        updateChannelConfig(data => {
            const guildConfig = ensureGuildConfig(data, guildId);
            settings = guildConfig.honeypot ? { ...guildConfig.honeypot } : null;
        });
        client.honeypotCache.set(guildId, settings);
    }
    return client.honeypotCache.get(guildId);
}

// 処罰の実行。結果の文字列を返す
async function punish(member, settings, reason) {
    try {
        switch (settings.punishment) {
            case 'ban':
                if (!member.bannable) return '失敗（BOTの権限が不足しています）';
                await member.ban({
                    reason,
                    deleteMessageSeconds: settings.autoDelete ? 60 * 60 : 0, // 直近1時間分を削除
                });
                return '成功';
            case 'timeout':
                if (!member.moderatable) return '失敗（BOTの権限が不足しています）';
                await member.timeout(TIMEOUT_MS, reason);
                return '成功';
            case 'kick':
            default:
                if (!member.kickable) return '失敗（BOTの権限が不足しています）';
                await member.kick(reason);
                return '成功';
        }
    } catch (error) {
        console.error('ハニーポット処罰エラー:', error);
        return `失敗（${error.message}）`;
    }
}

module.exports = {
    name: Events.MessageCreate,

    async execute(message) {
        // BOT・DMは無視
        if (message.author.bot || !message.inGuild()) return;

        const settings = getSettings(message.client, message.guildId);
        if (!settings || message.channelId !== settings.honeypotChannel) return;

        const member = message.member
            ?? await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!member) return;

        // 管理者・チャンネル管理権限を持つ人は対象外（設定ミスの事故防止）
        if (
            member.permissions.has(PermissionFlagsBits.Administrator) ||
            member.permissions.has(PermissionFlagsBits.ManageChannels)
        ) return;

        const content = message.content || '（本文なし / 添付ファイルのみ）';
        const reason = '[ハニーポット] ハニーポットチャンネルへの投稿';

        // メッセージの自動削除
        let deleted = false;
        if (settings.autoDelete) {
            deleted = await message.delete().then(() => true).catch(() => false);
        }

        // 処罰
        const result = await punish(member, settings, reason);

        // ログ送信
        if (settings.logChannel) {
            const logChannel = await message.guild.channels.fetch(settings.logChannel).catch(() => null);
            if (logChannel?.isTextBased()) {
                const embed = new EmbedBuilder()
                    .setTitle('🍯 ハニーポットに引っかかりました')
                    .setColor(0xed4245)
                    .setThumbnail(message.author.displayAvatarURL())
                    .addFields(
                        { name: 'ユーザー', value: `${message.author} (${message.author.tag})\nID: ${message.author.id}` },
                        { name: 'チャンネル', value: `<#${message.channelId}>`, inline: true },
                        { name: '処罰', value: `${PUNISHMENT_LABELS[settings.punishment]}：${result}`, inline: true },
                        { name: 'メッセージ削除', value: settings.autoDelete ? (deleted ? '成功' : '失敗') : '無効', inline: true },
                        { name: '投稿内容', value: content.slice(0, 1000) },
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] }).catch(err =>
                    console.error('ハニーポットログ送信エラー:', err)
                );
            }
        }
    },
};