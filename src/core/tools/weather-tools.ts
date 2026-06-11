/**
 * 天氣工具(給 Claude 用)— get_weather / set_weather_location
 *
 * 用 Open-Meteo(免費、免金鑰)逐小時預報,聚合成 5 個時段:
 *   清晨(05-07)/ 早上(08-11)/ 中午(12-14)/ 傍晚(15-18)/ 晚上(19-22)
 * 每段給:溫度範圍 + 最高降雨機率 + 天氣狀況。**真實資料,不用模型腦補。**
 *
 * 地點:存成 per-user 偏好(`UserPreferences.weatherLocation`),**使用者用 LINE 口語就能改**
 *       (例:「天氣地點改成台中」→ Claude 呼叫 set_weather_location)。沒設 → 台北。
 *       商品化:不寫死任何地點;每個學員各自用 LINE 設自己的。
 */

import type { Env } from '../types';
import { localDateStr } from '../util/time';
import { getPreferences, setPreferences } from '../preferences/store';

export const WEATHER_TOOLS = [
  {
    name: 'get_weather',
    description:
      '查天氣(逐時段:清晨/早上/中午/傍晚/晚上,真實逐時預報)。使用者問「今天/明天天氣」' +
      '「明天會不會下雨」這類 → 用這個,不要用 web_search 查天氣。' +
      'day 預設明天;location 不填則用使用者設定的預設地點,只有使用者在這句話指明城市(如「台中天氣」)才填。',
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'string', enum: ['today', 'tomorrow'], description: '今天或明天,預設 tomorrow' },
        location: { type: 'string', description: '可選:城市/地區名(如「台中」「高雄左營」)。不填用使用者預設地點' },
      },
      required: [],
    },
  },
  {
    name: 'set_weather_location',
    description:
      '設定使用者的「天氣預設地點」。使用者說「天氣地點改成 X」「我在 X」「我搬到 X 了」' +
      '「以後天氣都查 X」這類 → 用這個存起來,之後問天氣不指定城市就用這個。',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市/地區名,例:「台中」「高雄左營」' },
      },
      required: ['location'],
    },
  },
];

/** WMO weather_code → 中文狀況 */
function wmoToZh(code: number): string {
  if (code === 0) return '晴';
  if (code === 1) return '晴時多雲';
  if (code === 2) return '多雲';
  if (code === 3) return '陰';
  if (code === 45 || code === 48) return '有霧';
  if (code >= 51 && code <= 57) return '毛毛雨';
  if (code >= 61 && code <= 65) return '下雨';
  if (code === 66 || code === 67) return '凍雨';
  if (code >= 71 && code <= 77) return '下雪';
  if (code >= 80 && code <= 82) return '陣雨';
  if (code === 85 || code === 86) return '陣雪';
  if (code >= 95) return '雷雨';
  return '未知';
}

interface Period { name: string; hours: number[] }
const PERIODS: Period[] = [
  { name: '清晨', hours: [5, 6, 7] },
  { name: '早上', hours: [8, 9, 10, 11] },
  { name: '中午', hours: [12, 13, 14] },
  { name: '傍晚', hours: [15, 16, 17, 18] },
  { name: '晚上', hours: [19, 20, 21, 22] },
];

/** 取得使用者的天氣預設地點(口語可改;沒設 → env 預設 → 台北) */
async function defaultLocation(env: Env, userId: string): Promise<string> {
  try {
    const prefs = await getPreferences(env, userId);
    if (prefs.weatherLocation) return prefs.weatherLocation;
  } catch { /* 讀偏好失敗就走 fallback */ }
  return ((env as any).WEATHER_DEFAULT_LOCATION || '台北').toString();
}

/**
 * 台灣主要縣市座標表(Open-Meteo geocoding 對中文台灣地名常查無/誤判到中國同名地,
 * 所以台灣縣市直接用內建表,可靠又快)。key 用最短可辨識名,輸入含此名即命中(如「高雄左營」含「高雄」)。
 */
