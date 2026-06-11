#!/usr/bin/env node
// 把 5 張 Rich Menu PNG 註冊到 LINE
// 用法:node scripts/setup-rich-menu.cjs
//
// 流程:清掉舊 Rich Menu + alias → 建 5 個新 RM → 建 alias → 上傳 PNG → 設主選單為預設

const fs = require('fs');
const path = require('path');

// === 載入 .dev.vars 拿 LINE token ===
const devVars = fs.readFileSync(path.join(__dirname, '..', '.dev.vars'), 'utf8');
const env = {};
for (const line of devVars.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
}
const TOKEN = env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('✗ .dev.vars 沒有 LINE_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}

const API = 'https://api.line.me';
const DATA_API = 'https://api-data.line.me';
const H_JSON = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};
const H_PNG = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'image/png',
};

const IMG_DIR = path.join(__dirname, '..', 'assets', 'rich-menu');

// === Schema:每張 Rich Menu 的 areas + actions ===
// 2500×1686, 2 列 3 欄,每格 833×843(中間 834 補足 2500)
const COL = [
  { x: 0, w: 833 },
  { x: 833, w: 834 },
  { x: 1667, w: 833 },
];
const ROW = [
  { y: 0, h: 843 },
  { y: 843, h: 843 },
];
const cellBounds = (c, r) => ({ x: COL[c].x, y: ROW[r].y, width: COL[c].w, height: ROW[r].h });

// switch action(切到另一個 Rich Menu)
const swAction = (aliasId, data) => ({
  type: 'richmenuswitch',
  richMenuAliasId: aliasId,
  data,
});
const msgAction = (text) => ({ type: 'message', text });
const pbAction = (data, displayText) => ({ type: 'postback', data, displayText: `→ ${displayText}` });
// 既有功能用 postback + displayText 顯示「→ 額度」(取代 message action)
const cmdAction = (cmd) => ({ type: 'postback', data: `rm:cmd=${cmd}`, displayText: `→ ${cmd}` });
// 時間選擇器 — 跳出滾輪,選完傳 postback with params.time = 'HH:MM'
const timeAction = (cmd, initial) => ({
  type: 'datetimepicker',
  data: `rm:cmd=${cmd}`,
  mode: 'time',
  initial: initial || '22:00',
});

