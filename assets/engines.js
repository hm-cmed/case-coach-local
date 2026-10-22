// =====================================================================
// engines.js — PC内のローカルAIサーバーとの通信
//   ・Ollama（ネイティブAPI /api/chat）
//   ・OpenAI互換サーバー（LM Studio, llama.cpp server など /v1/chat/completions）
// 接続先は localhost / 127.0.0.1 に限定（index.html の CSP でも二重に制限）
// =====================================================================

export const ENGINES = {
  ollama: { label: 'Ollama', defaultBase: 'http://localhost:11434' },
  openai: { label: 'OpenAI互換（LM Studio・llama.cpp など）', defaultBase: 'http://localhost:1234' },
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function normalizeBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  s = s.replace(/\/v1$/, '').replace(/\/api$/, '');
  return s;
}

export function isLocalBase(raw) {
  try {
    const u = new URL(normalizeBase(raw));
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname);
  } catch { return false; }
}

/** 接続に失敗したときに、原因の見当をつけるための例外 */
export class ConnectionError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

async function request(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    // CORS 拒否・未起動・ブラウザのローカルネットワーク許可なし、はすべてここに来る
    throw new ConnectionError('ローカルAIサーバーに接続できませんでした。', 'network');
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.clone().json(); detail = j.error?.message || j.error || ''; }
    catch { try { detail = (await res.text()).slice(0, 300); } catch { /* noop */ } }
    const kind = res.status === 404 ? 'notfound' : 'http';
    throw new ConnectionError(`サーバーがエラーを返しました（${res.status}）${detail ? '：' + detail : ''}`, kind);
  }
  return res;
}

async function* readLines(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) yield buf;
}

const stripDataUrl = s => String(s).replace(/^data:[^;]+;base64,/, '');

// ---------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------
const ollama = {
  async listModels(base) {
    const r = await request(`${base}/api/tags`);
    const j = await r.json();
    return (j.models || []).map(m => ({
      id: m.name,
      detail: [m.details?.parameter_size, m.details?.quantization_level].filter(Boolean).join('・'),
    })).sort((a, b) => a.id.localeCompare(b.id));
  },

  async modelInfo(base, model) {
    try {
      const r = await request(`${base}/api/show`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const j = await r.json();
      const caps = j.capabilities || [];
      let ctx = null;
      for (const [k, v] of Object.entries(j.model_info || {})) {
        if (k.endsWith('.context_length') && typeof v === 'number') ctx = v;
      }
      return { vision: caps.includes('vision'), thinking: caps.includes('thinking'), contextLength: ctx, known: true };
    } catch {
      return { vision: false, thinking: false, contextLength: null, known: false };
    }
  },

  async *chat({ base, model, messages, temperature, numCtx, thinkOff, info, signal }) {
    const body = {
      model,
      stream: true,
      keep_alive: '15m',
      messages: messages.map(m => {
        const o = { role: m.role, content: m.content };
        if (m.images?.length) o.images = m.images.map(stripDataUrl);
        return o;
      }),
      options: { temperature, num_ctx: numCtx },
    };
    // 思考（推論）機能を持つモデルだけに think:false を送る（gpt-oss は false を受け付けない）
    if (thinkOff && info?.thinking && !/^gpt-oss/i.test(model)) body.think = false;

    const r = await request(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    for await (const line of readLines(r.body)) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new ConnectionError(String(j.error), 'http');
      if (j.message?.thinking) yield { type: 'thinking', text: j.message.thinking };
      if (j.message?.content) yield { type: 'text', text: j.message.content };
      if (j.done) {
        yield {
          type: 'done',
          promptTokens: j.prompt_eval_count ?? null,
          outputTokens: j.eval_count ?? null,
          seconds: j.total_duration ? j.total_duration / 1e9 : null,
          truncated: j.done_reason === 'length',
        };
      }
    }
  },
};

// ---------------------------------------------------------------------
// OpenAI互換（LM Studio, llama.cpp server, vLLM など）
// ---------------------------------------------------------------------
const openai = {
  async listModels(base) {
    const r = await request(`${base}/v1/models`);
    const j = await r.json();
    return (j.data || []).map(m => ({ id: m.id, detail: '' })).sort((a, b) => a.id.localeCompare(b.id));
  },

  async modelInfo() {
    // 標準APIでは能力を問い合わせられないため、画像送信は設定で手動ONにする
    return { vision: null, thinking: false, contextLength: null, known: false };
  },

  async *chat({ base, model, messages, temperature, signal }) {
    const body = {
      model,
      stream: true,
      temperature,
      messages: messages.map(m => {
        if (!m.images?.length) return { role: m.role, content: m.content };
        return {
          role: m.role,
          content: [
            { type: 'text', text: m.content },
            ...m.images.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        };
      }),
    };
    const r = await request(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    let usage = null, finish = null;
    for await (const raw of readLines(r.body)) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new ConnectionError(String(j.error.message || j.error), 'http');
      const ch = j.choices?.[0];
      const d = ch?.delta || {};
      const think = d.reasoning_content || d.reasoning;
      if (think) yield { type: 'thinking', text: think };
      if (d.content) yield { type: 'text', text: d.content };
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (j.usage) usage = j.usage;
    }
    yield {
      type: 'done',
      promptTokens: usage?.prompt_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
      seconds: null,
      truncated: finish === 'length',
    };
  },
};

const IMPL = { ollama, openai };

export function engine(id) { return IMPL[id] || ollama; }

/**
 * <think>…</think> をモデルが本文中に出す場合に分離する（qwen 系の一部など）
 * @returns {{text:string, thinking:string}}
 */
export function splitThink(raw) {
  let thinking = '';
  const text = raw.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_, t) => { thinking += t; return ''; });
  return { text: text.replace(/^\s+/, ''), thinking };
}
