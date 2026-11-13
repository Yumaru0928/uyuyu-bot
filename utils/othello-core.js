'use strict';

// オセロのルールとAI。discord.js には依存しません。 board[y][x]

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const COLS = 'abcdefgh';

const DIRECTIONS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

// ---------- ルール ----------
function createBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(EMPTY));
  b[3][3] = WHITE; b[4][4] = WHITE;
  b[3][4] = BLACK; b[4][3] = BLACK;
  return b;
}

const cloneBoard = (board) => board.map((row) => row.slice());
const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;

/** (x, y) に player が置いたとき裏返る石の座標。置けないなら空配列 */
function getFlips(board, x, y, player) {
  if (board[y][x] !== EMPTY) return [];
  const opp = 3 - player;
  const flips = [];
  for (const [dx, dy] of DIRECTIONS) {
    const line = [];
    let nx = x + dx;
    let ny = y + dy;
    while (inside(nx, ny) && board[ny][nx] === opp) {
      line.push([nx, ny]);
      nx += dx;
      ny += dy;
    }
    if (line.length > 0 && inside(nx, ny) && board[ny][nx] === player) {
      flips.push(...line);
    }
  }
  return flips;
}

/** 置ける場所の一覧 [{x, y, flips}] */
function getLegalMoves(board, player) {
  const moves = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const flips = getFlips(board, x, y, player);
      if (flips.length > 0) moves.push({ x, y, flips });
    }
  }
  return moves;
}

/** 石を置いて裏返す(board を直接変更)。裏返した座標を返す。置けなければ空配列 */
function place(board, x, y, player) {
  const flips = getFlips(board, x, y, player);
  if (flips.length === 0) return flips;
  board[y][x] = player;
  for (const [fx, fy] of flips) board[fy][fx] = player;
  return flips;
}

function countStones(board) {
  let black = 0;
  let white = 0;
  for (const row of board) {
    for (const c of row) {
      if (c === BLACK) black++;
      else if (c === WHITE) white++;
    }
  }
  return { black, white };
}

// ---------- AI ----------
const WEIGHTS = [
  [100, -20, 10,  5,  5, 10, -20, 100],
  [-20, -50, -2, -2, -2, -2, -50, -20],
  [ 10,  -2,  1,  1,  1,  1,  -2,  10],
  [  5,  -2,  1,  0,  0,  1,  -2,   5],
  [  5,  -2,  1,  0,  0,  1,  -2,   5],
  [ 10,  -2,  1,  1,  1,  1,  -2,  10],
  [-20, -50, -2, -2, -2, -2, -50, -20],
  [100, -20, 10,  5,  5, 10, -20, 100],
];

// 探索の深さ（0 = ランダム）
const LEVEL_DEPTH = { easy: 0, normal: 3, hard: 5 };

// player 視点の評価値（角の価値 + 着手可能数の差）
function evaluate(board, player) {
  const opp = 3 - player;
  let pos = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const c = board[y][x];
      if (c === player) pos += WEIGHTS[y][x];
      else if (c === opp) pos -= WEIGHTS[y][x];
    }
  }
  const mobility = getLegalMoves(board, player).length - getLegalMoves(board, opp).length;
  return pos + mobility * 8;
}

function terminalScore(board, player) {
  const { black, white } = countStones(board);
  const diff = player === BLACK ? black - white : white - black;
  return diff * 1000;
}

// ネガマックス + αβ枝刈り。player 視点のスコアを返す
function negamax(board, player, depth, alpha, beta) {
  const moves = getLegalMoves(board, player);
  if (moves.length === 0) {
    if (getLegalMoves(board, 3 - player).length === 0) return terminalScore(board, player);
    return -negamax(board, 3 - player, depth, -beta, -alpha); // パス
  }
  if (depth === 0) return evaluate(board, player);

  // 良さそうな手(角など)から先に読むと枝刈りが効く
  moves.sort((a, b) => WEIGHTS[b.y][b.x] - WEIGHTS[a.y][a.x]);

  let best = -Infinity;
  for (const m of moves) {
    const next = cloneBoard(board);
    place(next, m.x, m.y, player);
    const v = -negamax(next, 3 - player, depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/** AIの一手を選ぶ。置ける場所がなければ null */
function chooseAiMove(board, player, level = 'normal') {
  const moves = getLegalMoves(board, player);
  if (moves.length === 0) return null;

  const depth = LEVEL_DEPTH[level] ?? LEVEL_DEPTH.normal;
  if (depth === 0) return moves[Math.floor(Math.random() * moves.length)];

  moves.sort((a, b) => WEIGHTS[b.y][b.x] - WEIGHTS[a.y][a.x]);

  let bestScore = -Infinity;
  let best = [];
  for (const m of moves) {
    const next = cloneBoard(board);
    place(next, m.x, m.y, player);
    // 評価値は整数なので alpha = bestScore - 1 にすると「同点」も正確に拾える
    const score = -negamax(next, 3 - player, depth - 1, -Infinity, -(bestScore - 1));
    if (score > bestScore) {
      bestScore = score;
      best = [m];
    } else if (score === bestScore) {
      best.push(m);
    }
  }
  return best[Math.floor(Math.random() * best.length)];
}

module.exports = {
  EMPTY, BLACK, WHITE, COLS,
  createBoard, cloneBoard, getFlips, getLegalMoves, place, countStones,
  chooseAiMove,
};