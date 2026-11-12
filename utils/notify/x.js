// utils/notify/x.js
// X (Twitter) は、無料で使えるプッシュ型の webhook がありません（Account Activity API は有料）。
// 取得方法が決まったら、ここに youtube.js / twitch.js と同じ形で実装してください:
//   enabled()           … 使える状態なら true（false の間は、ダッシュボードで「準備中」と表示される）
//   resolve(input)      … 入力から { targetId, targetName } を作る
//   subscribe/unsubscribe(targetId) … 購読の開始・解除（ポーリングなら「監視対象に追加・削除」）
//   resync(wantedSet)   … 起動時・12時間ごとに呼ばれる
// 通知を出すときは utils/notify/index.js の dispatch('x', targetId, { id, text }) を呼ぶだけです。
const { NotifyError } = require('./common.js');

module.exports = {
    enabled: () => false,
    resolve: async () => { throw new NotifyError('X (Twitter) の通知はまだ利用できません。'); },
    subscribe: async () => {},
    unsubscribe: async () => {},
    resync: async () => {},
};
