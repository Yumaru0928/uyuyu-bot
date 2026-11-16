// commands/connect4.js (discord.js v14 / CommonJS)
//
// /connect4 opponent:@ユーザー → 人間との対戦（レート戦）
// /connect4 opponent:@Bot [level:..] → Bot（内蔵AI）との対戦（レート変動なし）
//
// 縦・横・斜めのどれかで4つ並べれば勝ち。進行中の対局は utils/sessions.js に保存され、
// Bot の再起動後は restoreSessions() で続きから遊べる（オセロ・将棋と同じ仕組み）。

const {
SlashCommandBuilder,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle,
StringSelectMenuBuilder,
ComponentType,
MessageFlags,
AttachmentBuilder,
} = require('discord.js');

const core = require('../../utils/connect4-core');
const boardImage = require('../../utils/board-image');
const rating = require('../../utils/rating');
const sessions = require('../../utils/sessions');
const { requestChallenge} = require('../../utils/challenge');
const { GAMES} = require('../../utils/games');

const GAME_ID = 'connect4'; // utils/games.js のキーと同じにする
const { RED, YELLOW, COLS, ROWS} = core;

// ---------- 設定 ----------
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 無操作10分で終了（レート戦は手番の人が時間切れ負け）
const SESSION_STALE_MS = 6 * 60 * 60 * 1000; // 再起動後、最後の操作からこれ以上たった対局は復元せず中断する
const RESIGN_CONFIRM_MS = 30 * 1000; // 投了の確認ボタンを待つ時間

// 操作ミス対策（オセロ・将棋と同様）: 各操作が有効になる画面の段階。古い画面からの操作は無視する
const REQUIRED_STAGE = {
col: 'col', toggle: 'col',
confirm: 'confirm', cancel: 'confirm',
};

// 落とす前の確認（既定はオン。「確認: ON/OFF」ボタンで、手番の人が自分の設定を切り替えられる）
const needsConfirm = (game, color) => game.players[color].confirm!== false;
const pieceTotal = (game) => {
const { red, yellow} = core.countPieces(game.board);
return red + yellow;
};

// ---------- 表示用 ----------
const PIECE = { [RED]: '🔴', [YELLOW]: '🟡'};
const LEVEL_LABEL = { easy: '弱い', normal: '普通', hard: '強い'};

function renderBoard(board, winLine = null) {
const winSet = new Set((winLine?? []).map((c) => `${c.x},${c.y}`));
const lines = ['1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣'];
for (let y = 0; y < ROWS; y++) {
let line = '';
for (let x = 0; x < COLS; x++) {
const v = board[y][x];
if (v === RED) line += winSet.has(`${x},${y}`)? '🟥': '🔴';
else if (v === YELLOW) line += winSet.has(`${x},${y}`)? '🟨': '🟡';
else line += '⚪';
}
lines.push(line);
}
return lines.join('\n');
}

function buildStatus(game, withBoardText = true) {
const { red, yellow} = core.countPieces(game.board);
const counts = { [RED]: red, [YELLOW]: yellow};
const p = game.players;
const mode = game.ranked
? ''
: ``;
const lines = [
mode,
`${PIECE[RED]} **${p[RED].displayName}** (${counts[RED]}) vs ${PIECE[YELLOW]} **${p[YELLOW].displayName}** (${counts[YELLOW]})`,
];
if (game.events.length > 0) lines.push(game.events.join('\n'));
if (game.note) lines.push(game.note); // 復元したときの案内（保存はしない）
if (withBoardText) lines.push(renderBoard(game.board, game.winLine));
return lines.join('\n');
}

// 盤面画像（Canvas）。作れない環境では null を返し、テキスト盤面で表示する
function boardFile(game) {
const buf = boardImage.renderConnect4(game.board, {
lastMove: game.lastMove?? null,
winLine: game.winLine?? null,
});
return buf? [new AttachmentBuilder(buf, { name: 'board.png'})]: null;
}

