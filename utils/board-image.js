'use strict';

// 対戦ゲームの盤面を Canvas で画像化する（UI改善）。
// @napi-rs/canvas が読み込めない環境では null を返し、呼び出し側は従来のテキスト盤面にフォールバックする。

const path = require('node:path');

let createCanvas = null;
let GlobalFonts = null;
try {
  ({ createCanvas, GlobalFonts } = require('@napi-rs/canvas'));
  // 将棋の駒字用フォント（リポジトリ同梱の Noto Serif JP）。失敗しても描画は続ける
  try {
    GlobalFonts.registerFromPath(path.join(__dirname, '..', 'fonts', 'NotoSerifJP-Regular.otf'), 'NotoSerifJP');
  } catch {
    // フォントが無い場合は既定フォントで描く
  }
} catch {
  createCanvas = null;
}

const FONT = '"NotoSerifJP","Noto Sans JP",sans-serif';

// ---------- オセロ ----------
function renderOthello(board, { candidates = [], lastMove = null } = {}) {
  if (!createCanvas) return null;
  const CELL = 64;
  const PAD = 28; // 座標ラベルの余白（左・上）
  const size = PAD + CELL * 8 + 8;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0b6e4f';
  ctx.fillRect(0, 0, size, size);

  // 座標
  ctx.fillStyle = '#e8f5e9';
  ctx.font = `bold 18px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const COLS = 'abcdefgh';
  for (let x = 0; x < 8; x++) ctx.fillText(COLS[x].toUpperCase(), PAD + x * CELL + CELL / 2, PAD / 2 + 2);
  for (let y = 0; y < 8; y++) ctx.fillText(String(y + 1), PAD / 2, PAD + y * CELL + CELL / 2);

  const candSet = new Set(candidates.map((m) => `${m.x},${m.y}`));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const px = PAD + x * CELL;
      const py = PAD + y * CELL;
      ctx.fillStyle = (x + y) % 2 === 0 ? '#0f7d59' : '#0d7351';
      ctx.fillRect(px, py, CELL, CELL);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeRect(px + 0.5, py + 0.5, CELL, CELL);

      const cx = px + CELL / 2;
      const cy = py + CELL / 2;
      const v = board[y][x];
      if (v === 1 || v === 2) {
        ctx.beginPath();
        ctx.arc(cx, cy, CELL * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = v === 1 ? '#15181a' : '#f5f5f0';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.stroke();
        if (lastMove && lastMove.x === x && lastMove.y === y) {
          ctx.beginPath();
          ctx.arc(cx, cy, 6, 0, Math.PI * 2);
          ctx.fillStyle = '#ff5252';
          ctx.fill();
        }
      } else if (candSet.has(`${x},${y}`)) {
        ctx.beginPath();
        ctx.arc(cx, cy, CELL * 0.16, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,235,59,0.85)';
        ctx.fill();
      }
    }
  }
  return canvas.toBuffer('image/png');
}

// ---------- 将棋 ----------
// pos: shogi-core の Position（board は 81 マス、sq = y*9+x。x=0 が9筋）
// marks: Map<sq, 'move'|'capture'>（テキスト盤面と同じ意味）
function renderShogi(pos, core, { marks = new Map(), lastMoveTo = null } = {}) {
  if (!createCanvas) return null;
  const CELL = 56;
  const PAD_X = 34; // 右に段（漢数字）、上に筋（数字）の余白
  const PAD_TOP = 26;
  const w = PAD_X + CELL * 9 + 6;
  const h = PAD_TOP + CELL * 9 + 6;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f3d9a4';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#5d4037';
  ctx.lineWidth = 2;
  ctx.strokeRect(3, 3, w - 6, h - 6);

  // 座標
  ctx.fillStyle = '#4e342e';
  ctx.font = `bold 15px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let x = 0; x < 9; x++) ctx.fillText(String(9 - x), PAD_X + x * CELL + CELL / 2, PAD_TOP / 2 + 2);
  for (let y = 0; y < 9; y++) ctx.fillText(core.KAN_NUM[y], PAD_X + CELL * 9 + PAD_X / 2 - 4, PAD_TOP + y * CELL + CELL / 2);

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const sq = y * 9 + x;
      const px = PAD_X + x * CELL;
      const py = PAD_TOP + y * CELL;
      const mark = marks.get(sq);
      if (mark === 'move' || sq === lastMoveTo) {
        ctx.fillStyle = 'rgba(255,193,7,0.45)';
        ctx.fillRect(px, py, CELL, CELL);
      } else if (mark === 'capture') {
        ctx.fillStyle = 'rgba(244,67,54,0.30)';
        ctx.fillRect(px, py, CELL, CELL);
      }
      ctx.strokeStyle = 'rgba(62,39,35,0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL, CELL);

      const piece = pos.board[sq];
      if (!piece) continue;
      const color = core.colorOf(piece);
      const label = core.pieceKanji(piece);
      const cx = px + CELL / 2;
      const cy = py + CELL / 2;

      ctx.save();
      ctx.translate(cx, cy);
      if (color === core.WHITE) ctx.rotate(Math.PI);
      // 駒の形（五角形）
      const pw = CELL * 0.78;
      const ph = CELL * 0.86;
      ctx.beginPath();
      ctx.moveTo(0, -ph / 2);
      ctx.lineTo(pw / 2, -ph * 0.18);
      ctx.lineTo(pw * 0.42, ph / 2);
      ctx.lineTo(-pw * 0.42, ph / 2);
      ctx.lineTo(-pw / 2, -ph * 0.18);
      ctx.closePath();
      ctx.fillStyle = '#f8e7bd';
      ctx.fill();
      ctx.strokeStyle = '#6d4c41';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 駒字（成駒は赤字）
      const promoted = label.length === 1 && 'と龍馬全圭杏'.includes(label);
      ctx.fillStyle = promoted ? '#c62828' : '#212121';
      ctx.font = `${label.length > 1 ? 17 : 21}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (label.length > 1) {
        ctx.fillText(label[0], 0, -10);
        ctx.fillText(label[1], 0, 10);
      } else {
        ctx.fillText(label, 0, 1);
      }
      ctx.restore();
    }
  }
  return canvas.toBuffer('image/png');
}

module.exports = { renderOthello, renderShogi, available: !!createCanvas };
