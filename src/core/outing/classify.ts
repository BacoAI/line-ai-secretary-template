/**
 * 出門語意分類 — 共用的「這條事項是不是要出門 / 對應哪個情境模板」判斷。
 *
 * v225: 從 cron.ts 的 scanNotionRemindersForOuting 抽出來,讓 cron(行事曆預判)
 *   跟 assemble.ts(NFC 今日清單)共用同一套,避免兩份各自漂移。
 *
 * 注意:這是「便宜的 keyword 粗篩」。Phase 3 會在 NFC 嗶 / 早安這種低頻高價值時刻,
 *   改用 Claude 判語意取代這張表(燒錢防護:平日 cron 維持便宜 keyword)。
 */

// v224(B): 只在「明確出門訊號」才算要出門 — 不單憑活動名詞(開會/會議…)硬猜。
//   有移動詞的「去開會」「去公司開會」算;純桌前的「整理開會東西」不算。
export const DEPARTURE_SIGNALS = [
  '出門', '出發', '前往', '赴', '去', '到公司', '進公司', '上班', '下班', '回家',
  '接小孩', '接送', '開車', '騎車', '搭車', '搭高鐵', '搭捷運', '拜訪', '面交',
  '聚餐', '聚會', '跑步', '晨跑', '夜跑', '慢跑', '健身', '看診', '門診', '報到',
];

export function hasDepartureSignal(text: string): boolean {
  return DEPARTURE_SIGNALS.some((s) => text.includes(s));
}

// 模板關鍵字對照(順序重要 — 先匹配更具體的)。只決定「對到哪個模板」,
//   是否觸發由 hasDepartureSignal 把關,所以活動名詞(開會/會議)留著無妨。
export const TEMPLATE_KEYWORDS: Array<{ template: string; keywords: string[] }> = [
  { template: '跑步', keywords: ['跑步', '晨跑', '夜跑', '健身', '運動', '慢跑'] },
  { template: '上班', keywords: ['上班', '進公司', '到公司', '開會', '會議', '辦公室'] },
  { template: '夜出', keywords: ['夜出', '聚餐', '宵夜', '酒'] },
  { template: '辦事', keywords: ['辦事', '繳費', '銀行', '郵局', '醫院', '看診', '拜訪'] },
];

/** 文字對到哪個情境模板名(無 → null)。輸入會自動轉小寫比對。 */
export function matchTemplateName(text: string): string | null {
  const t = text.toLowerCase();
  for (const { template, keywords } of TEMPLATE_KEYWORDS) {
    if (keywords.some((kw) => t.includes(kw.toLowerCase()))) return template;
  }
  return null;
}

/** 文字對到的【所有】情境模板名(情境疊加用:一句同時命中多個就全收)。 */
export function matchTemplateNames(text: string): string[] {
  const t = text.toLowerCase();
  return TEMPLATE_KEYWORDS
    .filter(({ keywords }) => keywords.some((kw) => t.includes(kw.toLowerCase())))
    .map(({ template }) => template);
}
