/**
 * Rich Menu 範本(免費版內含 3 種,buyer 可選 + 可客製化)
 *
 * 設計原則:
 * - 極簡風格,無 emoji 裝飾(只用文字按鈕)
 * - 6 顆按鈕(2x3 layout)
 * - 每顆按鈕的 action 對應到 bot 內部的 handler
 *
 * buyer 可以:
 * - 一鍵切換範本(對 bot 說「換成創作型」)
 * - 對話式修改單顆(對 bot 說「第 3 顆改成 XX」)
 * - 從 15 個預設按鈕池選
 */

export interface RichMenuButton {
  position: number; // 1~6
  label: string;
  action: string; // 對應 bot internal handler
  description?: string;
}

export interface RichMenuTemplate {
  id: string;
  name: string;
  description: string;
  buttons: RichMenuButton[];
}

// === 範本 A:工作型(預設)===
export const TEMPLATE_WORK: RichMenuTemplate = {
  id: 'work',
  name: '工作型',
  description: '適合一般工作者,聚焦於行程與任務管理',
  buttons: [
    { position: 1, label: '今日',     action: 'show_today',       description: '查看今天的所有任務' },
    { position: 2, label: '加任務',   action: 'add_task',         description: '快速加入新任務' },
    { position: 3, label: '完成日誌', action: 'show_completion',  description: '今日已完成的事' },
    { position: 4, label: '本週',     action: 'show_week',        description: '一週行程' },
    { position: 5, label: '休息',     action: 'start_rest',       description: '開始限時休息' },
    { position: 6, label: '設定',     action: 'open_settings',    description: '調整偏好' },
  ],
};

// === 範本 B:創作型 ===
export const TEMPLATE_CREATIVE: RichMenuTemplate = {
  id: 'creative',
  name: '創作型',
  description: '適合創作者、講師、內容製作者',
  buttons: [
    { position: 1, label: '今日',     action: 'show_today',       description: '查看今天的任務' },
    { position: 2, label: '加靈感',   action: 'add_idea',         description: '記下隨手想到的點子' },
    { position: 3, label: '拍片清單', action: 'show_filming',     description: '拍攝待辦事項' },
    { position: 4, label: '加任務',   action: 'add_task',         description: '加結構化任務' },
    { position: 5, label: '靈感池',   action: 'show_ideas',       description: '所有靈感清單' },
    { position: 6, label: '設定',     action: 'open_settings',    description: '調整偏好' },
  ],
};

// === 範本 C:生活型 ===
export const TEMPLATE_LIFE: RichMenuTemplate = {
  id: 'life',
  name: '生活型',
  description: '適合重視生活管理、健康追蹤的使用者',
  buttons: [
    { position: 1, label: '今日',     action: 'show_today',       description: '查看今天的事' },
    { position: 2, label: '加事項',   action: 'add_task',         description: '快速加入待辦' },
    { position: 3, label: '健康',     action: 'log_health',       description: '記錄體重/運動/飲食' },
    { position: 4, label: '購物',     action: 'show_shopping',    description: '購物清單' },
    { position: 5, label: '家事',     action: 'show_household',   description: '家事分工' },
    { position: 6, label: '設定',     action: 'open_settings',    description: '調整偏好' },
  ],
};

export const ALL_TEMPLATES = [TEMPLATE_WORK, TEMPLATE_CREATIVE, TEMPLATE_LIFE];

// === 按鈕池(buyer 可從這裡挑換)===
// 給「對話式客製化」用的可選按鈕清單
export const BUTTON_POOL: Array<{ action: string; label: string; description: string }> = [
  { action: 'show_today',         label: '今日',         description: '查看今天的所有任務' },
  { action: 'show_week',          label: '本週',         description: '查看一週行程' },
  { action: 'show_overdue',       label: '已逾期',       description: '查看延後/未完成的事' },
  { action: 'add_task',           label: '加任務',       description: '對話式加入新任務' },
  { action: 'add_idea',           label: '加靈感',       description: '記下隨手想到的點子' },
  { action: 'add_memo',           label: '快速備忘',     description: '隨手記錄,之後分類' },
  { action: 'show_completion',    label: '完成日誌',     description: '今日已完成的事' },
  { action: 'show_ideas',         label: '靈感池',       description: '所有靈感清單' },
  { action: 'show_shopping',      label: '購物清單',     description: '要買的東西' },
  { action: 'show_household',     label: '家事',         description: '家事分工追蹤' },
  { action: 'show_filming',       label: '拍片清單',     description: '拍攝待辦' },
  { action: 'start_rest',         label: '休息',         description: '開始限時休息計時器' },
  { action: 'start_pomodoro',     label: '番茄鐘',       description: '開始 25 分鐘番茄鐘(付費)' },
  { action: 'log_health',         label: '健康',         description: '記錄體重/運動/飲食' },
  { action: 'log_mood',           label: '心情',         description: '記今天的心情狀態' },
  { action: 'rescue',             label: '救援',         description: '卡住了,跟 bot 對話求救' },
  { action: 'open_settings',      label: '設定',         description: '調整偏好(推播時間等)' },
];
