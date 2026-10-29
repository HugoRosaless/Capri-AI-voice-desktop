'use strict';

// Modo agente: su modelo local (Ollama) puede usar las herramientas de los servidores MCP, encadenándolas
// hasta acabar lo que le pides. Lo delicado (escribir, borrar, enviar, ejecutar…) pide tu «sí» antes.
// Necesita un modelo de Ollama que sepa usar herramientas (qwen3, gpt-oss, llama3.1…). Si el modelo no sabe,
// se avisa y se contesta como siempre.

const ollama = require('./ollama');
const mcp = require('./mcp');

const MAX_STEPS = 10;

const GUIDE = 'You can use tools to actually do things on the user\'s PC (files, browser…). Use them when the user '
  + 'asks for something that needs them; for plain chat just answer. Chain several tools if needed, check results, and '
  + 'when done answer briefly (in the user\'s language, in character) with what you did or found. Never claim you did '
  + 'something a tool did not confirm.';

let thinkOption = true; // se quita si el modelo no la entiende
async function post(model, messages, tools, signal) {
  const send = () => fetch(`${ollama.base()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false, ...(thinkOption ? { think: false } : {}), keep_alive: '15m', options: { temperature: 0.4, num_predict: 800 } }),
    signal,
  });
  let res = await send();
  let body = await res.text();
  if (!res.ok && thinkOption && /think/i.test(body)) { thinkOption = false; res = await send(); body = await res.text(); }
  let data = {};
  try { data = JSON.parse(body); } catch {}
  if (!res.ok) throw Object.assign(new Error(data.error || body.slice(0, 200) || `Ollama ${res.status}`), { status: res.status });
  return data.message || {};
}

// confirm(question) → Promise<boolean>; progress(text) → void
async function run({ model, messages, signal, confirm, progress }) {
  const tools = mcp.toolSchemas();
  const msgs = messages.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: `${m.content}\n${GUIDE}` } : m));
  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await post(model, msgs, tools, signal);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) return msg.content || '';
    msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const c of calls) {
      const id = c.function?.name;
      let args = c.function?.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      const t = mcp.find(id);
      let out;
      if (!t) out = `Error: no existe la herramienta ${id}`;
      else {
        const what = `${t.server} › ${t.name}`;
        const shown = JSON.stringify(args).slice(0, 220);
        const ok = !mcp.needsConfirm(t) || (await confirm(`¿Puedo hacer esto? ${what} ${shown}`));
        if (!ok) out = 'El usuario NO ha dado permiso: no se ha hecho. No lo intentes otra vez con otra herramienta.';
        else {
          progress?.(`⚙ ${what}…`);
          try {
            const r = await mcp.call(id, args);
            out = (r.isError ? 'Error: ' : '') + r.text;
          } catch (err) {
            out = `Error: ${err.message}`;
          }
        }
      }
      msgs.push({ role: 'tool', content: out, tool_name: id });
    }
  }
  return 'Lo dejo aquí: eran demasiados pasos. Dime si sigo.';
}

// ¿Este fallo es porque el modelo no sabe usar herramientas?
const noTools = (err) => /does not support tools|tools? (are )?not supported/i.test(String(err?.message || ''));

module.exports = { run, noTools };