const TW_CITIES: Array<{ k: string; lat: number; lon: number; label: string }> = [
  { k: '台北', lat: 25.04, lon: 121.56, label: '台北市' },
  { k: '臺北', lat: 25.04, lon: 121.56, label: '台北市' },
  { k: '新北', lat: 25.01, lon: 121.46, label: '新北市' },
  { k: '基隆', lat: 25.13, lon: 121.74, label: '基隆市' },
  { k: '桃園', lat: 24.99, lon: 121.30, label: '桃園市' },
  { k: '新竹', lat: 24.80, lon: 120.97, label: '新竹' },
  { k: '苗栗', lat: 24.56, lon: 120.82, label: '苗栗縣' },
  { k: '台中', lat: 24.15, lon: 120.67, label: '台中市' },
  { k: '臺中', lat: 24.15, lon: 120.67, label: '台中市' },
  { k: '彰化', lat: 24.08, lon: 120.54, label: '彰化縣' },
  { k: '南投', lat: 23.91, lon: 120.69, label: '南投縣' },
  { k: '雲林', lat: 23.71, lon: 120.43, label: '雲林縣' },
  { k: '嘉義', lat: 23.48, lon: 120.45, label: '嘉義' },
  { k: '台南', lat: 22.99, lon: 120.21, label: '台南市' },
  { k: '臺南', lat: 22.99, lon: 120.21, label: '台南市' },
  { k: '高雄', lat: 22.62, lon: 120.31, label: '高雄市' },
  { k: '屏東', lat: 22.68, lon: 120.49, label: '屏東縣' },
  { k: '宜蘭', lat: 24.76, lon: 121.75, label: '宜蘭縣' },
  { k: '花蓮', lat: 23.98, lon: 121.60, label: '花蓮縣' },
  { k: '台東', lat: 22.76, lon: 121.14, label: '台東縣' },
  { k: '臺東', lat: 22.76, lon: 121.14, label: '台東縣' },
  { k: '澎湖', lat: 23.57, lon: 119.58, label: '澎湖縣' },
  { k: '金門', lat: 24.43, lon: 118.32, label: '金門縣' },
  { k: '馬祖', lat: 26.16, lon: 119.95, label: '連江縣(馬祖)' },
  { k: '連江', lat: 26.16, lon: 119.95, label: '連江縣(馬祖)' },
];

/** 從時區粗推國家碼,用來給 geocoding 偏好(避免中文地名 match 到他國同名地) */
function tzCountry(tz: string): string | null {
  if (tz.includes('Taipei')) return 'TW';
  if (tz.includes('Tokyo')) return 'JP';
  if (tz.includes('Seoul')) return 'KR';
  if (tz.includes('Hong_Kong')) return 'HK';
  if (tz.includes('Singapore')) return 'SG';
  if (tz.includes('Shanghai') || tz.includes('Chongqing') || tz.includes('Urumqi')) return 'CN';
  return null;
}

