// emojis.js
// うゆゆ絵文字のIDを1か所にまとめたもの。
// リアクション（events/send-uyuyu.js）、ガチャ（commands/games/uyuyu-gacha.js）、
// スロット（commands/games/slot.js）が、ここから必要な分を取り出して使う。
// 絵文字を追加・変更するときは、このファイルだけ直せばよい。

// 通常のうゆゆ絵文字（uyuyu_1 〜 uyuyu_15 と uyuyun）
const UYUYU_EMOJIS = [
    { name: 'uyuyu', id: '1549375294614540409' },
    { name: 'uyuyu_crying', id: '1557748837194403972' },
    { name: 'myumyumyu', id: '1557748839035838626' },
    { name: 'uyuyu_sleeping', id: '1557409093059219457' },
    { name: 'uyuyu_crashed', id: '1557407745676943392' },
    { name: 'uyuyu_makeup', id: '1557409243311644846' },
    { name: 'uyuyu_dango', id: '1557407749556408381' },
    { name: 'uyuyu_fucking', id: '1557407765704478900' },
    { name: 'uyuyu_null', id: '1557407751259291698' },
    { name: 'uyuyu_space', id: '1557407738919919666' },
    { name: 'uyuyu_sweating', id: '1557407767600570418' },
    { name: 'uyuyu_uhe', id: '1557407760986017853' },
    { name: 'uyuyu_WT', id: '1557407743931842610' },
    { name: 'uyuyu_take', id: '1557407787221516289' },
    { name: 'uyuyu_gliched', id: '1557407747627294761' },
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
