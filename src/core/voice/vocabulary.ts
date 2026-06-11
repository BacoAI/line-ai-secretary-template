/**
 * 常用詞庫 — 給 Whisper initial_prompt 跟 Haiku 後處理用,提升語音辨識準度。
 *
 * 拆兩層:
 *   - BASE_VOCABULARY:通用詞(工具/平台、通用功能詞、通用動作詞)— 對所有買家都適用,留在程式。
 *   - 個人詞(人名 / 品牌)由設定 env.PERSONAL_VOCABULARY(JSON)提供,跟通用詞合併。
 *     擁有者把自己的人名/品牌放在「自己(gitignored)的 wrangler.toml」;公開範本不帶 →
 *     只用通用詞庫(不洩漏任何人的私人人名/品牌)。
 */

import type { Env } from '../types';

interface VocabSet {
  people?: string[];
  brands?: string[];
  tools?: string[];
  projects?: string[];
  actions?: string[];
}

// 通用詞庫(非個人資料,所有買家共用)
const BASE_VOCABULARY: Required<Pick<VocabSet, 'tools' | 'projects' | 'actions'>> = {
  tools: ['Notion', 'Claude', 'LINE', 'Cloudflare', 'Tavily', 'Whisper', 'Anthropic', 'Teachify'],
  projects: ['LINE bot', 'AI 助理', 'AI 應用課程', '晨報', '提醒', '推播', '今日計畫', '週計畫', '工作記錄'],
  actions: ['剪輯', '剪映', '錄音', '細修', '校稿', '配音', '提醒', '撤回', '延後', '跳過', '已完成', '在做了'],
};

// 讀設定的個人詞庫;沒設 / 非合法 JSON → 空物件(只用通用詞)
function readPersonalVocab(env: Env): VocabSet {
  const raw = env.PERSONAL_VOCABULARY;
  if (!raw || typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw) as VocabSet;
  } catch {
    console.warn('[vocab] PERSONAL_VOCABULARY 非合法 JSON,忽略');
    return {};
  }
}

// 通用 + 個人合併
function mergedVocab(env: Env): Required<VocabSet> {
  const p = readPersonalVocab(env);
  return {
    people: p.people ?? [],
    brands: p.brands ?? [],
    tools: [...BASE_VOCABULARY.tools, ...(p.tools ?? [])],
    projects: [...BASE_VOCABULARY.projects, ...(p.projects ?? [])],
    actions: [...BASE_VOCABULARY.actions, ...(p.actions ?? [])],
  };
}

// 給 Whisper initial_prompt 用 — 1 個逗號分隔的長字串
export function buildWhisperPrompt(env: Env): string {
  const v = mergedVocab(env);
  const all = [...v.people, ...v.brands, ...v.tools, ...v.projects, ...v.actions];
  return `繁體中文 台灣慣用詞。常見專有名詞:${all.join('、')}。`;
}

// 給 Haiku 後處理用 — 結構化背景(空的類別自動略過)
export function buildHaiquContext(env: Env): string {
  const v = mergedVocab(env);
  const lines = ['使用者是台灣人,語音講繁體中文。'];
  if (v.people.length) lines.push(`常出現人名:${v.people.join('、')}`);
  if (v.brands.length) lines.push(`常出現品牌:${v.brands.join('、')}`);
  if (v.tools.length) lines.push(`常出現工具:${v.tools.join('、')}`);
  if (v.projects.length) lines.push(`常出現專案:${v.projects.join('、')}`);
  if (v.actions.length) lines.push(`常出現動作:${v.actions.join('、')}`);
  return lines.join('\n');
}
