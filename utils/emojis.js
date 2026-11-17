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
    { name: 'uyuyu_rainbow', id: '1572104398946050088' },
    { name: 'uyuyu_golden', id: '1572106477492109372' },
    { name: 'uyuyun', id: '1558816474267910154' }
];

// リアクション専用（ガチャ・スロットには入っていない）
const ROLLING_UYUYU = { name: 'rolling_uyuyu', id: '1529182253207392267' };

// ガチャの季節限定枠（リアクション・スロットには入っていない）
const SANTA_UYUYU = { name: 'uyuyu_santa', id: '1572097202354917488' };
const NEWYEAR_UYUYU = { name: 'uyuyu_newyear', id: '1572113293647151155' };

// スロット専用の絵文字
const SLOT_TRANSPARENT = '<a:transparent:1558522934438658119>'; // 透明（アニメーション）
const SLOT_EXTRA = '<:emoji_15:1557023770919698573>';

// メッセージ本文に書く形式（<:名前:ID>）
const asText = emoji => `<:${emoji.name}:${emoji.id}>`;

// ============================================================
// ガチャ図鑑システム用の定義（抽選ロジックは utils/gacha.js、記録は utils/gacha-collection.js）
// ============================================================

const byName = name => UYUYU_EMOJIS.find(e => e.name === name);

// 通常プール（レアリティ付き）。SSR の uyuyun は常設、SR/R/N は週替わりで一部が「お休み」になる
const GACHA_POOL = [
    { ...byName('uyuyun'), rarity: 'SSR' },
    { ...byName('uyuyu_golden'), rarity: 'SSR' },
    { ...byName('uyuyu_gliched'), rarity: 'SR' },
    { ...byName('uyuyu_space'), rarity: 'SR' },
    { ...byName('uyuyu_null'), rarity: 'SR' },
    { ...byName('uyuyu_rainbow'), rarity: 'SR' },
    { ...byName('uyuyu_makeup'), rarity: 'R' },
    { ...byName('uyuyu_dango'), rarity: 'R' },
    { ...byName('uyuyu_WT'), rarity: 'R' },
    { ...byName('myumyumyu'), rarity: 'R' },
    { ...byName('uyuyu'), rarity: 'N' },
    { ...byName('uyuyu_crying'), rarity: 'N' },
    { ...byName('uyuyu_crashed'), rarity: 'N' },
    { ...byName('uyuyu_sweating'), rarity: 'N' },
    { ...byName('uyuyu_uhe'), rarity: 'N' },
    { ...byName('uyuyu_fucking'), rarity: 'N' },
];

// 条件ドロップ（隠し枠）。通常プールには入らない。
//  condition: 'win'      … 対戦ゲームでその日に勝利した人のプールにだけ混ざる
//             'night'    … 深夜帯（JST 0時〜5時）に引いたときだけプールに混ざる
//             'reaction' … ガチャからは出ない。自動リアクションの変化でのみ入手（events/send-uyuyu.js）
const GACHA_CONDITIONALS = [
    { ...byName('uyuyu_take'), rarity: 'SP', condition: 'win', hint: '勝負に勝った日のガチャに、たまに混ざっているらしい' },
    { ...byName('uyuyu_sleeping'), rarity: 'SP', condition: 'night', hint: '夜更かしなうゆゆ。みんなが寝静まった頃にだけ姿を見せる' },
    { ...ROLLING_UYUYU, rarity: 'SP', condition: 'reaction', hint: '転がり続けるうゆゆ。どこかで出会える…かも' },
    { ...SANTA_UYUYU, rarity: 'SP', condition: 'december', hint: 'サンタなうゆゆ。12月にだけ姿を見せる' },
    { ...NEWYEAR_UYUYU, rarity: 'SP', condition: 'newyear', hint: 'お正月なうゆゆ。年末年始にだけ姿を見せる' },
];

// 図鑑に並べる全種（通常プール＋条件枠 = 17種）
const GACHA_ALL = [...GACHA_POOL, ...GACHA_CONDITIONALS];

module.exports = { UYUYU_EMOJIS, ROLLING_UYUYU, SANTA_UYUYU, NEWYEAR_UYUYU, SLOT_TRANSPARENT, SLOT_EXTRA, asText, GACHA_POOL, GACHA_CONDITIONALS, GACHA_ALL };
