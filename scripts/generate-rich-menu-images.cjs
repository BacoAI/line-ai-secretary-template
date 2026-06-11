#!/usr/bin/env node
// 生成 5 張 Rich Menu PNG(主選單 + 4 個子選單),2500×1686 黑底白字。
// 用法:node scripts/generate-rich-menu-images.js
// 需要:npm install --no-save @resvg/resvg-js

const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const W = 2500;
const H = 1686;
const COL_W = W / 3; // 833.33
const ROW_H = H / 2; // 843
const FONT = 'PingFang TC, Heiti TC, Hiragino Sans GB, Microsoft YaHei, sans-serif';

// 工具:畫一個按鈕格(背景 + 中央文字 + 副標,可空)
// v3:每個選單一個邊框色,切換時體感「換了地方」
const PADDING = 30; // 每格內縮,讓按鈕之間有黑底間隙
const RADIUS = 30; // 圓角
const BORDER_WIDTH = 8;
const BORDER_COLOR_BLANK = '#333'; // 留白格用更暗的邊
// 預設用主選單色;每張選單呼叫 cell() 前需先 setBorderColor()
let BORDER_COLOR = '#888';
function setBorderColor(c) { BORDER_COLOR = c; }
function cell(col, row, mainText, subText, isPrimary) {
  const x = col * COL_W + PADDING;
  const y = row * ROW_H + PADDING;
  const w = COL_W - PADDING * 2;
  const h = ROW_H - PADDING * 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  // 留白格:深邊框 + 暗灰「(留白)」字 — 視覺弱化,不搶眼
  if (!mainText) {
    return `
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${RADIUS}" ry="${RADIUS}" fill="#0a0a0a" stroke="${BORDER_COLOR_BLANK}" stroke-width="4"/>
      <text x="${cx}" y="${cy}" fill="#444" font-family="${FONT}" font-size="80" text-anchor="middle" dominant-baseline="central">(留白)</text>
    `;
  }
  const mainSize = isPrimary ? 170 : 130;
  const subSize = 80;
  // 主副雙行:對稱於格子中心(拉開間距,避免貼太緊)
  const mainY = subText ? cy - 80 : cy;
  const subY = cy + 95;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${RADIUS}" ry="${RADIUS}" fill="#000" stroke="${BORDER_COLOR}" stroke-width="${BORDER_WIDTH}"/>
    <text x="${cx}" y="${mainY}" fill="#fff" font-family="${FONT}" font-size="${mainSize}" text-anchor="middle" dominant-baseline="central" font-weight="600">${mainText}</text>
    ${subText ? `<text x="${cx}" y="${subY}" fill="#aaa" font-family="${FONT}" font-size="${subSize}" text-anchor="middle" dominant-baseline="central">${subText}</text>` : ''}
  `;
}

// v3 配色:主選單灰白,4 個子選單各自顏色
const COLORS = {
  main: '#888',       // 灰白
  view: '#5b9bd5',    // 藍灰 - 資訊
  plan: '#70ad47',    // 綠灰 - 行動
  custom: '#c084fc',  // 紫灰 - 創意
  settings: '#f0a05b',// 橙灰 - 工具
  family: '#d98ba0',  // 玫瑰灰 - 家庭(換色:體感換了地方)
};

// 主選單:2×3,4 個有功能 + 2 個留白
setBorderColor(COLORS.main);
const SVG_MAIN = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, '檢視', null, true)}
  ${cell(1, 0, '排計畫', null, true)}
  ${cell(2, 0, null)}
  ${cell(0, 1, null)}
  ${cell(1, 1, '客製化', '建議', true)}
  ${cell(2, 1, '設定', null, true)}
</svg>`;

// 檢視子選單
setBorderColor(COLORS.view);
const SVG_VIEW = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, '額度', null, false)}
  ${cell(1, 0, '現在要做', null, false)}
  ${cell(2, 0, null)}
  ${cell(0, 1, '帶東西', null, false)}
  ${cell(1, 1, null)}
  ${cell(2, 1, '← 返回', null, false)}
</svg>`;

// 排計畫子選單
setBorderColor(COLORS.plan);
const SVG_PLAN = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, '排工作', '建議', false)}
  ${cell(1, 0, null)}
  ${cell(2, 0, null)}
  ${cell(0, 1, null)}
  ${cell(1, 1, null)}
  ${cell(2, 1, '← 返回', null, false)}
</svg>`;

