const { Events } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const Emojis = [
    '1549375294614540409',
    '1557748837194403972',
    '1557748839035838626',
    '1557409093059219457',
    '1557407745676943392',
    '1557409243311644846',
    '1557407749556408381',
    '1557407765704478900',
    '1557407751259291698',
    '1557407738919919666',
    '1557407767600570418',
    '1557407760986017853',
    '1557407743931842610',
    '1557407787221516289',
    '1557407747627294761',
    'a:rolling_uyuyu:1529182253207392267'
];

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        // ボットのメッセージおよびDM（サーバー外）は無視
        if (message.author.bot || !message.guild) return;

        // 1. 設定ファイル（config-channels.json）から無効化チャンネルリストを読み込み
        const configPath = path.join(__dirname, '..', 'config-channels.json');

        if (fs.existsSync(configPath)) {
            try {
                const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                // 自サーバーの disableAutoReact 配列を取得
                const disabledChannels = configData[message.guild.id]?.disableAutoReact || [];

                // コマンドが実行されたチャンネルが無効化リストに含まれていれば処理終了
                if (disabledChannels.includes(message.channel.id)) {
                    return;
                }
            } catch (error) {
                console.error('設定ファイルの読み込みエラー:', error);
            }
        }

        // 2. 絵文字ランダム選出とリアクション処理
        if (message.content.includes('うゆゆ') || message.content.includes('uyuyu') || message.content.includes('myumyumyu') || message.content.includes('suyarunn') || message.content.includes('ウユユ')) {
            const rand = Math.floor(Math.random() * Emojis.length);
            await message.react(Emojis[rand]);
        }
    }
};