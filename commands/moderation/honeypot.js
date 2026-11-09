const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
    MessageFlags,
    InteractionContextType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
} = require('discord.js');
const { updateChannelConfig, ensureGuildConfig } = require('../../channel-config.js');

// 処罰の種類（キー: 内部名, 値: 表示名）
const PUNISHMENT_LABELS = {
    kick: 'キック',
    ban: 'BAN',
    timeout: 'タイムアウト',
};

const settingsvalues = [
    { name: 'チャンネル', value: 'ハニーポットとして設定するチャンネル(規定：コマンド実行チャンネル)' },
    { name: '処罰', value: '引っかかったユーザーの処遇(規定：キック)' },
    { name: '自動削除', value: '引っかかったメッセージを自動で削除するかどうか(規定：有効)' },
    { name: 'ログチャンネル', value: '引っかかったユーザーの情報を送信するチャンネル(規定：未設定)' },
];

// サーバーごとの初期設定
function createDefaults(channelId) {
    return {
        punishment: 'kick',        // デフォルトの処罰はキック
        autoDelete: true,          // デフォルトで自動削除を有効にする
        logChannel: null,          // デフォルトではログチャンネルは未設定
        honeypotChannel: channelId // デフォルトではコマンドを実行したチャンネル
    };
}

const formatChannel = (id) => (id ? `<#${id}>` : '未設定');

function buildEmbed(settings, finished = false) {
    const current = [
        formatChannel(settings.honeypotChannel),
        PUNISHMENT_LABELS[settings.punishment],
        settings.autoDelete ? '有効' : '無効',
        formatChannel(settings.logChannel),
    ];

    return new EmbedBuilder()
        .setTitle(finished ? '🍯 ハニーポットの設定が完了しました' : '🍯 ハニーポット設定')
        .setDescription(
            finished
                ? '以下の内容で保存しました。'
                : 'ドロップダウンとボタンで設定を変更し、最後に「設定完了」を押してください。'
        )
        .addFields(
            settingsvalues.map((s, i) => ({
                name: s.name,
                value: `**${current[i]}**\n${s.value}`,
            }))
        )
        .setColor(finished ? 0x57f287 : 0xf1c40f);
}