const btn = (id, label, style = ButtonStyle.Secondary) =>
new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function buildPlayMessage(game) {
const turnUser = game.players[game.turn];
const stage = game.stage?? 'col';

let head;
if (stage === 'confirm' && game.sel) {
head = `手番: ${PIECE[game.turn]} <@${turnUser.id}>\n✅ この列でよろしいですか？ **${game.sel.col + 1}列**（まだ落としていません）`;
} else {
head = `手番: ${PIECE[game.turn]} <@${turnUser.id}>`;
}
const files = boardFile(game);
const content = `${head}\n${buildStatus(game,!files)}`;

const rows = [];
if (stage === 'col') {
const options = core.legalMoves(game.board).map((x) => {
const height = game.board.reduce((n, row) => n + (row[x]!== core.EMPTY? 1: 0), 0);
return {
label: `${x + 1}列`,
description: `あと ${ROWS - height} 個入ります`,
value: String(x),
};
});
rows.push(
new ActionRowBuilder().addComponents(
new StringSelectMenuBuilder()
.setCustomId('col')
.setPlaceholder('① 落とす列を選んでください (1〜7)')
.addOptions(options),
),
);
}

const buttons = [];
if (stage === 'confirm') {
buttons.push(btn('confirm', 'この列に落とす', ButtonStyle.Success), btn('cancel', '選び直す'));
} else {
buttons.push(btn('toggle', `確認: ${needsConfirm(game, game.turn)? 'ON': 'OFF'}`));
}
buttons.push(btn('resign', '投了', ButtonStyle.Danger));
rows.push(new ActionRowBuilder().addComponents(...buttons));

return { content, components: rows,...(files? { files}: {})};
}

function buildResult(game, text, { rematch = true } = {}) {
const files = boardFile(game);
return {
content: `${text}\n${buildStatus(game,!files)}`,
// 終局後もコレクタが生きている間だけ再戦できる（時間切れの結果など、受け付けられない場合は付けない）
components: rematch
? [new ActionRowBuilder().addComponents(btn('rematch', '🔄 再戦', ButtonStyle.Primary))]
: [],
...(files? { files}: {}),
};
}

// 再戦用の新しい対局を作る（先手・後手を入れ替える。確認ON/OFFなどの個人設定は本人のエントリごと移る）
function createRematchGame(game) {
return {
board: core.createBoard(),
turn: RED,
players: { [RED]: game.players[YELLOW], [YELLOW]: game.players[RED]},
ranked: game.ranked,
level: game.level,
guildId: game.guildId,
stage: 'col',
sel: null,
busy: false,
lastMove: null,
winLine: null,
winner: undefined,
notifyMessageId: null,
events: [],
note: null,
over: false,
};
}

// ---------- 進行 ----------

// 現在の手番で col に落とし、勝敗・引き分けまで処理する
function doMove(game, col) {
const player = game.turn;
const placed = core.drop(game.board, col, player);
if (!placed) return false;
game.lastMove = placed;
game.events.push(`${PIECE[player]} ${game.players[player].displayName}: **${col + 1}列**`);

const win = core.findWinner(game.board);
if (win) {
game.over = true;
game.winner = win.player;
game.winLine = win.line;
} else if (core.isFull(game.board)) {
game.over = true;
game.winner = null; // 引き分け
} else {
game.turn = 3 - player;
}
return true;
}

// 手番がAIの間、落とし続ける
function runAi(game) {
while (!game.over && game.players[game.turn].isAi) {
const col = core.chooseAiMove(game.board, game.turn, game.level);
if (col === null ||!doMove(game, col)) break; // 通常は起こらない
}
}

// 結果の確定とレート記録。表示用テキストを返す
// winner: RED / YELLOW / null(引き分け) reason: 'normal' | 'resign' | 'timeout'
function settle(game, winner, reason) {
const p = game.players;
const loser = winner === null? null: 3 - winner;

let text;
if (reason === 'resign') {
text = `🏳️ **${p[loser].displayName}** が投了しました。\n🏆 **${p[winner].displayName}** の勝ち！`;
} else if (reason === 'timeout') {
text = `⌛ **${p[loser].displayName}** が時間切れのため、🏆 **${p[winner].displayName}** の勝ち！`;
} else if (winner === null) {
text = '🎉 ゲーム終了！ 🤝 引き分け！';
} else {
text = `🎉 ゲーム終了！ 🏆 **${p[winner].displayName}** (${PIECE[winner]}) の勝ち！`;
}

if (game.ranked) {
try {
const r = rating.recordMatch({
game: GAME_ID,
guildId: game.guildId,
userA: p[RED].id,
userB: p[YELLOW].id,
result: winner === RED? 'a': winner === YELLOW? 'b': 'draw',
});
const fmt = (color, x) =>
`${PIECE[color]} ${p[color].displayName}: ${x.before} → **${x.after}** (${x.delta >= 0? '+': ''}${x.delta})`;
text += `\n📈 レート変動\n${fmt(RED, r.a)}\n${fmt(YELLOW, r.b)}`;
} catch (err) {
console.error('[connect4] rating error:', err);
text += '\n⚠️ 戦績の保存に失敗しました。';
}
} else {
text += '\n(Bot戦のためレートは変動しません)';
}
return text;
}

