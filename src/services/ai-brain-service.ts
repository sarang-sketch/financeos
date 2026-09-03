import fs from 'fs';

let cachedKeys: { groqKey: string; openrouterKey: string; geminiKey: string } | null = null;

export function getApiKeys() {
  if (cachedKeys) return cachedKeys;
  let groqKey = process.env.GROQ_API_KEY || '';
  let openrouterKey = process.env.OPENROUTER_API_KEY || '';
  let geminiKey = process.env.GEMINI_API_KEY || '';

  if ((!groqKey || !openrouterKey) && fs.existsSync('.env.local')) {
    const envContent = fs.readFileSync('.env.local', 'utf8');
    const gMatch = envContent.match(/GROQ_API_KEY=([^\r\n]+)/);
    const oMatch = envContent.match(/OPENROUTER_API_KEY=([^\r\n]+)/);
    const mMatch = envContent.match(/GEMINI_API_KEY=([^\r\n]+)/);
    if (gMatch && gMatch[1] && !groqKey) groqKey = gMatch[1].trim();
    if (oMatch && oMatch[1] && !openrouterKey) openrouterKey = oMatch[1].trim();
    if (mMatch && mMatch[1] && !geminiKey) geminiKey = mMatch[1].trim();
  }

  cachedKeys = { groqKey, openrouterKey, geminiKey };
  return cachedKeys;
}

export async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const { openrouterKey, groqKey } = getApiKeys();

  // Try OpenRouter first (GPT-4o-mini is robust, grounded, fast)
  if (openrouterKey) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openrouterKey}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 800,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content;
        if (reply && reply.trim().length > 0) {
          return reply.trim();
        }
      }
    } catch {
      // Fall through to secondary
    }
  }

  // Try Groq
  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 800,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content;
        if (reply && reply.trim().length > 0) {
          return reply.trim();
        }
      }
    } catch {
      // Fall through
    }
  }

  return '';
}