function buildComponents(settings, disabled = false) {
    // ① ハニーポットチャンネル（ドロップダウン）
    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('honeypot:channel')
        .setPlaceholder('ハニーポットにするチャンネルを選択')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(disabled);
    if (settings.honeypotChannel) channelSelect.setDefaultChannels(settings.honeypotChannel);

    // ② ログチャンネル（ドロップダウン / 選択解除で未設定に戻せる）
    const logSelect = new ChannelSelectMenuBuilder()
        .setCustomId('honeypot:logchannel')
        .setPlaceholder('ログチャンネルを選択（任意）')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(0)
        .setMaxValues(1)
        .setDisabled(disabled);
    if (settings.logChannel) logSelect.setDefaultChannels(settings.logChannel);

    // ③ 処罰（ボタン）
    const punishRow = new ActionRowBuilder().addComponents(
        Object.entries(PUNISHMENT_LABELS).map(([key, label]) =>
            new ButtonBuilder()
                .setCustomId(`honeypot:punishment:${key}`)
                .setLabel(`処罰: ${label}`)
                .setStyle(settings.punishment === key ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(disabled)
        )
    );

    // ④ 自動削除（トグルボタン）と完了ボタン
    const toggleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('honeypot:autodelete')
            .setLabel(`自動削除: ${settings.autoDelete ? '有効' : '無効'}`)
            .setStyle(settings.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('honeypot:create:honeypot')
            .setLabel('#honeypot を新規作成')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('honeypot:create:log')
            .setLabel('#honeypot-log を新規作成')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('honeypot:done')
            .setLabel('設定完了')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
    );

    return [
        new ActionRowBuilder().addComponents(channelSelect),
        new ActionRowBuilder().addComponents(logSelect),
        punishRow,
        toggleRow,
    ];
}

// チャンネルを新規作成する（isLog=true なら honeypot-log、false なら honeypot）
async function createChannel(interaction, isLog) {
    const guild = interaction.guild;
    const parent = interaction.channel?.parent?.type === ChannelType.GuildCategory
        ? interaction.channel.parentId
        : null; // 実行チャンネルと同じカテゴリに作成

    const options = {
        name: isLog ? 'honeypot-log' : 'honeypot',
        type: ChannelType.GuildText,
        parent,
        reason: `ハニーポット設定: ${interaction.user.tag} が作成`,
    };

    // ログチャンネルは一般メンバーから見えないようにする
    if (isLog) {
        options.permissionOverwrites = [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            {
                id: interaction.client.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks,
                ],
            },
            {
                id: interaction.user.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            },
        ];
    }

    return await guild.channels.create(options);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('honeypot')
        .setDescription('ハニーポットのセットアップ、設定を行います')
        .setContexts(InteractionContextType.Guild) // サーバー内だけ
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const guildId = interaction.guildId;
        const client = interaction.client;
        client.honeypotCache ??= new Map(); // イベント側と共有するキャッシュ

        // 既存設定の読み込み（なければ初期化）
        let settings;
        let latestData;
        let dirty = false;
        try {
            latestData = updateChannelConfig(data => {
                const guildConfig = ensureGuildConfig(data, guildId);
                if (!guildConfig.honeypot) {
                    guildConfig.honeypot = createDefaults(interaction.channelId);
                    dirty = true;
                }
                settings = { ...guildConfig.honeypot };
            });
        } catch (error) {
            console.error('JSON読み込みエラー:', error);
            return await interaction.reply({
                content: '設定の読み込み中にエラーが発生しました。',
                flags: MessageFlags.Ephemeral,
            });
        }
        client.honeypotCache.set(guildId, settings);

        // 設定画面を表示
        await interaction.reply({
            embeds: [buildEmbed(settings)],
            components: buildComponents(settings),
            flags: MessageFlags.Ephemeral,
        });
        const replyMessage = await interaction.fetchReply();

        // 変更を保存する（JSONへ書き込み。GitHubへのコミットは設定終了時にまとめて行う）
        const save = (patch) => {
            let saved;
            latestData = updateChannelConfig(data => {
                const guildConfig = ensureGuildConfig(data, guildId);
                guildConfig.honeypot = { ...guildConfig.honeypot, ...patch };
                saved = { ...guildConfig.honeypot };
            });
            settings = saved;
            dirty = true;
            client.honeypotCache.set(guildId, settings);
        };

        const collector = replyMessage.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 5 * 60 * 1000, // 5分で操作終了
        });

        collector.on('collect', async i => {
            try {
                if (i.customId === 'honeypot:done') {
                    await i.update({
                        embeds: [buildEmbed(settings, true)],
                        components: buildComponents(settings, true),
                    });
                    collector.stop('done');
                    return;
                }

                if (i.customId === 'honeypot:create:honeypot' || i.customId === 'honeypot:create:log') {
                    await i.deferUpdate();
                    const isLog = i.customId === 'honeypot:create:log';
                    const created = await createChannel(interaction, isLog);
                    save(isLog ? { logChannel: created.id } : { honeypotChannel: created.id });
                    await i.editReply({
                        embeds: [buildEmbed(settings)],
                        components: buildComponents(settings),
                    });
                    return;
                }

                if (i.customId === 'honeypot:channel') {
                    save({ honeypotChannel: i.values[0] });
                } else if (i.customId === 'honeypot:logchannel') {
                    save({ logChannel: i.values[0] ?? null });
                } else if (i.customId.startsWith('honeypot:punishment:')) {
                    const punishment = i.customId.split(':')[2];
                    if (!PUNISHMENT_LABELS[punishment]) return;
                    save({ punishment });
                } else if (i.customId === 'honeypot:autodelete') {
                    save({ autoDelete: !settings.autoDelete });
                } else {
                    return;
                }

                await i.update({
                    embeds: [buildEmbed(settings)],
                    components: buildComponents(settings),
                });
            } catch (error) {
                console.error('ハニーポット設定エラー:', error);
                const payload = {
                    content: '設定の保存またはチャンネル作成中にエラーが発生しました。BOTに「チャンネルの管理」権限があるか確認してください。',
                    flags: MessageFlags.Ephemeral,
                };
                await (i.deferred || i.replied ? i.followUp(payload) : i.reply(payload)).catch(() => {});
            }
        });

        collector.on('end', async (_collected, reason) => {
            // 時間切れの場合は操作を無効化
            if (reason !== 'done') {
                await interaction.editReply({
                    embeds: [buildEmbed(settings)],
                    components: buildComponents(settings, true),
                }).catch(() => {});
            }

            // GitHub APIを使ってリポジトリへ自動コミット
            if (dirty && client.commitJsonToGitHub) {
                try {
                    await client.commitJsonToGitHub(
                        'config-channels.json',
                        latestData,
                        `auto: update honeypot settings in guild ${guildId} [skip render]`
                    );
                } catch (error) {
                    console.error('GitHubコミットエラー:', error);
                }
            }

            // 完了時はハニーポットチャンネルに注意書きを投稿
            if (reason === 'done' && settings.honeypotChannel) {
                const channel = await interaction.guild.channels.fetch(settings.honeypotChannel).catch(() => null);
                if (channel?.isTextBased()) {
                    await channel.send({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle('⚠️ ここはハニーポットチャンネルです')
                                .setDescription('このチャンネルに投稿しないでください。投稿すると処罰の対象になります。')
                                .setColor(0xed4245),
                        ],
                    }).catch(() => {});
                }
            }
        });
    },
};