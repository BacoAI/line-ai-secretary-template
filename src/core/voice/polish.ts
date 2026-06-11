/**
 * 語音轉文字後處理 — Haiku 修正中文錯字,評估信心度
 *
 * 輸入:Whisper 原文(可能有錯字、同音字、破碎)
 * 輸出:{ confidence, corrected, candidates }
 *   - high   → 直接用 corrected
 *   - medium/low → 讓使用者選 candidates
 */

import type { Env } from '../types';
import { buildHaiquContext } from './vocabulary';
import { calculateClaudeCost, logCost } from '../safety/budget';

export interface PolishResult {
  confidence: 'high' | 'medium' | 'low';
  corrected: string;       // 主要修正版本
  candidates: string[];    // 候選版本(low/medium 時用)
  raw: string;             // Whisper 原文(quote 給使用者看)
}

export async function polishTranscript(
  env: Env,
  rawTranscript: string,
  conversationContext?: string
): Promise<PolishResult> {
  const context = buildHaiquContext(env);
  const sys = [
    '你是台灣中文語音辨識修正器。',
    '輸入:Whisper 轉的中文文字(可能有錯字 / 同音字 / 破碎)',
    '輸出:JSON 物件 { "confidence": "high|medium|low", "corrected": "...", "candidates": ["...", "..."] }',
    '',
    '評估規則:',
    '- high:原文已通順,只需小修(<3 個字)或不用修',
    '- medium:有明顯錯字但意圖可推測,你給 2~3 個候選',
    '- low:破碎到無法確定,給 3 個你能想到的可能解讀',
    '',
    '修正原則:',
    '- 依台灣慣用詞修(品牌、人名、術語)',
    '- 保留語氣,別改成不同意思',
    '- corrected 一定要給(取你最有信心的),candidates 是次要選項',
    '',
    '使用者背景:',
    context,
    '',
    '只回 JSON,不要其他文字。',
  ].join('\n');

  const userMsg = [
    `Whisper 原文:「${rawTranscript}」`,
    conversationContext ? `\n最近對話脈絡:\n${conversationContext}` : '',
    '\n請輸出 JSON。',
  ].join('');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        system: sys,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!r.ok) {
      console.warn('[polish] Haiku failed', r.status);
      return { confidence: 'high', corrected: rawTranscript, candidates: [], raw: rawTranscript };
    }
    const d: any = await r.json();
    // v118: 補 logCost — polish 用的是 Haiku,單次成本小但累積也算
    try {
      const usage = d.usage || {};
      const inTok = usage.input_tokens ?? 0;
      const outTok = usage.output_tokens ?? 0;
      const cachedTok = usage.cache_read_input_tokens ?? 0;
      const writeTok = usage.cache_creation_input_tokens ?? 0;
      const cost = calculateClaudeCost('claude-haiku-4-5', inTok, outTok, cachedTok, writeTok);
      await logCost(env, {
        userId: '_polish', service: 'anthropic', operation: 'voice-polish',
        model: 'claude-haiku-4-5',
        inputTokens: inTok, outputTokens: outTok, cachedTokens: cachedTok, costUsd: cost,
        taskContext: 'voice-polish',
      });
    } catch (e) { console.warn('[polish] logCost failed', e); }
    const text = (d.content?.[0]?.text ?? '').trim();
    // 抓 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[polish] no JSON in response:', text.substring(0, 100));
      return { confidence: 'high', corrected: rawTranscript, candidates: [], raw: rawTranscript };
    }
    const parsed: any = JSON.parse(jsonMatch[0]);
    return {
      confidence: parsed.confidence ?? 'high',
      corrected: parsed.corrected ?? rawTranscript,
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
      raw: rawTranscript,
    };
  } catch (e) {
    console.error('[polish] exception:', e);
    return { confidence: 'high', corrected: rawTranscript, candidates: [], raw: rawTranscript };
  }
}
