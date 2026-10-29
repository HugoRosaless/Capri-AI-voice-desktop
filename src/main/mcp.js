'use strict';

// Capri como cliente MCP (Model Context Protocol): el «enchufe universal» de herramientas para IAs.
// Cada servidor de mcp.json (en la carpeta de Capri) es un programa que le da herramientas: archivos,
// navegador, Gmail, Spotify, GitHub, bases de datos… Hay miles ya hechos (github.com/modelcontextprotocol/servers,
// smithery.ai, mcp.so). Formato, el mismo que Claude Desktop:
//   { "servers": { "archivos": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\yo\\Documents"] } } }
// Se habla con cada servidor por su entrada/salida estándar, en JSON-RPC 2.0 (un mensaje por línea).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROTOCOL = '2025-06-18';

function defaultConfig() {
  const home = os.homedir();
  return {
    // qué hace cada servidor lo explica su página; aquí, dos útiles para empezar
    servers: {
      archivos: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem',
          path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')],
      },
      navegador: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    },
    // herramientas que piden tu «sí» antes de hacerse (por parte de su nombre)
    confirm: ['write', 'edit', 'move', 'delete', 'remove', 'rename', 'create', 'send', 'post', 'upload', 'exec', 'run',
      'install', 'kill', 'evaluate', 'type', 'fill', 'submit', 'pay', 'buy', 'drop', 'update', 'insert'],
  };
}

class Server {
  constructor(name, spec, log) {
    this.name = name;
    this.spec = spec;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.buffer = '';
    this.child = null;
  }

  start() {
    const { command, args = [], env = {}, cwd } = this.spec;
    // con shell (Windows), las rutas con espacios van entre comillas
    const quoted = process.platform === 'win32' ? args.map((a) => (/\s/.test(String(a)) && !/^".*"$/.test(String(a)) ? `"${a}"` : String(a))) : args;
    this.child = spawn(command, quoted, {
      env: { ...process.env, ...env },
      cwd: cwd || os.homedir(),
      shell: process.platform === 'win32', // npx / uvx son .cmd en Windows
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', () => {}); // los servidores escriben ahí sus avisos
    this.child.on('error', (err) => this.failAll(err));
    this.child.on('exit', () => this.failAll(new Error(`el servidor «${this.name}» se ha cerrado`)));
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id) && (msg.result !== undefined || msg.error)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'error del servidor'));
        else resolve(msg.result);
      } else if (msg.id != null && msg.method) {
        // el servidor nos pregunta algo (p. ej. ping): se contesta vacío
        this.write({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    }
  }

  failAll(err) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
    this.pending.clear();
    this.tools = [];
  }

  write(obj) {
    try { this.child?.stdin.write(`${JSON.stringify(obj)}\n`); } catch {}
  }

  request(method, params, timeout = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`«${this.name}» no contesta (${method})`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async init() {
    this.start();
    // la primera vez npx descarga el servidor: se le da tiempo
    await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'capri', version: '1.0' } }, 180000);
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await this.request('tools/list', {});
    this.tools = (res.tools || []).map((t) => ({ ...t, server: this.name }));
    this.log(`MCP «${this.name}»: ${this.tools.length} herramientas`);
  }

  stop() {
    try { this.child?.kill(); } catch {}
  }
}

const servers = new Map();
let cfg = { servers: {}, confirm: [] };

function configFile(root) {
  return path.join(root, 'mcp.json');
}

// Arranca los servidores de mcp.json (lo crea con un ejemplo la primera vez). No bloquea a Capri.
async function start(root, log = () => {}) {
  const file = configFile(root);
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, JSON.stringify(defaultConfig(), null, 2)); } catch {}
  }
  try {
    cfg = { ...defaultConfig(), ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (err) {
    log(`mcp.json no válido: ${err.message}`);
    return;
  }
  for (const [name, spec] of Object.entries(cfg.servers || {})) {
    if (!spec || spec.disabled || !spec.command) continue;
    const s = new Server(name, spec, log);
    servers.set(name, s);
    s.init().catch((err) => log(`MCP «${name}» no arranca: ${err.message}`));
  }
}

function stop() {
  for (const s of servers.values()) s.stop();
  servers.clear();
}

// nombre para la IA: servidor__herramienta (solo letras, números, _ y -)
const toolId = (t) => `${t.server}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

function tools() {
  return [...servers.values()].flatMap((s) => s.tools);
}

// En el formato de «tools» de Ollama / OpenAI
function toolSchemas() {
  return tools().map((t) => ({
    type: 'function',
    function: {
      name: toolId(t),
      description: `[${t.server}] ${(t.description || t.name).slice(0, 400)}`,
      parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
    },
  }));
}

function find(id) {
  return tools().find((t) => toolId(t) === id) || null;
}

function needsConfirm(t) {
  const words = (cfg.confirm || []).map((w) => String(w).toLowerCase());
  const name = String(t.name).toLowerCase();
  return words.some((w) => name.includes(w)) || t.annotations?.destructiveHint === true;
}

// Ejecuta una herramienta y devuelve su resultado como texto
async function call(id, args) {
  const t = find(id);
  if (!t) throw new Error(`no conozco la herramienta ${id}`);
  const res = await servers.get(t.server).request('tools/call', { name: t.name, arguments: args || {} }, 120000);
  const text = (res.content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[imagen]' : `[${c.type}]`)).join('\n');
  return { text: text.slice(0, 12000) || '(sin resultado)', isError: Boolean(res.isError) };
}

module.exports = { start, stop, tools, toolSchemas, find, needsConfirm, call, toolId, configFile };
