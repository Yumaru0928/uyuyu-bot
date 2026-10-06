// events/delete-message-log.js
const fs = require('node:fs');
const path = require('node:path');
const { Events, AuditLogEvent, EmbedBuilder } = require('discord.js');

module.exports = {
    name: Events.MessageDelete,
    async execute(message) {
        // ギルド（サーバー）外での削除は無視
        if (!message.guild) return;

        // 1. 設定ファイル（config-channels.json）からログ保存先チャンネルIDを読み込み
        const configPath = path.join(__dirname, '..', 'config-channels.json'); // パス調整に注意
        if (!fs.existsSync(configPath)) return;

        let configData = {};
        try {
            configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.error('設定ファイルの読み込みエラー:', e);
            return;
        }

        // オブジェクト構造から 'deleteLogChannel' のIDを取得
        const logChannelId = configData[message.guild.id]?.deleteLogChannel;
        if (!logChannelId) return; // ログチャンネルが未設定の場合は終了

        const logChannel = message.guild.channels.cache.get(logChannelId);
        if (!logChannel) return; // チャンネルが存在しない場合は終了

        // 2. 削除メッセージの情報を抽出
        const author = message.author;
        const authorTag = author ? author.tag : '不明なユーザー (未キャッシュ)';
        const authorAvatar = author ? author.displayAvatarURL() : null;
        const content = message.content || '(本文なし / 画像・埋め込みのみ)';

        // 添付ファイル（画像やファイル）のURL一覧を取得
        const attachments = message.attachments;
        const attachmentUrls = attachments.size > 0
            ? attachments.map(att => att.url).join('\n')
            : null;

        // 削除実行者の特定（デフォルトは送信者本人）
        let executorTag = authorTag;

        try {
            const fetchedLogs = await message.guild.fetchAuditLogs({
                limit: 1,
                type: AuditLogEvent.MessageDelete,
            });

            const deletionLog = fetchedLogs.entries.first();

            if (deletionLog) {
                const { executor, target, extra, createdTimestamp } = deletionLog;

                const isRecent = Date.now() - createdTimestamp < 5000;
                const matchesChannel = extra?.channel?.id === message.channel.id;
                const matchesTarget = target?.id === message.author?.id;

                if (isRecent && matchesChannel && matchesTarget && executor) {
                    executorTag = executor.tag;
                }
            }
        } catch (error) {
            console.error('監査ログ取得エラー:', error);
        }

        // 3. ログ用 Embed メッセージの構築
        const logEmbed = new EmbedBuilder()
            .setTitle('🗑️ メッセージが削除されました')
            .setColor(0xFF0000) // 赤色
            .setThumbnail(authorAvatar) // メッセージ送信者のアイコン
            .addFields(
                { name: '送信者', value: `${authorTag} (${author ? `<@${author.id}>` : 'ID不明'})`, inline: true },
                { name: '削除実行者', value: `${executorTag}`, inline: true },
                { name: 'チャンネル', value: `<#${message.channel.id}>`, inline: true },
                { name: '削除された本文', value: content.length > 1024 ? content.substring(0, 1021) + '...' : content }
            )
            .setTimestamp(); // 削除が検知された時刻を表示

        // 添付ファイルが存在する場合はフィールドを追加し、最初の画像であれば Embed の画像エリアに表示
        if (attachmentUrls) {
            logEmbed.addFields({ name: '添付ファイル URL', value: attachmentUrls });

            const firstAttachment = attachments.first();
            if (firstAttachment && firstAttachment.contentType?.startsWith('image/')) {
                logEmbed.setImage(firstAttachment.url);
            }
        }

        // 4. 保存済みのログチャンネルへ送信
        try {
            await logChannel.send({ embeds: [logEmbed] });
        } catch (error) {
            console.error('ログチャンネルへの送信に失敗しました:', error);
        }
    },
};