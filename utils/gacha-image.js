'use strict';

// うゆゆガチャの結果画像・図鑑画像の描画。
//
// デザインは Claude のデザイン案（2026-11-17、ガチャ結果／図鑑の Canvas 具体指定）を実装したもの。
// 色・寸法は先頭の STYLE に集約してある。フォントは M PLUS Rounded 1c（fonts/、OFL 1.1）。
// @napi-rs/canvas が読み込めない環境では null を返し、呼び出し側はテキストのみの返信にフォールバックする。

const path = require('node:path');

let createCanvas = null;
let loadImage = null;
let GlobalFonts = null;
try {
  ({ createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas'));
  try {
    GlobalFonts.registerFromPath(path.join(__dirname, '..', 'fonts', 'MPLUSRounded1c-Regular.ttf'), 'MPLUSRounded1c');
    GlobalFonts.registerFromPath(path.join(__dirname, '..', 'fonts', 'MPLUSRounded1c-Bold.ttf'), 'MPLUSRounded1c-Bold');
  } catch {
    // フォントが無い場合は既定フォントで描く
  }
} catch {
  createCanvas = null;
}

const FONT = '"MPLUSRounded1c",sans-serif';
const FONT_BOLD = '"MPLUSRounded1c-Bold",sans-serif';

// ============================================================
// デザイン定数（Claude デザイン案 2026-11-17）
// ============================================================
const STYLE = {
  background: '#2f3136',
  cellBg: { N: '#202225', R: '#1c2433', SR: '#261c33', SP: '#14302a', COND: '#202225' },
  textMain: '#ffffff',
  textSub: '#b9bbbe',
  textWeak: '#72767d',
  // レアリティ枠
  rarityFrame: { N: '#6b7280', R: '#3b82f6', SR: '#a855f7', SP: '#2ecc71' },
  goldStops: ['#fff3b0', '#ffd23f', '#f59e0b', '#fff3b0'],
  silverStops: ['#e5e7eb', '#9ca3af', '#e5e7eb'],
  // 寸法
  cell: 136, // セル一辺
  emojiSize: 96, // セル内の絵文字サイズ
  gap: 12,
  pad: 24,
  radius: 12,
  nameHeight: 36, // 図鑑: セル下の名前・ヒント欄
  // NEW バッジ
  newBadgeBg: '#ef4444',
  newBadgeSsrBg: '#f59e0b',
  newBadgeSsrColor: '#3b2300',
  // シルエット
  silhouetteColor: '#14161a',
  silhouetteCondColor: '#0b0c0e',
  dashedFrame: '#4f545c',
  dashedFrameCond: 'rgba(250,166,26,0.4)',
  hintColor: '#faa61a',
  // 進捗バー
  progressBg: '#202225',
  progressFill: '#43b581',
};

// 絵文字画像は一度読み込んだらメモリに残す（毎回CDNから取りに行かない）
const imageCache = new Map();

function loadEmojiImage(emojiId) {
  if (!loadImage) return Promise.resolve(null);
  if (!imageCache.has(emojiId)) {
    const promise = loadImage(`https://cdn.discordapp.com/emojis/${emojiId}.png`).catch((error) => {
      imageCache.delete(emojiId); // 失敗したものは次回また試す
      console.error(`絵文字画像 (${emojiId}) の読み込みに失敗しました:`, error);
      return null;
    });
    imageCache.set(emojiId, promise);
  }
  return imageCache.get(emojiId);
}

// ---- 描画ヘルパー ----

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function gradient(ctx, x, y, size, stops) {
  const g = ctx.createLinearGradient(x, y, x + size, y + size);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

// 4点星を図形で描く（フォントに ✦ が無い環境でも化けないように）
function drawSparkle(ctx, cx, cy, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx, cy, cx + r, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy + r);
  ctx.quadraticCurveTo(cx, cy, cx - r, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy - r);
  ctx.fill();
  ctx.restore();
}

// 5点星を図形で描く（金枠の王冠代わり）
function drawStar(ctx, cx, cy, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#7a4a00';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// 小さな鍵アイコン（隠し枠のヒント用、絵文字フォントに頼らない）
function drawLock(ctx, cx, cy, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(cx, cy - 2, 4, Math.PI, 0);
  ctx.stroke();
  roundRectPath(ctx, cx - 5.5, cy - 2, 11, 9, 2);
  ctx.fill();
  ctx.restore();
}

function drawCellBase(ctx, x, y, rarity) {
  const { cell, radius } = STYLE;
  roundRectPath(ctx, x, y, cell, cell, radius);
  if (rarity === 'SSR') {
    const rg = ctx.createRadialGradient(x + 68, y + 68, 10, x + 68, y + 68, 95);
    rg.addColorStop(0, '#5a3d0a');
    rg.addColorStop(1, '#241a05');
    ctx.fillStyle = rg;
  } else {
    ctx.fillStyle = STYLE.cellBg[rarity] ?? STYLE.cellBg.N;
  }
  ctx.fill();
}

function drawRarityFrame(ctx, x, y, rarity) {
  const { cell, radius } = STYLE;
  if (rarity === 'SSR') {
    ctx.save();
    ctx.shadowColor = '#f59e0b';
    ctx.shadowBlur = 12;
    roundRectPath(ctx, x + 2.5, y + 2.5, cell - 5, cell - 5, radius);
    ctx.strokeStyle = gradient(ctx, x, y, cell, STYLE.goldStops);
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.restore();
    roundRectPath(ctx, x + 8, y + 8, cell - 16, cell - 16, 8);
    ctx.strokeStyle = 'rgba(255,243,176,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 左下はレアリティ文字ラベルと重なるので星は3隅だけ
    for (const [sx, sy] of [[16, 16], [cell - 16, 16], [cell - 16, cell - 16]]) {
      drawSparkle(ctx, x + sx, y + sy, 6, '#fff3b0');
    }
  } else if (rarity === 'SR') {
    ctx.save();
    ctx.shadowColor = STYLE.rarityFrame.SR;
    ctx.shadowBlur = 10;
    roundRectPath(ctx, x + 1.5, y + 1.5, cell - 3, cell - 3, radius);
    ctx.strokeStyle = STYLE.rarityFrame.SR;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  } else {
    roundRectPath(ctx, x + 1, y + 1, cell - 2, cell - 2, radius);
    ctx.strokeStyle = STYLE.rarityFrame[rarity] ?? STYLE.rarityFrame.N;
    ctx.lineWidth = rarity === 'N' ? 2 : 3;
    ctx.stroke();
  }
  if (['SSR', 'SR', 'R', 'SP'].includes(rarity)) {
    ctx.fillStyle = rarity === 'SSR' ? '#ffd23f' : STYLE.rarityFrame[rarity];
    ctx.font = `12px ${FONT_BOLD}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(rarity, x + 10, y + cell - 8);
  }
}

// 育成枠（図鑑用）：銀・金はレアリティ枠より優先される
function drawGrowthFrame(ctx, x, y, tier) {
  const { cell, radius } = STYLE;
  if (tier === 'gold') {
    ctx.save();
    ctx.shadowColor = 'rgba(255,210,63,0.6)';
    ctx.shadowBlur = 12;
    roundRectPath(ctx, x + 2.5, y + 2.5, cell - 5, cell - 5, radius);
    ctx.strokeStyle = gradient(ctx, x, y, cell, STYLE.goldStops);
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.restore();
    drawStar(ctx, x + cell - 14, y + 14, 8, '#ffd23f');
  } else if (tier === 'silver') {
    ctx.save();
    ctx.shadowColor = 'rgba(229,231,235,0.5)';
    ctx.shadowBlur = 8;
    roundRectPath(ctx, x + 2, y + 2, cell - 4, cell - 4, radius);
    ctx.strokeStyle = gradient(ctx, x, y, cell, STYLE.silverStops);
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  }
}

// 育成枠が付いているときのレアリティ帯（左上の小さなバー）
function drawRarityBand(ctx, x, y, rarity) {
  if (!['SSR', 'SR', 'R', 'SP'].includes(rarity)) return;
  roundRectPath(ctx, x + 8, y + 8, 28, 6, 3);
  ctx.fillStyle = rarity === 'SSR' ? '#ffd23f' : STYLE.rarityFrame[rarity];
  ctx.fill();
}

function drawNewBadge(ctx, x, y, isSSR) {
  ctx.save();
  ctx.translate(x - 6 + 22, y - 6 + 10);
  ctx.rotate((-8 * Math.PI) / 180);
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;
  roundRectPath(ctx, -22, -10, 44, 20, 10);
  ctx.fillStyle = isSSR ? STYLE.newBadgeSsrBg : STYLE.newBadgeBg;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = isSSR ? STYLE.newBadgeSsrColor : '#ffffff';
  ctx.font = `12px ${FONT_BOLD}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('NEW!', 0, 1);
  ctx.restore();
}

function drawCountBadge(ctx, x, y, count) {
  if (count < 2) return;
  const { cell } = STYLE;
  const label = '×' + count;
  ctx.font = `12px ${FONT_BOLD}`;
  const w = Math.max(22, ctx.measureText(label).width + 12);
  const bx = x + cell - w + 6;
  const by = y + cell - 22 + 6;
  roundRectPath(ctx, bx, by, w, 22, 11);
  ctx.fillStyle = '#18191c';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + w / 2, by + 12);
}

function drawSilhouette(ctx, img, x, y, dark) {
  const { emojiSize } = STYLE;
  const off = createCanvas(emojiSize, emojiSize);
  const o = off.getContext('2d');
  o.drawImage(img, 0, 0, emojiSize, emojiSize);
  o.globalCompositeOperation = 'source-in';
  o.fillStyle = dark ? STYLE.silhouetteCondColor : STYLE.silhouetteColor;
  o.fillRect(0, 0, emojiSize, emojiSize);
  const offset = (STYLE.cell - emojiSize) / 2;
  ctx.drawImage(off, x + offset, y + offset);
  ctx.fillStyle = dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.18)';
  ctx.font = `28px ${FONT_BOLD}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', x + STYLE.cell / 2, y + STYLE.cell / 2);
}

// 文字列を最大幅で折り返す（日本語は1文字ずつ測る）
function wrapText(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) return lines;
    } else {
      line += ch;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

/**
 * ガチャ結果画像（5×2）。レアリティ枠＋NEW バッジ。SSR があれば全体を金トーンにする。
 * @param {Array<{id: string, name?: string, rarity: string, isNew?: boolean}>} results
 * @returns {Promise<Buffer|null>}
 */
async function renderGachaResult(results) {
  if (!createCanvas) return null;
  const { cell, gap, pad } = STYLE;
  const columns = 5;
  const rows = Math.ceil(results.length / columns);
  const headerH = 48;
  const width = pad * 2 + cell * columns + gap * (columns - 1);
  const height = pad + headerH + cell * rows + gap * (rows - 1) + pad;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const hasSSR = results.some((r) => r.rarity === 'SSR');

  if (hasSSR) {
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#3a2a0a');
    bg.addColorStop(1, '#1a1206');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    // 放射光線（SSR セルの中心から）
    const ssrIndex = results.findIndex((r) => r.rarity === 'SSR');
    const cx = pad + (ssrIndex % columns) * (cell + gap) + cell / 2;
    const cy = pad + headerH + Math.floor(ssrIndex / columns) * (cell + gap) + cell / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(255,210,63,0.07)';
    for (let i = 0; i < 24; i += 2) {
      const a0 = (i * Math.PI) / 12;
      const a1 = ((i + 1) * Math.PI) / 12;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, Math.max(width, height), a0, a1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  } else {
    ctx.fillStyle = STYLE.background;
    ctx.fillRect(0, 0, width, height);
  }

  // ヘッダー
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (hasSSR) {
    ctx.save();
    ctx.font = `26px ${FONT_BOLD}`;
    const tg = ctx.createLinearGradient(pad, 0, pad + 260, 0);
    tg.addColorStop(0, '#fff3b0');
    tg.addColorStop(0.5, '#ffd23f');
    tg.addColorStop(1, '#f59e0b');
    ctx.fillStyle = tg;
    ctx.shadowColor = '#f59e0b';
    ctx.shadowBlur = 12;
    ctx.fillText('★ SSR 出現！ ★', pad, pad + 20);
    ctx.restore();
  } else {
    ctx.font = `20px ${FONT_BOLD}`;
    ctx.fillStyle = STYLE.textMain;
    ctx.fillText('うゆゆ絵文字ガチャ ×10', pad, pad + 20);
  }

  const images = await Promise.all(results.map((r) => loadEmojiImage(r.id)));
  const offset = (cell - STYLE.emojiSize) / 2;
  results.forEach((r, i) => {
    const x = pad + (i % columns) * (cell + gap);
    const y = pad + headerH + Math.floor(i / columns) * (cell + gap);
    drawCellBase(ctx, x, y, r.rarity);
    if (images[i]) ctx.drawImage(images[i], x + offset, y + offset, STYLE.emojiSize, STYLE.emojiSize);
    drawRarityFrame(ctx, x, y, r.rarity);
    if (r.isNew) drawNewBadge(ctx, x, y, r.rarity === 'SSR');
  });

  if (hasSSR) {
    roundRectPath(ctx, 2, 2, width - 4, height - 4, 16);
    ctx.strokeStyle = gradient(ctx, 0, 0, width, STYLE.goldStops);
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  return canvas.encode('png');
}

/**
 * 図鑑画像（5列）。所持=カラー＋育成枠＋所持数＋名前、未所持=シルエット＋破線枠（条件枠はヒント）。
 * @param {Array<{id: string, name: string, rarity: string, count: number, tier: string, hint?: string, condition?: string}>} entries
 * @returns {Promise<Buffer|null>}
 */
async function renderZukan(entries) {
  if (!createCanvas) return null;
  const { cell, gap, pad, nameHeight } = STYLE;
  const columns = 5;
  const rows = Math.ceil(entries.length / columns);
  const headerH = 72;
  const rowH = cell + nameHeight;
  const width = pad * 2 + cell * columns + gap * (columns - 1);
  const height = pad + headerH + rowH * rows + gap * (rows - 1) + pad;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = STYLE.background;
  ctx.fillRect(0, 0, width, height);

  const kinds = entries.filter((e) => e.count > 0).length;
  const complete = kinds === entries.length;
  // ヘッダー
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `24px ${FONT_BOLD}`;
  ctx.fillStyle = STYLE.textMain;
  ctx.fillText('うゆゆ図鑑', pad, pad + 18);
  ctx.font = `20px ${FONT_BOLD}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${kinds} / ${entries.length}`, width - pad, pad + 14);
  const barW = 200;
  const barX = width - pad - barW;
  roundRectPath(ctx, barX, pad + 36, barW, 8, 4);
  ctx.fillStyle = STYLE.progressBg;
  ctx.fill();
  if (kinds > 0) {
    roundRectPath(ctx, barX, pad + 36, Math.max(8, (barW * kinds) / entries.length), 8, 4);
    ctx.fillStyle = complete ? gradient(ctx, barX, pad + 36, barW, STYLE.goldStops) : STYLE.progressFill;
    ctx.fill();
  }

  const images = await Promise.all(entries.map((e) => loadEmojiImage(e.id)));
  const offset = (cell - STYLE.emojiSize) / 2;
  entries.forEach((e, i) => {
    const x = pad + (i % columns) * (cell + gap);
    const y = pad + headerH + Math.floor(i / columns) * (rowH + gap);
    const owned = e.count > 0;
    const isCond = Boolean(e.condition);
    drawCellBase(ctx, x, y, owned ? e.rarity : 'N');
    if (owned) {
      if (images[i]) ctx.drawImage(images[i], x + offset, y + offset, STYLE.emojiSize, STYLE.emojiSize);
      if (e.tier === 'gold' || e.tier === 'silver') {
        drawGrowthFrame(ctx, x, y, e.tier);
        drawRarityBand(ctx, x, y, e.rarity);
      } else {
        drawRarityFrame(ctx, x, y, e.rarity);
      }
      drawCountBadge(ctx, x, y, e.count);
      ctx.fillStyle = STYLE.textSub;
      ctx.font = `13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.name, x + cell / 2, y + cell + 16);
    } else {
      if (images[i]) drawSilhouette(ctx, images[i], x, y, isCond);
      ctx.save();
      ctx.setLineDash([6, 5]);
      roundRectPath(ctx, x + 1, y + 1, cell - 2, cell - 2, STYLE.radius);
      ctx.strokeStyle = isCond ? STYLE.dashedFrameCond : STYLE.dashedFrame;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      if (isCond && e.hint) {
        ctx.font = `11px ${FONT}`;
        const lines = wrapText(ctx, e.hint, cell - 8, 2);
        ctx.fillStyle = STYLE.hintColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        lines.forEach((line, li) => {
          const ly = y + cell + 10 + li * 13;
          if (li === 0) {
            const tw = ctx.measureText(line).width;
            drawLock(ctx, x + cell / 2 - tw / 2 - 10, ly, STYLE.hintColor);
          }
          ctx.fillText(line, x + cell / 2 + (li === 0 ? 6 : 0), ly);
        });
      } else {
        ctx.fillStyle = STYLE.textWeak;
        ctx.font = `13px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('？？？？？', x + cell / 2, y + cell + 16);
      }
    }
  });

  // 最終行の空きスペースに残り種数
  const usedInLastRow = entries.length % columns;
  if (!complete && usedInLastRow > 0 && usedInLastRow < columns) {
    const x = pad + usedInLastRow * (cell + gap);
    const y = pad + headerH + (rows - 1) * (rowH + gap);
    ctx.fillStyle = STYLE.textWeak;
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`コンプリートまであと ${entries.length - kinds} 種`, x, y + cell / 2);
  }
  return canvas.encode('png');
}

module.exports = { STYLE, loadEmojiImage, renderGachaResult, renderZukan };
