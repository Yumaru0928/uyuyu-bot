const { Events } = require('discord.js');
const { getChannelConfig } = require('../channel-config.js');

// リアクション用：Discordが確実に認識できる '名前:ID' 形式に整理
const Emojis = [
    'uyuyu_1:1549375294614540409',
    'uyuyu_2:1557748837194403972',
    'uyuyu_3:1557748839035838626',
    'uyuyu_4:1557409093059219457',
    'uyuyu_5:1557407745676943392',
    'uyuyu_6:1557409243311644846',
    'uyuyu_7:1557407749556408381',
    'uyuyu_8:1557407765704478900',
    'uyuyu_9:1557407751259291698',
    'uyuyu_10:1557407738919919666',
    'uyuyu_11:1557407767600570418',
    'uyuyu_12:1557407760986017853',
    'uyuyu_13:1557407743931842610',
    'uyuyu_14:1557407787221516289',
    'uyuyu_15:1557407747627294761',
    'uyuyun:1558816474267910154',
    'rolling_uyuyu:1529182253207392267'
];

// 反応するキーワード
const KEYWORDS = /うゆゆ|ウユユ|uyuyu|myumyumyu|suyarunn/i;

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        // ボットのメッセージおよびDM（サーバー外）は無視
        if (message.author.bot || !message.guild) return;

        // 1. キーワードが含まれないメッセージは、設定ファイルを見るまでもなく終了（大文字小文字は区別しない）
        if (!KEYWORDS.test(message.content)) return;

        // 2. 設定ファイル（config-channels.json）から、このチャンネルが無効化されていないか確認
        const disabledChannels = getChannelConfig()[message.guild.id]?.disableAutoReact || [];
        if (disabledChannels.includes(message.channel.id)) return;

        // 3. 絵文字ランダム選出とリアクション処理
        const rand = Math.floor(Math.random() * Emojis.length);
        try {
            await message.react(Emojis[rand]);
        } catch (error) {
            console.error('リアクションの追加に失敗しました:', error);
        }
    }
};
