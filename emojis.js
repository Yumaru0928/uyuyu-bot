// emojis.js
// うゆゆ絵文字のIDを1か所にまとめたもの。
// リアクション（events/send-uyuyu.js）、ガチャ（commands/games/uyuyu-gacha.js）、
// スロット（commands/games/slot.js）が、ここから必要な分を取り出して使う。
// 絵文字を追加・変更するときは、このファイルだけ直せばよい。

// 通常のうゆゆ絵文字（uyuyu_1 〜 uyuyu_15 と uyuyun）
const UYUYU_EMOJIS = [
    { name: 'uyuyu_1', id: '1549375294614540409' },
    { name: 'uyuyu_2', id: '1557748837194403972' },
    { name: 'uyuyu_3', id: '1557748839035838626' },
    { name: 'uyuyu_4', id: '1557409093059219457' },
    { name: 'uyuyu_5', id: '1557407745676943392' },
    { name: 'uyuyu_6', id: '1557409243311644846' },
    { name: 'uyuyu_7', id: '1557407749556408381' },
    { name: 'uyuyu_8', id: '1557407765704478900' },
    { name: 'uyuyu_9', id: '1557407751259291698' },
    { name: 'uyuyu_10', id: '1557407738919919666' },
    { name: 'uyuyu_11', id: '1557407767600570418' },
    { name: 'uyuyu_12', id: '1557407760986017853' },
    { name: 'uyuyu_13', id: '1557407743931842610' },
    { name: 'uyuyu_14', id: '1557407787221516289' },
    { name: 'uyuyu_15', id: '1557407747627294761' },
    { name: 'uyuyun', id: '1558816474267910154' }
];

// リアクション専用（ガチャ・スロットには入っていない）
const ROLLING_UYUYU = { name: 'rolling_uyuyu', id: '1529182253207392267' };

// スロット専用の絵文字
const SLOT_TRANSPARENT = '<a:transparent:1558522934438658119>'; // 透明（アニメーション）
const SLOT_EXTRA = '<:emoji_15:1557023770919698573>';

// メッセージ本文に書く形式（<:名前:ID>）
const asText = emoji => `<:${emoji.name}:${emoji.id}>`;

module.exports = { UYUYU_EMOJIS, ROLLING_UYUYU, SLOT_TRANSPARENT, SLOT_EXTRA, asText };