const RICH_MENUS = [
  {
    alias: 'rm-main',
    name: 'rm-main',
    chatBarText: '選單',
    image: 'main.png',
    selected: true,
    areas: [
      { bounds: cellBounds(0, 0), action: swAction('rm-view', 'rm-switch=view') },
      { bounds: cellBounds(1, 0), action: swAction('rm-plan', 'rm-switch=plan') },
      // (2,0) 留白:不設 area
      // (0,1) 留白:不設 area
      { bounds: cellBounds(1, 1), action: swAction('rm-custom', 'rm-switch=custom') },
      { bounds: cellBounds(2, 1), action: swAction('rm-settings', 'rm-switch=settings') },
    ],
  },
  {
    alias: 'rm-view',
    name: 'rm-view',
    chatBarText: '選單',
    image: 'view.png',
    selected: false,
    areas: [
      { bounds: cellBounds(0, 0), action: cmdAction('額度') },
      // v211: 提醒/今日寫入移除;現在要做移到第二格(0,1 改 1,0)
      { bounds: cellBounds(1, 0), action: pbAction('rm:cmd=now-todo', '現在要做') },
      // v226: 帶東西 → switch 到 rm-bring 子選單(說明 + 設定)
      { bounds: cellBounds(0, 1), action: swAction('rm-bring', 'rm-switch=bring') },
      // (1,1) 留白
      { bounds: cellBounds(2, 1), action: swAction('rm-main', 'rm-switch=main') },
    ],
  },
  {
    // v226: 帶東西子選單(檢視 → 帶東西)
    alias: 'rm-bring',
    name: 'rm-bring',
    chatBarText: '選單',
    image: 'bring.png',
    selected: false,
    areas: [
      { bounds: cellBounds(0, 0), action: pbAction('rm:cmd=bring-help', '帶東西說明') },
      { bounds: cellBounds(1, 0), action: pbAction('rm:cmd=bring-settings', '帶東西設定') },
      // (2,0)(0,1)(1,1) 留白
      { bounds: cellBounds(2, 1), action: swAction('rm-view', 'rm-switch=view') },
    ],
  },
  {
    alias: 'rm-plan',
    name: 'rm-plan',
    chatBarText: '選單',
    image: 'plan.png',
    selected: false,
    areas: [
      // v211: 今日計畫備份移除;排工作移到第一格(送訊息「排工作」走 planning fast-path)
      { bounds: cellBounds(0, 0), action: msgAction('排工作') },
      // (2,0)(0,1)(1,1) 留白
      { bounds: cellBounds(2, 1), action: swAction('rm-main', 'rm-switch=main') },
    ],
  },
  {
    alias: 'rm-custom',
    name: 'rm-custom',
    chatBarText: '選單',
    image: 'custom.png',
    selected: false,
    areas: [
      { bounds: cellBounds(0, 0), action: pbAction('rm:客製化建議文本', '客製化建議文本') },
      // 其他留白
      { bounds: cellBounds(2, 1), action: swAction('rm-main', 'rm-switch=main') },
    ],
  },
  {
    alias: 'rm-settings',
    name: 'rm-settings',
    chatBarText: '選單',
    image: 'settings.png',
    selected: false,
    areas: [
      // 提醒設定 → 提醒相關子選單(靜音/追殺等級/提醒設定/早晚安 合一層)
      { bounds: cellBounds(0, 0), action: swAction('rm-reminders', 'rm-switch=reminders') },
      // 家庭功能 → 家庭子選單(親子提醒)
      { bounds: cellBounds(1, 0), action: swAction('rm-family', 'rm-switch=family') },
      // (2,0)、(0,1) 留白
      // 擴充功能子選單
      { bounds: cellBounds(1, 1), action: swAction('rm-extensions', 'rm-switch=extensions') },
      { bounds: cellBounds(2, 1), action: swAction('rm-main', 'rm-switch=main') },
    ],
  },
  {
    alias: 'rm-extensions',
    name: 'rm-extensions',
    chatBarText: '選單',
    image: 'extensions.png',
    selected: false,
    areas: [
      // Pushover 教學(回 Flex Message)
      { bounds: cellBounds(0, 0), action: pbAction('rm:cmd=pushover-setup', 'Pushover 設定') },
      // v214: 電話介入 → 引導使用者用自己的 Claude 跑 docs/TWILIO-PHONE-SETUP.md 安裝
      { bounds: cellBounds(1, 0), action: pbAction('rm:cmd=phone-setup-guide', '電話介入') },
      // v211: 反拖延偵測設定教學(回 Drive PDF SOP + 版本差異提醒)
      { bounds: cellBounds(2, 0), action: pbAction('rm:cmd=antiprocrast-guide', '反拖延偵測') },
      // 其他留白給未來擴充
      // 返回到設定(rm-extensions 是設定的子)
      { bounds: cellBounds(2, 1), action: swAction('rm-settings', 'rm-switch=settings') },
    ],
  },
  {
    alias: 'rm-mute',
    name: 'rm-mute',
    chatBarText: '選單',
    image: 'mute.png',
    selected: false,
    areas: [
      { bounds: cellBounds(0, 0), action: pbAction('rm:cmd=mute-30m', '靜音 30 分鐘') },
      { bounds: cellBounds(1, 0), action: pbAction('rm:cmd=mute-1h', '靜音 1 小時') },
      { bounds: cellBounds(2, 0), action: pbAction('rm:cmd=mute-4h', '靜音 4 小時') },
      { bounds: cellBounds(0, 1), action: pbAction('rm:cmd=mute-tomorrow-6am', '靜音到明早 6:00') },
      // 「選擇時間」用 datetimepicker(原本設定→靜音的功能搬到這)
      { bounds: cellBounds(1, 1), action: timeAction('mute-until', '22:00') },
      // 返回到提醒相關(靜音現在歸在「提醒相關」子選單下)
      { bounds: cellBounds(2, 1), action: swAction('rm-reminders', 'rm-switch=reminders') },
    ],
  },
  {
    // 提醒相關子選單(設定 → 提醒設定)— 靜音/追殺等級/提醒設定/早晚安 合一層
    alias: 'rm-reminders',
    name: 'rm-reminders',
    chatBarText: '選單',
    image: 'reminders.png',
    selected: false,
    areas: [
      { bounds: cellBounds(0, 0), action: swAction('rm-mute', 'rm-switch=mute') },
      { bounds: cellBounds(1, 0), action: pbAction('rm:cmd=followup-level', '追殺等級') },
      { bounds: cellBounds(2, 0), action: msgAction('提醒設定') },
      { bounds: cellBounds(0, 1), action: pbAction('rm:早晚安推播設定', '早/晚安推播設定') },
      // (1,1) 留白
      { bounds: cellBounds(2, 1), action: swAction('rm-settings', 'rm-switch=settings') },
    ],
  },
  {
    // 家庭功能子選單(設定 → 家庭功能)— 親子提醒
    alias: 'rm-family',
    name: 'rm-family',
    chatBarText: '選單',
    image: 'family.png',
    selected: false,
    areas: [
      { bounds: cellBounds(0, 0), action: pbAction('rm:cmd=family-bind', '綁定') },
      { bounds: cellBounds(1, 0), action: pbAction('rm:cmd=family-list', '綁定名單') },
      { bounds: cellBounds(2, 0), action: pbAction('rm:cmd=family-reminders', '綁定提醒') },
      // (0,1)、(1,1) 留白
      { bounds: cellBounds(2, 1), action: swAction('rm-settings', 'rm-switch=settings') },
    ],
  },
];