/** 城市名 → 座標 + 正式名;先查台灣表,再 fallback Open-Meteo geocoding(用時區偏好國家);失敗回 null */
async function geocode(name: string, env: Env): Promise<{ lat: number; lon: number; label: string } | null> {
  const n = name.trim();
  for (const c of TW_CITIES) {
    if (n.includes(c.k)) return { lat: c.lat, lon: c.lon, label: c.label };
  }
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(n)}&count=5&language=zh&format=json`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j: any = await r.json();
    const results = j.results || [];
    if (results.length === 0) return null;
    const prefCC = tzCountry(env.TIMEZONE || 'Asia/Taipei');
    const hit = (prefCC && results.find((x: any) => x.country_code === prefCC)) || results[0];
    return { lat: hit.latitude, lon: hit.longitude, label: hit.name + (hit.admin1 ? `(${hit.admin1})` : '') + (hit.country_code && hit.country_code !== prefCC ? `,${hit.country}` : '') };
  } catch {
    return null;
  }
}

export async function executeWeatherTool(env: Env, toolName: string, input: any, userId: string): Promise<string> {
  // 設定預設地點
  if (toolName === 'set_weather_location') {
    const loc = (input?.location || '').toString().trim();
    if (!loc) return '沒收到地點,請說清楚要設哪個城市';
    // 先試 geocode 確認認得這地名,認不得就提醒使用者換個說法(不亂存)
    const g = await geocode(loc, env);
    if (!g) return `找不到「${loc}」這個地點,可以換個說法嗎?(例:「台中」「高雄左營」「新竹市」)`;
    await setPreferences(env, userId, { weatherLocation: loc });
    return `✓ 已把天氣預設地點設成「${loc}」(對應到 ${g.label})。之後問天氣不指定城市就會查這裡。`;
  }

  if (toolName !== 'get_weather') return `Unknown tool: ${toolName}`;

  const tz = env.TIMEZONE || 'Asia/Taipei';
  const day: 'today' | 'tomorrow' = input?.day === 'today' ? 'today' : 'tomorrow';
  const wantName = input?.location ? input.location.toString() : await defaultLocation(env, userId);

  // 1. 地點 → 座標
  let geo = await geocode(wantName, env);
  if (!geo) {
    geo = { lat: 25.0375, lon: 121.5637, label: `${wantName}(座標解析失敗,改用台北附近)` };
  }

  // 2. 逐小時預報(今天+明天)
  const fUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&hourly=temperature_2m,precipitation_probability,weather_code&timezone=${encodeURIComponent(tz)}&forecast_days=2`;
  let data: any;
  try {
    const r = await fetch(fUrl);
    if (!r.ok) return `天氣查詢失敗(${r.status}),請稍後再試`;
    data = await r.json();
  } catch (e: any) {
    return `天氣查詢失敗:${e?.message ?? e}`;
  }
  const h = data.hourly;
  if (!h?.time?.length) return '天氣資料異常(無逐時資料)';

  // 3. 目標日期(使用者時區的今天 / 明天)
  const offsetMs = (day === 'today' ? 0 : 1) * 86400000;
  const targetDate = localDateStr(env, Date.now() + offsetMs); // YYYY-MM-DD

  const byHour = new Map<number, { temp: number; pop: number; code: number }>();
  for (let i = 0; i < h.time.length; i++) {
    const t: string = h.time[i];
    if (!t.startsWith(targetDate)) continue;
    const hh = parseInt(t.slice(11, 13), 10);
    byHour.set(hh, { temp: h.temperature_2m[i], pop: h.precipitation_probability[i] ?? 0, code: h.weather_code[i] ?? 0 });
  }
  if (byHour.size === 0) return `查不到 ${targetDate} 的逐時資料(可能超出預報範圍)`;

  // 4. 聚合成 5 時段
  const dayLabel = day === 'today' ? '今天' : '明天';
  const lines = [`【${geo.label} ${dayLabel}(${targetDate})天氣 — 逐時段】`];
  for (const p of PERIODS) {
    const pts = p.hours.map((hr) => byHour.get(hr)).filter(Boolean) as { temp: number; pop: number; code: number }[];
    if (pts.length === 0) {
      lines.push(`- ${p.name}:(無資料)`);
      continue;
    }
    const temps = pts.map((x) => x.temp);
    const tMin = Math.round(Math.min(...temps));
    const tMax = Math.round(Math.max(...temps));
    const popMax = Math.max(...pts.map((x) => x.pop));
    const codeMax = Math.max(...pts.map((x) => x.code)); // 取較「值得注意」的狀況(雨/雷雨碼較大)
    const tempStr = tMin === tMax ? `${tMin}°C` : `${tMin}~${tMax}°C`;
    lines.push(`- ${p.name}:${wmoToZh(codeMax)},${tempStr},降雨機率 ${popMax}%`);
  }
  lines.push('(資料來源:Open-Meteo;照實轉述,不要自行增減時段或數字)');
  return lines.join('\n');
}
