const { ApplicationIntegrationType, Routes } = require('discord.js');

/** ユーザーインストール経由でコマンドを使ったユーザー（再起動で消える） */
const userInstalls = new Map();

/**
 * インタラクション（コマンド実行など）から、ユーザーインストールで使っているユーザーを記録する。
 * DiscordはユーザーインストールしたユーザーのAPIでの一覧を提供していないため、
 * 「実際にコマンドを使ったユーザー」だけが分かる。
 */
function trackInteractionUser(interaction) {
    const owners = interaction.authorizingIntegrationOwners;
    if (!owners || owners[ApplicationIntegrationType.UserInstall] === undefined) return;

    const user = interaction.user;
    const prev = userInstalls.get(user.id);
    userInstalls.set(user.id, {
        id: user.id,
        name: user.globalName ?? user.username,
        username: user.username,
        uses: (prev?.uses ?? 0) + 1,
        lastSeen: Date.now(),
        lastPlace: interaction.guildId
            ? `サーバー「${interaction.guild?.name ?? interaction.guildId}」`
            : 'DM・グループDM',
    });
}

/** イベントWebhookで検知したインストール（認可）の記録（再起動で消える） */
const authorizations = [];

/** APPLICATION_AUTHORIZED の内容を記録し、通知用の文を返す */
function recordAuthorized(data) {
    const user = data.user;
    if (!user) return null;

    const kind = data.integration_type === 1 ? 'ユーザーインストール' : data.integration_type === 0 ? 'サーバーインストール' : 'OAuth2認可';
    const name = user.global_name ?? user.username;
    const guildName = data.guild?.name ?? null;

    authorizations.push({ userId: user.id, name, username: user.username, kind, guildName, at: Date.now() });
    return `📥 **${name}** (@${user.username}, \`${user.id}\`) が追加しました: ${kind}${guildName ? `「${guildName}」` : ''}`;
}

/** APPLICATION_DEAUTHORIZED の内容を記録し、通知用の文を返す */
function recordDeauthorized(data) {
    const user = data.user;
    if (!user) return null;

    for (let i = authorizations.length - 1; i >= 0; i--) {
        if (authorizations[i].userId === user.id) authorizations.splice(i, 1);
    }
    const name = user.global_name ?? user.username;
    return `📤 **${name}** (@${user.username}, \`${user.id}\`) がアプリを削除しました`;
}

/** 行単位で2000文字以内に分割 */
function splitLines(lines, limit = 1900) {
    const out = [];
    let cur = '';
    for (const line of lines) {
        if (cur.length + line.length + 1 > limit) {
            out.push(cur);
            cur = '';
        }
        cur += (cur ? '\n' : '') + line;
    }
    if (cur) out.push(cur);
    return out;
}

/** インストール状況のレポートを作る（2000文字以内に分割した配列） */
async function buildInstallReport(client) {
    const app = await client.rest.get(Routes.currentApplication()).catch(() => null);
    const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    const lines = [];
    lines.push(`**サーバーにインストール: ${guilds.length}件**`);
    for (const g of guilds) lines.push(`- ${g.name} (\`${g.id}\`) ${g.memberCount}人`);

    lines.push('');
    const userCount = app?.approximate_user_install_count;
    lines.push(
        `**ユーザーインストール: ${userCount !== undefined ? `約${userCount}人（Discord集計の概数）` : '取得できませんでした'}**`,
    );

    lines.push(`イベントで検知した追加（${authorizations.length}件・起動後のみ）:`);
    if (!authorizations.length) lines.push('- なし');
    for (const a of authorizations) {
        lines.push(
            `- ${a.name} (@${a.username}, \`${a.userId}\`) ${a.kind}${a.guildName ? `「${a.guildName}」` : ''} <t:${Math.floor(a.at / 1000)}:R>`,
        );
    }

    const users = [...userInstalls.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    lines.push(`起動後にコマンドを使ったユーザー（${users.length}人）:`);
    if (!users.length) lines.push('- なし');
    for (const u of users) {
        lines.push(
            `- ${u.name} (@${u.username}, \`${u.id}\`) ${u.uses}回 / 最終 <t:${Math.floor(u.lastSeen / 1000)}:R> / ${u.lastPlace}`,
        );
    }
    return splitLines(lines);
}

let ownerIdCache = null;

/** Botの所有者のユーザーID（チームの場合はチームのオーナー） */
async function getOwnerId(client) {
    if (!ownerIdCache) {
        const app = await client.application.fetch();
        ownerIdCache = app.owner?.ownerId ?? app.owner?.id ?? null;
    }
    return ownerIdCache;
}

/**
 * 「!installs」をBotの所有者が送ったときに、インストール状況を返信する。
 * @returns {Promise<boolean>} 処理した場合 true
 */
async function handleInstallsCommand(message) {
    if (message.content?.trim() !== '!installs') return false;

    if (message.author.id !== (await getOwnerId(message.client))) return false;

    const chunks = await buildInstallReport(message.client);
    await message.reply({ content: chunks[0], allowedMentions: { parse: [], repliedUser: false } });
    for (const c of chunks.slice(1)) {
        await message.channel.send({ content: c, allowedMentions: { parse: [] } });
    }
    return true;
}

module.exports = {
    trackInteractionUser,
    buildInstallReport,
    handleInstallsCommand,
    getOwnerId,
    recordAuthorized,
    recordDeauthorized,
};