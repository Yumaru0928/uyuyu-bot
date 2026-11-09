const { Events, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { updateChannelConfig, ensureGuildConfig } = require('../channel-config.js'); // ※配置場所に合わせてパスを調整

const PUNISHMENT_LABELS = {
    kick: 'キック',
    ban: 'BAN',
    timeout: 'タイムアウト',
};
const TIMEOUT_MS = 1 * 24 * 60 * 60 * 1000; // タイムアウト最大期間（1日）

// 処罰ごとの「さかのぼって削除する範囲」
const PURGE_WINDOWS = {
    kick: 24 * 60 * 60 * 1000,    // 24時間
    ban: 24 * 60 * 60 * 1000,     // 24時間
    timeout: 120 * 60 * 1000,     // 120分
};
const PURGE_LABELS = { kick: '24時間', ban: '24時間', timeout: '120分' };
const PURGE_MAX_PAGES = 10; // 1チャンネルあたり最大 100件 × 10ページ まで検索

const DEBUG = true;             // 動作確認が済んだら false にする
const EXEMPT_PRIVILEGED = true; // テスト中は false にすると管理者も処罰対象になる（※オーナーはキック/BAN不可）

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
                    // 自動削除が有効なら直近24時間分を削除（Discord側が全チャンネルから削除）
                    deleteMessageSeconds: settings.autoDelete ? PURGE_WINDOWS.ban / 1000 : 0,
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

// サーバー内の全テキストチャンネルから、指定ユーザーの直近メッセージを削除する。削除件数を返す
async function purgeRecentMessages(guild, userId, windowMs) {
    const cutoff = Date.now() - windowMs;
    const me = guild.members.me;
    const needed = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
    ];

    const channels = guild.channels.cache.filter(c =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
        c.permissionsFor(me)?.has(needed)
    );

    let total = 0;
    await Promise.all(channels.map(async channel => {
        try {
            let before;
            for (let page = 0; page < PURGE_MAX_PAGES; page++) {
                const batch = await channel.messages.fetch({ limit: 100, before });
                if (batch.size === 0) break;

                const targets = batch.filter(m => m.author.id === userId && m.createdTimestamp >= cutoff);
                if (targets.size === 1) {
                    await targets.first().delete();
                } else if (targets.size > 1) {
                    await channel.bulkDelete(targets, true); // 14日以内のみ一括削除
                }
                total += targets.size;

                const oldest = batch.last();
                if (oldest.createdTimestamp < cutoff) break; // 範囲より古くなったら終了
                before = oldest.id;
            }
        } catch (error) {
            console.error(`[honeypot] #${channel.name} のメッセージ削除に失敗:`, error.message);
        }
    }));
    return total;
}

module.exports = {
    name: Events.MessageCreate,

    async execute(message) {
        // BOT・DMは無視
        if (message.author.bot || !message.inGuild()) return;

        if (DEBUG) console.log(`[honeypot] messageCreate 受信: ch=${message.channelId} user=${message.author.tag}`);

        const settings = getSettings(message.client, message.guildId);
        if (!settings) {
            if (DEBUG) console.log('[honeypot] このサーバーの設定が見つかりません（/honeypot を実行してください）');
            return;
        }
        if (message.channelId !== settings.honeypotChannel) {
            if (DEBUG) console.log(`[honeypot] ハニーポット以外のチャンネルなので無視（設定: ${settings.honeypotChannel}）`);
            return;
        }

        const member = message.member
            ?? await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!member) {
            if (DEBUG) console.log('[honeypot] メンバーを取得できませんでした');
            return;
        }

        // 管理者・チャンネル管理権限を持つ人は対象外（設定ミスの事故防止）
        if (
            EXEMPT_PRIVILEGED &&
            (member.permissions.has(PermissionFlagsBits.Administrator) ||
                member.permissions.has(PermissionFlagsBits.ManageChannels))
        ) {
            if (DEBUG) console.log('[honeypot] 管理者/チャンネル管理権限を持つため対象外');
            return;
        }

        const content = message.content || '（本文なし / 添付ファイルのみ）';
        const reason = '[ハニーポット] ハニーポットチャンネルへの投稿';

        // メッセージの自動削除
        let deleted = false;
        if (settings.autoDelete) {
            deleted = await message.delete().then(() => true).catch(() => false);
        }

        // 処罰
        const result = await punish(member, settings, reason);

        // 直近のメッセージを他チャンネルも含めて削除
        // （BANは処罰時にDiscord側で削除済み。BANに失敗した場合は手動で削除する）
        let purged = null;
        const banHandledIt = settings.punishment === 'ban' && result === '成功';
        if (settings.autoDelete && !banHandledIt) {
            const windowMs = PURGE_WINDOWS[settings.punishment] ?? PURGE_WINDOWS.kick;
            purged = await purgeRecentMessages(message.guild, message.author.id, windowMs);
        }

        const label = PURGE_LABELS[settings.punishment] ?? PURGE_LABELS.kick;
        let deleteSummary = '無効';
        if (settings.autoDelete) {
            deleteSummary = `投稿: ${deleted ? '削除成功' : '削除失敗'}\n直近${label}: ` +
                (banHandledIt ? 'BANにより削除' : `${purged}件削除`);
        }

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
                        { name: 'メッセージ削除', value: deleteSummary, inline: true },
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