// ---------- 保存と復元 ----------

const activeIds = new Set();
const restoringIds = new Set();
const GONE_CODES = new Set([10003, 10008, 50001, 50013]);

function saveSession(game, message) {
sessions.put(GAME_ID, message.id, {
channelId: message.channelId,
guildId: game.guildId,
board: game.board,
turn: game.turn,
players: game.players,
ranked: game.ranked,
level: game.level,
events: game.events,
lastMove: game.lastMove?? null,
notifyMessageId: game.notifyMessageId?? null,
});
}

function isValidSession(s) {
const okBoard =
Array.isArray(s.board) && s.board.length === ROWS &&
s.board.every((row) => Array.isArray(row) && row.length === COLS && row.every((c) => c === 0 || c === 1 || c === 2));
const okPlayer = (p) => p && typeof p.id === 'string' && typeof p.displayName === 'string';
return (
okBoard &&
(s.turn === RED || s.turn === YELLOW) &&
okPlayer(s.players?.[RED]) && okPlayer(s.players?.[YELLOW]) &&
typeof s.channelId === 'string' &&
typeof s.ranked === 'boolean'
);
}

// ---------- 対局の進行（新規開始・復元で共通） ----------
function startSession(game, message) {
activeIds.add(message.id);
game.stage = game.stage?? 'col';
game.sel = game.sel?? null;
saveSession(game, message);

const humanIds = new Set(
Object.values(game.players).filter((p) =>!p.isAi).map((p) => p.id),
);
const collector = message.createMessageComponentCollector({ idle: IDLE_TIMEOUT_MS});
const deny = (i, text) => i.reply({ content: text, flags: MessageFlags.Ephemeral});
const refresh = (i) => i.update(buildPlayMessage(game));
const resetStage = () => {
game.stage = 'col';
game.sel = null;
};

// 手番通知（オセロ・将棋と同様、メンション専用の新規メッセージ）
async function notifyTurn() {
if (!game.ranked) return;
const turnPlayer = game.players[game.turn];
if (!turnPlayer || turnPlayer.isAi) return;
try {
await clearNotify();
const sent = await message.channel.send({
content: `🔔 <@${turnPlayer.id}> あなたの手番です（${GAMES[GAME_ID].label}）`,
allowedMentions: { users: [turnPlayer.id]},
});
game.notifyMessageId = sent.id;
saveSession(game, message);
} catch (err) {
console.error('[connect4] 手番通知エラー:', err);
}
}

async function clearNotify() {
if (!game.notifyMessageId) return;
const id = game.notifyMessageId;
game.notifyMessageId = null;
try {
const old = await message.channel.messages.fetch(id).catch(() => null);
if (old) await old.delete().catch(() => {});
} catch {
// 通知の後始末に失敗しても対局は続ける
}
}

// 駒を落とす（相手がBotなら続けて打つ）。画面の更新と手番通知までここで行う
async function commitMove(i, col) {
game.events = [];
game.note = null;
resetStage();
doMove(game, col);
runAi(game);

if (game.over) {
sessions.remove(GAME_ID, message.id); // 終わった対局は復元対象から外す（再戦ボタン用にコレクタは残す）
await clearNotify();
return i.update(buildResult(game, settle(game, game.winner?? null, 'normal')));
}
saveSession(game, message);
const r = await i.update(buildPlayMessage(game));
await notifyTurn();
return r;
}

// 投了は、押した本人にだけ見える確認を出してから確定する（オセロ・将棋と同様）
async function confirmResign(i) {
const prompt = await i.reply({
content: '⚠️ 本当に投了しますか？ 投了すると**負け**になります。',
components: [
new ActionRowBuilder().addComponents(
btn('resign:yes', '投了する', ButtonStyle.Danger),
btn('resign:no', '続ける', ButtonStyle.Secondary),
),
],
flags: MessageFlags.Ephemeral,
withResponse: true,
});
const promptMessage = prompt?.resource?.message?? (await i.fetchReply());

let answer;
try {
answer = await promptMessage.awaitMessageComponent({
componentType: ComponentType.Button,
filter: (c) => c.user.id === i.user.id,
time: RESIGN_CONFIRM_MS,
});
} catch {
await i.editReply({ content: '投了の確認がタイムアウトしました。対局は続行します。', components: []}).catch(() => {});
return;
}

if (answer.customId!== 'resign:yes') {
await answer.update({ content: '投了をやめました。対局を続けます。', components: []}).catch(() => {});
return;
}
if (game.over) {
await answer.update({ content: '対局はすでに終了しています。', components: []}).catch(() => {});
return;
}
const loserColor = i.user.id === game.players[RED].id? RED: YELLOW;
game.over = true;
sessions.remove(GAME_ID, message.id);
await clearNotify();
await answer.update({ content: '投了しました。', components: []}).catch(() => {});
await message.edit(buildResult(game, settle(game, 3 - loserColor, 'resign'))).catch((err) => console.error('[connect4] resign edit error:', err));
}

// 再戦ボタン。Bot戦はその場で開始、人間同士は相手の承諾を取ってから開始する
async function handleRematch(i) {
if (!game.over) return deny(i, '対局が終わるまで再戦はできません。');
if (game.rematchStarted) return deny(i, 'すでに再戦の手続きが始まっています。');
game.rematchStarted = true;
await message.edit({ components: []}).catch(() => {}); // 元の結果画面のボタンは消す（二重開始防止）

const next = createRematchGame(game);

if (!game.ranked) {
// Bot戦: 申し込みなしで即開始（Botが先手なら先に落とす）
runAi(next);
await i.reply(buildPlayMessage(next));
const msg = await i.fetchReply();
startSession(next, msg);
return;
}
// 人間同士: 相手の承諾を取る（対戦申し込みと同じ流れ）
const opponentEntry = Object.values(next.players).find((pl) => pl.id!== i.user.id);
const res = await requestChallenge(i, {
opponent: { id: opponentEntry.id },
gameLabel: GAMES[GAME_ID].label,
});
if (res.status!== 'accepted') return;
await res.interaction.update(buildPlayMessage(next));
startSession(next, res.message);
}

collector.on('collect', async (i) => {
try {
if (!humanIds.has(i.user.id)) {
return deny(i, 'この対局の参加者ではありません。');
}

if (i.customId === 'rematch') return handleRematch(i);

if (i.customId === 'resign') return confirmResign(i);

if (game.busy) return deny(i, '処理中です。少しお待ちください。');
if (game.over) return deny(i, 'この対局は終了しています。');

if (i.user.id!== game.players[game.turn].id) {
return deny(i, 'あなたの手番ではありません。');
}

// 古い画面からの操作は、何も実行せず最新の画面に更新するだけにする
const needStage = REQUIRED_STAGE[i.customId];
if (needStage && game.stage!== needStage) return refresh(i);

switch (i.customId) {
case 'toggle': {
const me = game.players[game.turn];
me.confirm =!needsConfirm(game, game.turn);
game.note = me.confirm? '✅ 落とす前に確認します。': '⚡ 確認なしで、選んだらすぐ落とします。';
saveSession(game, message);
return refresh(i);
}

case 'col': {
const col = Number(i.values[0]);
if (!core.legalMoves(game.board).includes(col)) {
resetStage();
return refresh(i);
}
if (needsConfirm(game, game.turn)) {
game.stage = 'confirm';
game.sel = { col, ply: pieceTotal(game)};
return refresh(i);
}
game.busy = true;
try {
return await commitMove(i, col);
} finally {
game.busy = false;
}
}

case 'confirm': {
// 確認画面を出したときと同じ局面で、まだ落とせる列のときだけ落とす
const sel = game.sel;
if (!sel || sel.ply!== pieceTotal(game) ||!core.legalMoves(game.board).includes(sel.col)) {
resetStage();
return refresh(i);
}
game.busy = true;
try {
return await commitMove(i, sel.col);
} finally {
game.busy = false;
}
}

case 'cancel':
resetStage();
return refresh(i);

default:
return undefined;
}
} catch (err) {
console.error('[connect4] interaction error:', err);
}
});

notifyTurn().catch(() => {});

collector.on('end', async (_collected, reason) => {
activeIds.delete(message.id);
sessions.remove(GAME_ID, message.id);
await clearNotify();

if (game.over) {
// 再戦できる時間（無操作タイムアウトまで）が過ぎたら、結果画面のボタンを消す
await message.edit({ components: []}).catch(() => {});
return;
}
if (reason!== 'idle') return;
try {
game.over = true;
const text = game.ranked
? settle(game, 3 - game.turn, 'timeout')
: '⌛ 一定時間操作がなかったため、対局を終了しました。(Bot戦のため記録なし)';
await message.edit(buildResult(game, text, { rematch: false}));
} catch (err) {
console.error('[connect4] timeout error:', err);
}
});
}