async function api(method, url, body, headers = H_JSON) {
  const r = await fetch(url, {
    method,
    headers,
    body: body
      ? body instanceof Buffer
        ? body
        : JSON.stringify(body)
      : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${method} ${url} → ${r.status}: ${text.substring(0, 300)}`);
  }
  return text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
}

async function clearAll() {
  console.log('--- 清掉舊 Rich Menu + alias ---');
  // 先清 alias(否則 alias 指向的 RM 不能刪)
  try {
    const r = await api('GET', `${API}/v2/bot/richmenu/alias/list`);
    for (const a of r.aliases || []) {
      await api('DELETE', `${API}/v2/bot/richmenu/alias/${a.richMenuAliasId}`);
      console.log(`  ✓ del alias ${a.richMenuAliasId}`);
    }
  } catch (e) {
    console.warn('  list alias 失敗(可能本來就沒):', e.message);
  }
  // 清 RM
  const r = await api('GET', `${API}/v2/bot/richmenu/list`);
  for (const m of r.richmenus || []) {
    await api('DELETE', `${API}/v2/bot/richmenu/${m.richMenuId}`);
    console.log(`  ✓ del RM ${m.richMenuId.substring(0, 20)}...`);
  }
}

async function createAndUpload(spec) {
  const schema = {
    size: { width: 2500, height: 1686 },
    selected: spec.selected,
    name: spec.name,
    chatBarText: spec.chatBarText,
    areas: spec.areas,
  };
  const r = await api('POST', `${API}/v2/bot/richmenu`, schema);
  const richMenuId = r.richMenuId;
  console.log(`  ✓ created ${spec.alias} = ${richMenuId}`);

  // 上傳圖
  const pngPath = path.join(IMG_DIR, spec.image);
  const png = fs.readFileSync(pngPath);
  await api('POST', `${DATA_API}/v2/bot/richmenu/${richMenuId}/content`, png, H_PNG);
  console.log(`  ✓ uploaded ${spec.image} (${png.length} bytes)`);

  // 建 alias
  await api('POST', `${API}/v2/bot/richmenu/alias`, {
    richMenuAliasId: spec.alias,
    richMenuId,
  });
  console.log(`  ✓ alias ${spec.alias} → ${richMenuId.substring(0, 16)}...`);

  return richMenuId;
}

async function setDefault(richMenuId) {
  await api('POST', `${API}/v2/bot/user/all/richmenu/${richMenuId}`);
  console.log(`  ✓ 設為全 user 預設`);
}

(async () => {
  try {
    await clearAll();
    console.log('--- 建 5 個 Rich Menu + alias + 上傳 ---');
    const ids = {};
    for (const spec of RICH_MENUS) {
      ids[spec.alias] = await createAndUpload(spec);
    }
    console.log('--- 設主選單為預設 ---');
    await setDefault(ids['rm-main']);
    console.log('\n✓ Rich Menu 部署完成');
    console.log('在 LINE 對話內按底部「選單」應該看到 6 格主選單');
  } catch (e) {
    console.error('✗ 部署失敗:', e.message);
    process.exit(1);
  }
})();
