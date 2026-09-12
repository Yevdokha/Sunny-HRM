// Тонкий спільний клієнт для звернень до ШІ. Використовується і
// чатом-помічником, і оцінкою резюме кандидатів.
//
// Підтримує два провайдери — обирається автоматично за тим, який ключ
// заданий у .env (GEMINI_API_KEY має пріоритет, бо в нього справді
// безкоштовний і безстроковий рівень без картки; ANTHROPIC_API_KEY —
// опційна альтернатива, якщо в когось уже є платний доступ до Claude).
// Якщо жодного ключа немає — функції ШІ повертають зрозуміле повідомлення
// замість помилки 500, решта системи працює як завжди.

export function aiProvider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}
export const aiEnabled = () => aiProvider() !== null;

export class AiDisabledError extends Error {
  constructor() {
    super('ШІ-помічник не налаштований: додайте GEMINI_API_KEY (безкоштовно, Google AI Studio) або ANTHROPIC_API_KEY у файл .env і перезапустіть backend.');
    this.code = 'AI_DISABLED';
  }
}

async function askGemini({ system, messages, maxTokens }) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: system }] },
      // thinkingLevel:'low' — це чат-помічник і оцінка резюме, не складна
      // багатокрокова задача; без цього модель може витратити весь ліміт
      // токенів на прихованих "роздумах" і повернути порожню відповідь.
      generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingLevel: 'low' } },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Помилка звернення до Gemini (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) {
    // Найчастіша причина порожньої відповіді — спрацював фільтр безпеки Gemini.
    const reason = cand?.finishReason ? ` (finishReason: ${cand.finishReason})` : '';
    throw new Error('Gemini повернув порожню відповідь' + reason + '.');
  }
  return text;
}

async function askAnthropic({ system, messages, maxTokens }) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Помилка звернення до Claude (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('Claude повернув порожню відповідь.');
  return text;
}

// messages: [{role:'user'|'assistant', content:'...'}], у хронологічному порядку.
export async function askAI({ system, messages, maxTokens = 1024 }) {
  const provider = aiProvider();
  if (!provider) throw new AiDisabledError();
  if (provider === 'gemini') return askGemini({ system, messages, maxTokens });
  return askAnthropic({ system, messages, maxTokens });
}