// 保存されている対局を1つ復元する
async function restoreOne(client, s) {
if (!isValidSession(s)) {
console.warn(`[connect4] 保存データの形式が正しくないため破棄しました (message ${s.messageId})`);
sessions.remove(GAME_ID, s.messageId);
return;
}

let message;
try {
const channel = await client.channels.fetch(s.channelId);
message = await channel.messages.fetch(s.messageId);
} catch (err) {
if (GONE_CODES.has(err.code)) {
console.log(`[connect4] 対局のメッセージが見つからないため破棄しました (message ${s.messageId})`);
sessions.remove(GAME_ID, s.messageId);
return;
}
throw err;
}

if (Date.now() - (s.updatedAt?? 0) > SESSION_STALE_MS) {
sessions.remove(GAME_ID, s.messageId);
await message
.edit({
content: '⌛ Botの再起動から長い時間がたったため、この対局は中断されました。(レートは変動しません)',
components: [],
})
.catch(() => {});
return;
}

const game = {
board: s.board,
turn: s.turn,
players: s.players,
ranked: s.ranked,
level: s.level?? 'normal',
guildId: s.guildId?? null,
stage: 'col',
sel: null,
busy: false,
lastMove: s.lastMove?? null,
winLine: null,
winner: undefined,
notifyMessageId: s.notifyMessageId?? null,
events: Array.isArray(s.events)? s.events: [],
note: '♻️ Botが再起動したため、対局を復元しました。続きから遊べます。',
over: false,
};

await message.edit(buildPlayMessage(game));
startSession(game, message);
console.log(`[connect4] 対局を復元しました (message ${s.messageId})`);
}

