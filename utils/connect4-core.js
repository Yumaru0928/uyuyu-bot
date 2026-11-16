'use strict';

// 四目並べ（Connect Four）のルールとAI。
// 盤面は board[y][x]（y=0 が一番上、y=ROWS-1 が一番下）。駒は列の一番下の空きマスに落ちる。
// プレイヤーは RED(1)=先手 / YELLOW(2)=後手。縦・横・斜めのどれか4つ並べれば勝ち。

const COLS = 7;
const ROWS = 6;
const EMPTY = 0;
const RED = 1;
const YELLOW = 2;

function createBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
}

function cloneBoard(board) {
  return board.map((row) => [...row]);
}

// その列に落としたら着地する行（満杯なら -1）
function dropRow(board, col) {
  for (let y = ROWS - 1; y >= 0; y--) {
    if (board[y][col] === EMPTY) return y;
  }
  return -1;
}

function legalMoves(board) {
  const moves = [];
  for (let x = 0; x < COLS; x++) if (dropRow(board, x) >= 0) moves.push(x);
  return moves;
}

// 駒を落とす。成功したら { x, y }、満杯なら null
function drop(board, col, player) {
  const y = dropRow(board, col);
  if (y < 0) return null;
  board[y][col] = player;
  return { x: col, y };
}

const DIRS = [
  [1, 0], // 横
  [0, 1], // 縦
  [1, 1], // 斜め（右下）
  [1, -1], // 斜め（右上）
];

// 勝者がいれば { player, line: [{x, y} ×4] }、いなければ null
function findWinner(board) {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = board[y][x];
      if (p === EMPTY) continue;
      for (const [dx, dy] of DIRS) {
        const line = [{ x, y }];
        for (let k = 1; k < 4; k++) {
          const nx = x + dx * k;
          const ny = y + dy * k;
          if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS || board[ny][nx] !== p) break;
          line.push({ x: nx, y: ny });
        }
        if (line.length === 4) return { player: p, line };
      }
    }
  }
  return null;
}

function isFull(board) {
  return legalMoves(board).length === 0;
}

function countPieces(board) {
  let red = 0;
  let yellow = 0;
  for (const row of board) {
    for (const c of row) {
      if (c === RED) red++;
      else if (c === YELLOW) yellow++;
    }
  }
  return { red, yellow };
}

// ---------- AI ----------

// その列に落としたら勝てるか
function winningCols(board, player) {
  const wins = [];
  for (const x of legalMoves(board)) {
    const copy = cloneBoard(board);
    drop(copy, x, player);
    if (findWinner(copy)?.player === player) wins.push(x);
  }
  return wins;
}

// 4マスの窓を数えて局面を評価する（player 視点）
function evaluate(board, player) {
  const opp = 3 - player;
  let score = 0;
  const windowScore = (cells) => {
    const mine = cells.filter((c) => c === player).length;
    const theirs = cells.filter((c) => c === opp).length;
    const empty = cells.filter((c) => c === EMPTY).length;
    if (mine > 0 && theirs > 0) return 0;
    if (mine === 4) return 100000;
    if (mine === 3 && empty === 1) return 120;
    if (mine === 2 && empty === 2) return 12;
    if (theirs === 3 && empty === 1) return -150;
    if (theirs === 2 && empty === 2) return -10;
    return 0;
  };
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      for (const [dx, dy] of DIRS) {
        const cells = [];
        for (let k = 0; k < 4; k++) {
          const nx = x + dx * k;
          const ny = y + dy * k;
          if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) break;
          cells.push(board[ny][nx]);
        }
        if (cells.length === 4) score += windowScore(cells);
      }
    }
  }
  // 中央の列は有利
  const center = Math.floor(COLS / 2);
  for (let y = 0; y < ROWS; y++) {
    if (board[y][center] === player) score += 6;
    else if (board[y][center] === opp) score -= 6;
  }
  return score;
}

function minimax(board, player, turn, depth, alpha, beta) {
  const win = findWinner(board);
  if (win) return win.player === player ? 1000000 + depth : -1000000 - depth;
  if (isFull(board)) return 0;
  if (depth === 0) return evaluate(board, player);

  const moves = legalMoves(board).sort(
    (a, b) => Math.abs(a - COLS / 2) - Math.abs(b - COLS / 2),
  );
  if (turn === player) {
    let best = -Infinity;
    for (const x of moves) {
      const copy = cloneBoard(board);
      drop(copy, x, turn);
      best = Math.max(best, minimax(copy, player, 3 - turn, depth - 1, alpha, beta));
      alpha = Math.max(alpha, best);
      if (alpha >= beta) break;
    }
    return best;
  }
  let best = Infinity;
  for (const x of moves) {
    const copy = cloneBoard(board);
    drop(copy, x, turn);
    best = Math.min(best, minimax(copy, player, 3 - turn, depth - 1, alpha, beta));
    beta = Math.min(beta, best);
    if (alpha >= beta) break;
  }
  return best;
}

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

function chooseAiMove(board, player, level = 'normal') {
  const moves = legalMoves(board);
  if (moves.length === 0) return null;
  const opp = 3 - player;

  if (level === 'easy') {
    // 弱い: たまに勝ち筋だけは取る。それ以外はランダム（相手の勝ちもあまり止めない）
    const wins = winningCols(board, player);
    if (wins.length > 0 && Math.random() < 0.7) return pickRandom(wins);
    return pickRandom(moves);
  }

  // 勝てる手は取る／相手の勝ちは止める（普通・強い共通）
  const wins = winningCols(board, player);
  if (wins.length > 0) return wins[0];
  const blocks = winningCols(board, opp);
  if (blocks.length > 0) return blocks[0];

  if (level === 'normal') {
    // 普通: 相手に次の手で勝たれる列は避け、あとは評価関数の高い列（同点なら中央寄り）
    const safe = moves.filter((x) => {
      const copy = cloneBoard(board);
      drop(copy, x, player);
      return winningCols(copy, opp).length === 0;
    });
    const pool = safe.length > 0 ? safe : moves;
    let best = pool[0];
    let bestScore = -Infinity;
    for (const x of pool) {
      const copy = cloneBoard(board);
      drop(copy, x, player);
      const s = evaluate(copy, player) - Math.abs(x - COLS / 2);
      if (s > bestScore) {
        bestScore = s;
        best = x;
      }
    }
    return best;
  }

  // 強い: 深読み（αβ探索）
  let best = moves[0];
  let bestScore = -Infinity;
  for (const x of moves) {
    const copy = cloneBoard(board);
    drop(copy, x, player);
    const s = minimax(copy, player, opp, 6, -Infinity, Infinity);
    if (s > bestScore) {
      bestScore = s;
      best = x;
    }
  }
  return best;
}

module.exports = {
  COLS, ROWS, EMPTY, RED, YELLOW,
  createBoard, cloneBoard, dropRow, legalMoves, drop,
  findWinner, isFull, countPieces, winningCols, chooseAiMove,
};