// 客製化建議子選單
setBorderColor(COLORS.custom);
const SVG_CUSTOM = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, '客製化', '建議文本', false)}
  ${cell(1, 0, null)}
  ${cell(2, 0, null)}
  ${cell(0, 1, null)}
  ${cell(1, 1, null)}
  ${cell(2, 1, '← 返回', null, false)}
</svg>`;

// 靜音子選單(設定 → 靜音)— 沿用設定色系
setBorderColor(COLORS.settings);
const SVG_MUTE = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, '30 分鐘', null, false)}
  ${cell(1, 0, '1 小時', null, false)}
  ${cell(2, 0, '4 小時', null, false)}
  ${cell(0, 1, '直到明早', '6:00', false)}
  ${cell(1, 1, '選擇時間', null, false)}
  ${cell(2, 1, '← 返回', null, false)}
</svg>`;

// 設定子選單(改版:提醒設定 / 家庭功能 / 留白 / 留白 / 擴充功能 / 返回)
setBorderColor(COLORS.settings);
const SVG_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, '提醒設定', null, false)}
  ${cell(1, 0, '家庭功能', null, false)}
  ${cell(2, 0, null)}
  ${cell(0, 1, null)}
  ${cell(1, 1, '擴充功能', null, false)}
  ${cell(2, 1, '← 返回', null, false)}
</svg>`;

// 提醒相關子選單(設定 → 提醒設定)— 靜音/追殺等級/提醒設定/早晚安 合一層
setBorderColor(COLORS.settings);
const SVG_REMINDERS = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, '靜音', null, false)}
  ${cell(1, 0, '追殺等級', null, false)}
  ${cell(2, 0, '提醒設定', null, false)}
  ${cell(0, 1, '早/晚安', '推播設定', false)}
  ${cell(1, 1, null)}
  ${cell(2, 1, '← 返回', null, false)}
</svg>`;

// 家庭功能子選單(設定 → 家庭功能)— 親子提醒
setBorderColor(COLORS.family);
const SVG_FAMILY = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, '綁定', null, false)}
  ${cell(1, 0, '綁定名單', null, false)}
  ${cell(2, 0, '綁定提醒', null, false)}
  ${cell(0, 1, null)}
  ${cell(1, 1, null)}
  ${cell(2, 1, '← 返回', null, false)}
</svg>`;

// 擴充功能子選單(設定 → 擴充功能)
setBorderColor(COLORS.settings);
const SVG_EXTENSIONS = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, 'Pushover', '讓提醒突破手機勿擾', false)}
  ${cell(1, 0, '電話介入', 'Twilio 撥真實電話', false)}
  ${cell(2, 0, '反拖延偵測', '看設定教學', false)}
  ${cell(0, 1, null)}
  ${cell(1, 1, null)}
  ${cell(2, 1, '← 返回', null, false)}
</svg>`;

// 帶東西子選單(檢視 → 帶東西)— 沿用檢視色系
setBorderColor(COLORS.view);
const SVG_BRING = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  ${cell(0, 0, '帶東西', '使用說明', false)}
  ${cell(1, 0, '設定', null, false)}
  ${cell(2, 0, null)}
  ${cell(0, 1, null)}
  ${cell(1, 1, null)}
  ${cell(2, 1, '← 返回', null, false)}
</svg>`;

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'rich-menu');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const targets = [
  { name: 'main', svg: SVG_MAIN },
  { name: 'view', svg: SVG_VIEW },
  { name: 'plan', svg: SVG_PLAN },
  { name: 'custom', svg: SVG_CUSTOM },
  { name: 'settings', svg: SVG_SETTINGS },
  { name: 'reminders', svg: SVG_REMINDERS },
  { name: 'family', svg: SVG_FAMILY },
  { name: 'mute', svg: SVG_MUTE },
  { name: 'extensions', svg: SVG_EXTENSIONS },
  { name: 'bring', svg: SVG_BRING },
];

for (const t of targets) {
  const resvg = new Resvg(Buffer.from(t.svg), {
    fitTo: { mode: 'width', value: W },
    font: { loadSystemFonts: true },
  });
  const png = resvg.render().asPng();
  const outPath = path.join(OUTPUT_DIR, `${t.name}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✓ ${outPath} (${png.length} bytes)`);
}

console.log(`\n總計 5 張 PNG 寫到 ${OUTPUT_DIR}`);