// Bot の起動後（ready）に index.js から呼ばれる
async function restoreSessions(client) {
const saved = sessions.list(GAME_ID);
if (saved.length === 0) return;
console.log(`[connect4] 保存されている ${saved.length} 件の対局を復元します...`);

for (const s of saved) {
if (activeIds.has(s.messageId) || restoringIds.has(s.messageId)) continue;
restoringIds.add(s.messageId);
try {
await restoreOne(client, s);
} catch (err) {
console.error(`[connect4] 対局の復元に失敗しました (message ${s.messageId}):`, err);
} finally {
restoringIds.delete(s.messageId);
}
}
}

// ---------- コマンド本体 ----------
module.exports = {
data: new SlashCommandBuilder()
.setName('connect4')
.setDescription('四目並べで対戦します（Botを指定するとBot戦）')
.addUserOption((o) =>
o.setName('opponent').setDescription('対戦相手（Botを指定するとBot戦）').setRequired(true),
)
.addStringOption((o) =>
o
.setName('level')
.setDescription('Botの強さ（Bot戦のみ・省略時は普通）')
.addChoices(
{ name: '弱い', value: 'easy'},
{ name: '普通', value: 'normal'},
{ name: '強い', value: 'hard'},
),
),

restoreSessions,

async execute(interaction) {
const opponent = interaction.options.getUser('opponent', true);
const level = interaction.options.getString('level')?? 'normal';
const challenger = interaction.user;

if (opponent.id === challenger.id) {
return interaction.reply({ content: '自分自身とは対戦できません。', flags: MessageFlags.Ephemeral});
}

const vsAi = opponent.bot;
const opponentMember = interaction.options.getMember('opponent');

const challengerEntry = {
id: challenger.id,
displayName: interaction.member?.displayName?? challenger.globalName?? challenger.username,
isAi: false,
};
const opponentEntry = {
id: opponent.id,
displayName: opponentMember?.displayName?? opponent.globalName?? opponent.username,
isAi: vsAi,
};

// 先手(赤)はランダム
const challengerIsRed = Math.random() < 0.5;
const game = {
board: core.createBoard(),
turn: RED,
players: challengerIsRed
? { [RED]: challengerEntry, [YELLOW]: opponentEntry}
: { [RED]: opponentEntry, [YELLOW]: challengerEntry},
ranked:!vsAi,
level,
guildId: interaction.guildId?? null,
stage: 'col',
sel: null,
busy: false,
lastMove: null,
winLine: null,
winner: undefined,
notifyMessageId: null,
events: [],
note: null,
over: false,
};

let message;

if (vsAi) {
runAi(game);
await interaction.reply(buildPlayMessage(game));
message = await interaction.fetchReply();
} else {
const res = await requestChallenge(interaction, {
opponent,
gameLabel: GAMES[GAME_ID].label,
});
if (res.status!== 'accepted') return;
await res.interaction.update(buildPlayMessage(game));
message = res.message;
}

startSession(game, message);
},
};
