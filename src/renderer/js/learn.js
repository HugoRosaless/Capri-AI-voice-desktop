// Capri aprende sobre la marcha:
//   1. Órdenes que le enseñas hablando: «Capri, cuando diga modo relax, abre YouTube y ponme un vídeo de lluvia».
//      Se guardan (config «macros») y desde entonces las hace al oír esa frase.
//   2. Recuerdos automáticos: cada pocas frases le pide a su modelo que apunte lo importante de ti (config «learned»),
//      y lo tiene en cuenta en las conversaciones siguientes.
//   3. Su voz: «Capri, calla», «no hables», «habla en voz alta».
import { actionIntent } from './actions.js';

const plain = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[¿?¡!.,;:"«»]/g, ' ').replace(/\s+/g, ' ').trim();
const LEAD = /^(?:(?:oye|eh|venga|vale|bueno|porfa|por favor|capri)\s+)*/;
const MAX_LEARNED = 80;
const EXTRACT_EVERY = 4; // mensajes tuyos entre un repaso y otro

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Learner {
  constructor({ host, chat }) {
    this.host = host;
    this.chat = chat;
    this.macros = [];   // [{ trigger, steps: [texto], made }]
    this.learned = [];  // [frases sobre ti]
    this.speak = true;
    this.sinceExtract = 0;
    this.extracting = false;
    host.getConfig().then((cfg) => this.configure(cfg)).catch(() => {});
  }

  configure(cfg) {
    this.macros = Array.isArray(cfg?.macros) ? cfg.macros : [];
    this.learned = Array.isArray(cfg?.learned) ? cfg.learned : [];
    this.speak = cfg?.speak !== false;
  }

  // ── Órdenes de este módulo (antes que nada). Devuelve { ok, line, silent? } o null. ──
  async local(raw) {
    const text = plain(raw).replace(LEAD, '');
    if (!text) return null;

    // su voz
    if (/^(?:calla(?:te)?|silencio|para de hablar|deja de hablar|shh+|basta)$/.test(text)) {
      await this.host.stopSpeaking?.();
      return { ok: true, line: '🤐', silent: true };
    }
    if (/^(?:no hables|no me hables|habla(?:me)? sin voz|quita(?:te)? la voz|sin voz|modo silencio)$/.test(text)) {
      this.speak = false;
      await this.host.stopSpeaking?.();
      await this.host.setConfig({ speak: false });
      return { ok: true, line: 'Vale, ya no hablo en voz alta. Para volver: «Capri, habla en voz alta».', silent: true };
    }
    if (/^(?:habla(?:me)?(?: en voz alta)?|pon(?:te)? la voz|activa la voz|con voz)$/.test(text)) {
      this.speak = true;
      await this.host.setConfig({ speak: true });
      return { ok: true, line: 'Vale, vuelvo a hablarte en voz alta.' };
    }

    // cerebro: modo experto (Claude Code), modo normal (su IA local), modo agente (herramientas MCP)
    if (/^(?:activa |pon |ponte en |cambia a )?(?:el )?modo experto$/.test(text)) {
      const r = await this.host.useProvider({ provider: 'claude' }).catch((e) => ({ ok: false, error: e.message }));
      this.chat.close?.();
      return r.ok
        ? { ok: true, line: 'Modo experto: ahora piensa Claude Code y puede trabajar de verdad en tu PC. Para volver: «Capri, modo normal».' }
        : { ok: false, line: `No puedo pasar a modo experto: ${r.error || 'no encuentro Claude Code'}. Instálalo y vuelve a probar.` };
    }
    if (/^(?:activa |pon |vuelve al |vuelve a |cambia a )?(?:el )?modo normal$/.test(text)) {
      const r = await this.host.useProvider({ provider: 'ollama' }).catch((e) => ({ ok: false, error: e.message }));
      await this.host.setConfig({ agentMode: true });
      this.chat.close?.();
      return { ok: r.ok, line: r.ok ? 'Modo normal: vuelvo a pensar con mi IA local (con mis herramientas).' : `No puedo volver: ${r.error || 'Ollama no responde'}.` };
    }
    if (/^(?:desactiva|quita|apaga) (?:el )?modo agente$/.test(text)) {
      await this.host.setConfig({ agentMode: false });
      return { ok: true, line: 'Modo agente apagado: solo charlo (y las órdenes de siempre).' };
    }
    if (/^(?:activa|pon|enciende) (?:el )?modo agente$/.test(text)) {
      await this.host.setConfig({ agentMode: true });
      return { ok: true, line: 'Modo agente encendido: puedo usar mis herramientas cuando haga falta.' };
    }
    if (/^(?:que|cuales) herramientas tienes|que (?:mas )?(?:puedes|sabes) hacer con (?:tus )?herramientas/.test(text)) {
      const r = await this.host.mcpTools?.().catch(() => null);
      const list = Object.entries(r?.servers || {}).map(([k, n]) => `${k} (${n})`);
      if (!list.length) return { ok: true, line: `Ahora mismo no tengo herramientas cargadas. Se añaden en ${r?.file || 'mcp.json'}.` };
      return { ok: true, line: `Tengo: ${list.join(', ')}. Modo agente ${r.agentMode ? 'encendido' : 'apagado'}, pensando con ${r.provider === 'claude' ? 'Claude Code' : r.model}.` };
    }

    // recuerdos
    if (/^(?:olvida|borra) (?:todo )?lo que (?:sabes|has aprendido) de mi$/.test(text)) {
      this.learned = [];
      await this.host.setConfig({ learned: [] });
      return { ok: true, line: 'Hecho: he olvidado lo que había aprendido de ti (lo que me pediste recordar sigue).' };
    }

    // órdenes enseñadas: listar, olvidar
    if (/^(?:que|cuales) (?:ordenes|cosas|comandos) (?:te he ensenado|sabes|has aprendido)/.test(text)) {
      if (!this.macros.length) return { ok: true, line: 'Aún no me has enseñado ninguna orden. Prueba: «Capri, cuando diga modo relax, abre YouTube y ponme un vídeo de lluvia».' };
      return { ok: true, line: `Me has enseñado: ${this.macros.map((m) => `«${m.trigger}»`).join(', ')}.` };
    }
    const forget = /^(?:olvida|borra|elimina) (?:la )?(?:orden|frase|comando) (.+)$/.exec(text);
    if (forget) {
      const key = plain(forget[1]).replace(/^(?:de |que )/, '');
      const before = this.macros.length;
      this.macros = this.macros.filter((m) => plain(m.trigger) !== key);
      if (this.macros.length === before) return { ok: false, line: `No tengo ninguna orden «${forget[1]}».` };
      await this.host.setConfig({ macros: this.macros });
      return { ok: true, line: `Olvidada la orden «${forget[1]}».` };
    }

    // enseñar: «cuando diga X, haz Y»
    const pc = String(raw || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[¿?¡!.;:"«»]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:(?:oye|eh|venga|vale|bueno|porfa|por favor|capri)\s*,?\s*)+/, '');
    let teach = /^(?:aprende (?:que )?|apunta (?:que )?|recuerda (?:que )?)?cuando (?:te )?(?:diga|digo|dire)s? (?:que )?(.+?)(?:\s*,\s*| tienes que | debes | quiero que | haz | hazme | entonces )(.+)$/.exec(pc);
    if (!teach) {
      // sin coma: «cuando diga buenas noches para el automático y apaga el ordenador» → corta donde empieza la acción
      const m = /^(?:aprende (?:que )?|apunta (?:que )?)?cuando (?:te )?(?:diga|digo|dire)s? (?:que )?(.+)$/.exec(pc);
      const at = m && /\s(?:abre|abrir|cierra|cerrar|activa|para|apaga|pon|lanza|inicia|arranca|espera|desactiva|escribe|pulsa|coloca|deten)\b/.exec(m[1]);
      if (at) teach = [null, m[1].slice(0, at.index), m[1].slice(at.index + 1)];
    }
    if (teach) return this.teach(teach[1].trim(), teach[2].trim());

    // una orden enseñada
    // «modo relax», «activa modo relax», «pon el modo relax ya»… valen igual
    const bare = (t) => t.replace(/^(?:activa(?:me)?|activar|pon(?:me)?|poner|arranca(?:me)?|inicia(?:me)?|haz(?:me)?|ejecuta|lanza|empieza|entra en|entra al|vamos con|dale al?)\s+/, '')
      .replace(/^(?:el |la |los |las )/, '').replace(/^modo\s+/, '').replace(/\s+(?:ya|ahora|por favor|porfa)$/, '').trim();
    const said = bare(text);
    const macro = this.macros.find((m) => {
      const key = plain(m.trigger);
      return text === key || said === bare(key);
    });
    if (macro) return this.run(macro);
    return null;
  }

  async teach(trigger, body) {
    if (!body) return { ok: false, line: '¿Y qué hago cuando lo digas? Ejemplo: «Capri, cuando diga modo relax, abre YouTube y ponme un vídeo de lluvia».' };
    const steps = this.splitSteps(body);
    const bad = [];
    for (const step of steps) if (!(await this.understood(step))) bad.push(step);
    if (!steps.length || bad.length) {
      return { ok: false, line: `No sé hacer ${bad.length ? `«${bad.join('», «')}»` : 'eso'}. Puedo usar órdenes como abrir apps, webs o iconos del escritorio, buscar en Google o YouTube, poner un vídeo, cerrar Chrome, apagar el ordenador o «espera 5 segundos».` };
    }
    const clean = trigger.replace(/^["«]|["»]$/g, '').trim();
    this.macros = [...this.macros.filter((m) => plain(m.trigger) !== plain(clean)), { trigger: clean, steps, made: Date.now() }];
    await this.host.setConfig({ macros: this.macros });
    return { ok: true, line: `Aprendido: cuando digas «${clean}» haré ${steps.length} ${steps.length === 1 ? 'cosa' : 'cosas'}: ${steps.join(' → ')}.` };
  }

  // «abre Gmail y YouTube, y luego pon un vídeo de lluvia» → pasos sueltos
  splitSteps(body) {
    const raw = body.split(/\s*(?:,|;|\by luego\b|\by despu[eé]s\b|\bdespu[eé]s\b|\by\b)\s*/i).map((s) => s.trim()).filter(Boolean);
    const steps = [];
    let verb = '';
    for (const piece of raw) {
      const first = piece.split(/\s+/)[0];
      const hasVerb = actionIntent(piece) || /^(abre|abrir|cierra|cerrar|activa|para|apaga|pon|lanza|inicia|arranca|espera|quita|desactiva|escribe|pulsa|coloca)/i.test(piece);
      if (hasVerb) { verb = first; steps.push(piece); } else if (verb) steps.push(`${verb} ${piece}`);
      else steps.push(piece);
    }
    return steps;
  }

  async understood(step) {
    if (/^espera\s+\d+/i.test(plain(step))) return true;
    if (actionIntent(step)) return true;
    const open = /^(?:abre(?:me)?|abrir|lanza|inicia|arranca|pon)\s+(?:el |la |los |las )?(.+)$/i.exec(step.trim());
    if (open) return Boolean(await this.host.findLaunch(open[1]).catch(() => null));
    return false;
  }

  async run(macro) {
    const done = [];
    for (const step of macro.steps) {
      const wait = /^espera\s+(\d+)/.exec(plain(step));
      if (wait) { await sleep(Math.min(120, Number(wait[1])) * 1000); continue; }
      const intent = actionIntent(step);
      if (intent) {
        const res = await this.host.actions(intent).catch((e) => ({ ok: false, line: String(e?.message || e) }));
        done.push(res.ok ? '✓' : `✗ ${res.line}`);
        continue;
      }
      const open = /^(?:abre(?:me)?|abrir|lanza|inicia|arranca|pon)\s+(?:el |la |los |las )?(.+)$/i.exec(step.trim());
      const item = open && (await this.host.findLaunch(open[1]).catch(() => null));
      if (item) {
        const res = await this.host.launch(item);
        done.push(res.ok ? '✓' : `✗ ${step}`);
      } else done.push(`✗ ${step}`);
    }
    const fails = done.filter((d) => d.startsWith('✗'));
    return { ok: !fails.length, line: fails.length ? `«${macro.trigger}»: ${fails.join(' · ')}` : `Hecho: «${macro.trigger}».` };
  }

  // ── Recuerdos automáticos ──
  personal() {
    const out = [
      // que no finja: lo que hace de verdad lo hace el programa antes de preguntarle a ella
      'Important: you can only do things on the PC through the tools you are given in this conversation (if any). Never say you did something that no tool confirmed. If the user asks for an action you have no tool for and nothing was done, say you do not know how to do that yet and that they can teach you («Capri, cuando diga X, haz Y») or give you tools (mcp.json).',
    ];
    if (this.macros.length) out.push(`Commands the user has taught you (they run when the user says them): ${this.macros.map((m) => `«${m.trigger}»`).join(', ')}.`);
    if (this.learned.length) out.push(`Things you have learned about the user over time (use them naturally when relevant, never recite the list):\n${this.learned.map((m) => `- ${m}`).join('\n')}`);
    return out;
  }

  async heard(history) {
    if (this.chat.agent) return;
    this.sinceExtract += 1;
    if (this.sinceExtract < EXTRACT_EVERY || this.extracting) return;
    this.sinceExtract = 0;
    this.extracting = true;
    try {
      const talk = history.slice(-12).map((m) => `${m.role === 'user' ? 'Usuario' : 'Capri'}: ${m.content}`).join('\n');
      const known = this.learned.length ? `Ya sabes esto (no lo repitas):\n${this.learned.map((m) => `- ${m}`).join('\n')}\n\n` : '';
      const messages = [
        { role: 'system', content: 'Extraes recuerdos duraderos sobre el usuario de una conversación. Responde SOLO con un array JSON de frases cortas en español, en tercera persona («Le gusta…», «Trabaja en…», «Su perro se llama…»). Solo hechos útiles a largo plazo (gustos, rutinas, personas, proyectos, metas, cómo quiere que le hables). Nada de lo que solo importa hoy, nada que no haya dicho el usuario, nada de datos sensibles (contraseñas, cuentas, salud). Si no hay nada nuevo: []' },
        { role: 'user', content: `${known}Conversación:\n${talk}` },
      ];
      const res = await this.host.chatSend({ id: `learn-${Date.now()}`, messages });
      if (!res?.ok) return;
      const json = /\[[\s\S]*\]/.exec(res.text || '')?.[0];
      if (!json) return;
      let facts = [];
      try { facts = JSON.parse(json); } catch { return; }
      facts = facts.filter((f) => typeof f === 'string').map((f) => f.trim()).filter((f) => f.length >= 6 && f.length <= 160);
      if (!facts.length) return;
      const seen = new Set(this.learned.map(plain));
      const fresh = facts.filter((f) => !seen.has(plain(f)));
      if (!fresh.length) return;
      this.learned = [...this.learned, ...fresh].slice(-MAX_LEARNED);
      await this.host.setConfig({ learned: this.learned });
    } catch {
      // un repaso que falla no importa: el siguiente lo intenta otra vez
    } finally {
      this.extracting = false;
    }
  }
}
