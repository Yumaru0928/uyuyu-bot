#!/usr/bin/env node
'use strict';

// 将棋のルール実装（utils/shogi-core.js）の検証。 node dev/test-shogi-core.js [perftの深さ(既定4)]
//  ・初期局面からの合法手の数（perft）を、公開されている値と照合する
//      深さ1〜5 = 30 / 900 / 25,470 / 719,731 / 19,861,490   （深さ5は数秒かかる）
//  ・二歩、行き所のない駒、成り、王手放置、ピン、打ち歩詰め、詰み、千日手、連続王手 などの個別ルール

const assert = require('node:assert');
const c = require('../utils/shogi-core.js');
const usi = (pos) => c.legalMoves(pos).map(c.moveToUsi);
const has = (pos, m) => usi(pos).includes(m);
const lacks = (pos, m) => !usi(pos).includes(m);
const sfen = (s) => c.fromSfen(s);

// ---- perft ----
const expected = [1, 30, 900, 25470, 719731, 19861490];
const maxDepth = Math.min(5, Number(process.argv[2] || 4));
assert.strictEqual(c.toSfen(c.startPosition()), c.START_SFEN, 'SFEN の往復');
for (let d = 1; d <= maxDepth; d++) {
  const t = Date.now();
  const n = c.perft(c.startPosition(), d);
  assert.strictEqual(n, expected[d], `perft(${d})`);
  console.log(`perft(${d}) = ${n} ✔ (${Date.now() - t}ms)`);
}

// ---- 個別ルール ----

// --- 二歩 ---
let p = sfen('4k4/9/9/9/9/9/4P4/9/4K4 b P 1');
assert(!usi(p).some((m) => m.startsWith('P*5')), '5筋には歩を打てない(二歩)');
assert(has(p, 'P*4e'), '別の筋には打てる');
p = sfen('4k4/9/9/9/9/9/4+P4/9/4K4 b P 1');
assert(has(p, 'P*5e'), 'と金のある筋には歩を打てる');
p = sfen('4k4/9/9/9/9/9/4p4/9/4K4 b P 1');
assert(has(p, 'P*5e'), '相手の歩しかない筋には打てる');

// --- 行き所のない駒(先手) ---
p = sfen('4k4/9/9/9/9/9/9/9/4K4 b PLN 1');
for (const m of ['P*1a', 'L*1a', 'N*1a', 'N*1b']) assert(lacks(p, m), m + ' は反則');
for (const m of ['P*1b', 'L*1b', 'N*1c']) assert(has(p, m), m + ' は合法');
// 後手
p = sfen('4k4/9/9/9/9/9/9/9/4K4 w pln 1');
for (const m of ['P*1i', 'L*1i', 'N*1i', 'N*1h']) assert(lacks(p, m), m + ' は反則');
for (const m of ['P*1h', 'L*1h', 'N*1g']) assert(has(p, m), m + ' は合法');

// --- 成りの強制/任意 ---
p = sfen('4k4/P8/9/9/9/9/9/9/4K4 b - 1');
assert(has(p, '9b9a+') && lacks(p, '9b9a'), '1段目へ進む歩は成り必須');
p = sfen('4k4/9/P8/9/9/9/9/9/4K4 b - 1');
assert(has(p, '9c9b+') && has(p, '9c9b'), '2段目へ進む歩は成り任意');
p = sfen('4k4/9/9/N8/9/9/9/9/4K4 b - 1'); // 桂 9四 → 8二
assert(has(p, '9d8b+') && lacks(p, '9d8b'), '2段目へ進む桂は成り必須');
p = sfen('4k4/9/9/9/9/9/6B2/9/4K4 b - 1');
assert(has(p, '3g7c+') && has(p, '3g7c'), '角が敵陣に入るときは任意');
assert(lacks(p, '3g4f+') && has(p, '3g4f'), '敵陣に関係しない移動は成れない');
p = sfen('4k4/9/9/9/9/9/9/9/4K4 b - 1');
assert(c.legalMoves(p).every((m) => !m.promo), '金・玉は成れない');
// 後手の成り
p = sfen('4k4/9/9/9/9/9/9/p8/4K4 w - 1');
assert(has(p, '9h9i+') && lacks(p, '9h9i'), '後手の歩が9段目へ進むなら成り必須');

// --- 王手放置の禁止・王手回避 ---
p = sfen('9/9/9/9/9/9/9/4r4/4K4 b - 1'); // 5八に後手の飛が王手(玉は5九)
// ※ 後手玉が無い局面: king[1] = -1 でも落ちないこと
assert(c.inCheck(p));
assert(has(p, '5i5h'), '王手している飛車を取る');
for (const m of usi(p)) assert(m.startsWith('5i'), '玉の動き以外は王手放置: ' + m);
// ピン: 5九玉 / 5七金 / 5一に後手飛 → 金は5筋からそれられない
p = sfen('4r4/9/9/9/9/9/4G4/9/4K4 b - 1');
assert(lacks(p, '5g4g') && lacks(p, '5g6g'), 'ピンされた金は横に動けない');
assert(has(p, '5g5f'), 'ピンの筋に沿っては動ける');
// 合駒: 5九玉 / 5一飛(後手) / 先手の香を持っていれば 5八〜5二のどこかに打って受けられる
p = sfen('4r4/9/9/9/9/9/9/9/4K4 b L 1'); // 王手
assert(c.inCheck(p));
assert(has(p, 'L*5h') && has(p, 'L*5d'), '合駒の香打ち');
assert(lacks(p, 'L*4h'), '王手を受けない打ち方は不可');

// --- 打ち歩詰め ---
// 後手玉1一、2一に後手の桂(逃げ道をふさぐ)、先手の金が2三で2二・1二を守る
p = sfen('7nk/9/7G1/9/9/9/9/9/K8 b P 1');
assert(lacks(p, 'P*1b'), '打ち歩詰めは反則');
p = sfen('7nk/9/7G1/9/9/9/9/9/K8 b L 1');
assert(has(p, 'L*1b'), '香で詰ますのは合法');
p = sfen('7nk/9/9/9/9/9/9/9/K8 b P 1');
assert(has(p, 'P*1b'), '玉が歩を取れるなら打ち歩詰めではない');
// 歩を打って王手になるが、他の駒で歩を取れる/王手を外せるなら合法
p = sfen('6nnk/9/7G1/9/9/9/9/9/K8 b P 1'); // 桂が2つ: 1b への歩は桂では取れない → やはり詰み(反則)
assert(lacks(p, 'P*1b'));
// 歩を打つと詰みだが、相手が歩を別の駒で取れる局面は合法 (3二に後手金が利いて1二を守る形)

// --- 詰み(頭金) ---
let mate = new c.ShogiGame();
mate.pos = sfen('k8/9/1G7/9/9/9/9/9/K8 b G 1'); mate._legal = null;
mate.history = [{ key: c.toSfen(mate.pos, false), check: false, mover: null }];
mate.play(c.findLegalByUsi(mate.legalMoves(), 'G*9b'));
let out = mate.outcome();
console.log('頭金詰み:', JSON.stringify(out));
assert.deepStrictEqual(out, { winner: c.BLACK, reason: 'checkmate' });

// --- 千日手(同一局面4回) ---
const startGame = (s) => {
  const g = new c.ShogiGame();
  g.pos = sfen(s); g._legal = null; g.moves = [];
  g.history = [{ key: c.toSfen(g.pos, false), check: false, mover: null }];
  return g;
};
const step = (g, m) => { const mv = c.findLegalByUsi(g.legalMoves(), m); assert(mv, `${m} は合法のはず: ${c.toSfen(g.pos)}`); g.play(mv); return g.outcome(); };

let rep = startGame('4k4/9/9/9/9/9/9/9/4K4 b - 1');
let res = null;
for (let i = 0; i < 12 && !res; i++) res = step(rep, ['5i5h', '5a5b', '5h5i', '5b5a'][i % 4]);
console.log('千日手:', JSON.stringify(res), 'moves=', rep.moves.length);
assert.deepStrictEqual(res, { winner: null, reason: 'repetition' });
assert.strictEqual(rep.moves.length, 12, '同一局面が4回目に現れる12手目で成立');

// --- 連続王手の千日手: 先手の飛車が王手をかけ続ける ---
// 先手: 玉9九 / 飛1九  後手: 玉1一 → 1九→1八? それでは王手でない。 飛が1筋/2筋を往復して王手
let pc = startGame('8k/9/9/9/9/9/9/9/K7R b - 1');
// 1九の飛は1筋で既に後手玉1一を狙っている(1八〜1二が空) → 先手番だが後手が王手されたまま…
// 手番を後手にして、王手を受けてから繰り返す局面に整える:
pc = startGame('8k/9/9/9/9/9/9/R8/K8 b - 1'); // 先手: 玉9九 飛9八 / 後手: 玉1一
res = null;
// 先手 9八→1八 (1筋の王手) → 後手 玉 1一→2一 → 先手 1八→2八 (2筋の王手) → 後手 玉 2一→1一 → 先手 2八→1八 ...
const seq = ['9h1h', '1a2a', '1h2h', '2a1a'];
// 最初の1手(9八→1八)は繰り返しの外。以降を回す
step(pc, seq[0]); step(pc, seq[1]);
for (let i = 0; i < 20 && !res; i++) res = step(pc, ['1h2h', '2a1a', '2h1h', '1a2a'][i % 4]);
console.log('連続王手の千日手:', JSON.stringify(res), 'moves=', pc.moves.length);
assert.strictEqual(res.reason, 'perpetual');
assert.strictEqual(res.winner, c.WHITE, '王手をかけ続けた先手の負け');

// --- 手数上限 ---
const cap = new c.ShogiGame([], { maxPlies: 4 });
for (const m of ['7g7f', '3c3d', '2g2f', '8c8d']) step(cap, m);
assert.deepStrictEqual(cap.outcome(), { winner: null, reason: 'maxply' });

// --- 復元(replay)と不正手 ---
const g = new c.ShogiGame();
for (const m of ['7g7f', '3c3d', '2g2f', '8c8d', '2f2e', '8d8e', '6i7h', '4a3b']) step(g, m);
const g2 = new c.ShogiGame(g.moves);
assert.strictEqual(c.toSfen(g2.pos), c.toSfen(g.pos));
assert.strictEqual(g2.history.length, g.history.length);
assert.throws(() => new c.ShogiGame(['7g7f', '7g7f']), /不正/);

// --- 表示 ---
const g3 = new c.ShogiGame();
assert.strictEqual(c.describeMove(g3.pos, c.findLegalByUsi(g3.legalMoves(), '7g7f')), '▲７六歩(77)');
assert.strictEqual(c.describeMove(g3.pos, c.findLegalByUsi(g3.legalMoves(), '2g2f')), '▲２六歩(27)');
p = sfen('4k4/9/9/9/9/9/9/9/4K4 b 2P 1');
assert.strictEqual(c.describeMove(p, c.findLegalByUsi(c.legalMoves(p), 'P*5e')), '▲５五歩打');
assert.strictEqual(c.kanjiCount(2), '二'); assert.strictEqual(c.kanjiCount(10), '十'); assert.strictEqual(c.kanjiCount(13), '十三');
console.log('ALL RULE TESTS PASSED');
