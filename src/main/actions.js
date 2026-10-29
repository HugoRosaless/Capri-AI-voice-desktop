'use strict';

// Acciones que Capri hace al momento (por voz o desde su chat), sin preguntar a su modelo:
//   webs conocidas, buscar en Google o YouTube, poner un vídeo, controlar el vídeo, elegir y pulsar lo que
//   tienes delante (accesibilidad de Windows), cerrar pestañas o Chrome, escribir donde tengas el cursor
//   (solo con permiso) y apagar el PC. renderer/js/actions.js reconoce las frases; aquí se ejecutan.
// ¿Quieres una acción nueva? Añade su frase en renderer/js/actions.js y su «case» en run() aquí abajo.

const { spawn, execFile } = require('node:child_process');
const { clipboard, shell } = require('electron');

const WIN = process.platform === 'win32';
const TYPING_MS = 30 * 60 * 1000; // el permiso para escribir dura 30 min desde la última vez que se usa
let typingUntil = 0;

// PowerShell con el script codificado (comillas, acentos y saltos de línea llegan tal cual)
function ps(script, timeout = 20000) {
  const full = `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });
}

const WIN32 = `
if (-not ('CapriWin' -as [type])) { Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices;
public static class CapriWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // Ventanas de Chrome de delante hacia atrás: "handle<TAB>título" por línea
  public static string Chrome() {
    List<string> list = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      try { if (Process.GetProcessById((int)pid).ProcessName.ToLower() != "chrome") return true; } catch { return true; }
      StringBuilder t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (t.Length > 0) list.Add(h.ToInt64() + "\\t" + t.ToString().Replace("\\t", " "));
      return true;
    }, IntPtr.Zero);
    return String.Join("\\n", list.ToArray());
  }
  public static void Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // Alt: Windows deja traerla delante
    SetForegroundWindow(h);
  }
  public static void Keys(byte mod, byte key) {
    if (mod != 0) keybd_event(mod, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 0, UIntPtr.Zero); keybd_event(key, 0, 2, UIntPtr.Zero);
    if (mod != 0) keybd_event(mod, 0, 2, UIntPtr.Zero);
  }
}
'@ }
`;

async function chromeWindows() {
  if (!WIN) return [];
  const out = await ps(`${WIN32}[CapriWin]::Chrome()`).catch(() => '');
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [h, ...rest] = line.split('\t');
    return { h: String(Number(h) || 0), title: rest.join(' ') };
  }).filter((w) => w.h !== '0');
}

// ───────── Abrir en la pantalla de Capri ─────────
// Antes de abrir algo se apuntan las ventanas que ya hay; durante 15 s, cada ventana NUEVA que aparezca
// se lleva a la pantalla donde está Capri (centrada; si estaba maximizada, maximizada allí). Las que ya
// estaban abiertas no se tocan. `area` = zona de trabajo de su pantalla en píxeles reales.
const PLACE = (area) => `
if (-not ('CapriPlace' -as [type])) { Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class CapriPlace {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public static long[] List(uint self) {
    List<long> list = new List<long>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLength(h) == 0) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;              // ventanas de herramientas
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4); if (cloaked != 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid); if (pid == self) return true;  // Capri
      list.Add(h.ToInt64()); return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
  public static void Place(IntPtr h, int ax, int ay, int aw, int ah) {
    if (IsIconic(h)) return;
    RECT r; if (!GetWindowRect(h, out r)) return;
    int cx = (r.L + r.R) / 2, cy = (r.T + r.B) / 2;
    if (cx >= ax && cx < ax + aw && cy >= ay && cy < ay + ah) return;   // ya está en su pantalla
    bool max = IsZoomed(h);
    if (max) { ShowWindow(h, 9); GetWindowRect(h, out r); }
    int w = Math.Min(r.R - r.L, aw), hh = Math.Min(r.B - r.T, ah);
    SetWindowPos(h, IntPtr.Zero, ax + (aw - w) / 2, ay + (ah - hh) / 2, w, hh, 0x0014);
    if (max) ShowWindow(h, 3);
  }
}
'@ }
[void][CapriPlace]::SetProcessDpiAwarenessContext([IntPtr](-4))
$self = [uint32]${process.pid}
$before = New-Object 'System.Collections.Generic.HashSet[long]'
foreach ($h in [CapriPlace]::List($self)) { [void]$before.Add($h) }
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
$seen = @{}
$end = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $end) {
  Start-Sleep -Milliseconds 350
  foreach ($h in [CapriPlace]::List($self)) {
    if ($before.Contains($h)) { continue }
    $n = [int]$seen[$h]
    if ($n -lt 3) { [CapriPlace]::Place([IntPtr]$h, ${Math.round(area.x)}, ${Math.round(area.y)}, ${Math.round(area.width)}, ${Math.round(area.height)}); $seen[$h] = $n + 1 }
  }
}
`;

// Abre algo (launchFn) y lleva lo que aparezca a la pantalla de Capri. Sin `area`, abre sin más.
function placeAfter(area, launchFn) {
  if (!WIN || !area) return Promise.resolve().then(launchFn);
  return new Promise((resolve, reject) => {
    let launched = false;
    const go = () => {
      if (launched) return;
      launched = true;
      Promise.resolve().then(launchFn).then(resolve, reject);
    };
    let child;
    try {
      const encoded = Buffer.from(PLACE(area), 'utf16le').toString('base64');
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return go();
    }
    child.stdout.on('data', (d) => { if (String(d).includes('READY')) go(); });
    child.on('error', go);
    child.on('exit', go);
    setTimeout(go, 4000); // si PowerShell tarda, se abre igual (sin colocar)
    setTimeout(() => { try { child.kill(); } catch {} }, 20000);
  });
}

const plain = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

// La pestaña que se ve en una ventana de Chrome: la que se llame así, o la de la ventana de delante.
async function closeTab(target) {
  const wins = await chromeWindows();
  if (!wins.length) return { ok: true, line: 'No hay ninguna ventana de Chrome abierta.' };
  const want = plain(target).replace(/^(de la|de los|de las|del|de|la|el|los|las)\s+/, '').trim();
  const win = want ? wins.find((w) => plain(w.title).includes(want)) : wins[0];
  if (!win) return { ok: false, line: `No veo delante ninguna pestaña que se llame «${target}». Solo puedo cerrar la pestaña que se ve en cada ventana.` };
  await ps(`${WIN32}[CapriWin]::Front([IntPtr]${win.h}); Start-Sleep -Milliseconds 300; [CapriWin]::Keys(0x11, 0x57)`).catch(() => {});
  return { ok: true, line: `Pestaña cerrada: ${win.title.replace(/ - Google Chrome$/, '').slice(0, 60)}.` };
}

function closeChrome() {
  return new Promise((resolve) => {
    // sin /F: como pulsar la X (Chrome guarda las pestañas)
    execFile('taskkill.exe', ['/IM', 'chrome.exe'], { windowsHide: true }, () => resolve({ ok: true, line: 'He cerrado Chrome.' }));
  });
}

function shutdown() {
  execFile('shutdown.exe', ['/s', '/t', '60', '/c', 'Capri apaga el PC en 60 s. Para cancelarlo di: Capri, cancela el apagado.'], { windowsHide: true }, () => {});
  return { ok: true, line: 'Apago el ordenador en 60 segundos. Si te arrepientes, di «Capri, cancela el apagado».' };
}
function cancelShutdown() {
  return new Promise((resolve) => execFile('shutdown.exe', ['/a'], { windowsHide: true },
    (err) => resolve({ ok: true, line: err ? 'No había ningún apagado pendiente.' : 'Apagado cancelado.' })));
}

// Si su chat tiene el teclado, se lo devuelve a la ventana de detrás antes de teclear nada.
async function releaseFocus(overlay) {
  if (overlay && !overlay.isDestroyed() && overlay.isFocused()) {
    overlay.setFocusable(false);
    overlay.blur();
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Escribir: solo con permiso, en la ventana que tengas delante, pegando el texto (acentos y ñ bien) y
// devolviendo después lo que tenías en el portapapeles.
async function type(text, overlay) {
  if (!text) return { ok: false, line: '¿Qué escribo?' };
  if (Date.now() > typingUntil) return { ok: false, line: 'Para escribir necesito tu permiso: di «Capri, puedes escribir».' };
  typingUntil = Date.now() + TYPING_MS;
  await releaseFocus(overlay);
  const before = clipboard.readText();
  clipboard.writeText(text);
  await ps(`${WIN32}Start-Sleep -Milliseconds 120; [CapriWin]::Keys(0x11, 0x56)`).catch(() => {});
  setTimeout(() => { if (clipboard.readText() === text) clipboard.writeText(before); }, 1500);
  return { ok: true, line: `Escrito: «${text.length > 80 ? `${text.slice(0, 80)}…` : text}»` };
}
async function enter(overlay) {
  if (Date.now() > typingUntil) return { ok: false, line: 'Para pulsar teclas necesito tu permiso: di «Capri, puedes escribir».' };
  typingUntil = Date.now() + TYPING_MS;
  await releaseFocus(overlay);
  await ps(`${WIN32}[CapriWin]::Keys(0, 0x0D)`).catch(() => {});
  return { ok: true, line: 'Enter pulsado.' };
}

// ───────── Internet y vídeos ─────────
const SITE_URLS = {
  gmail: 'https://mail.google.com', 'g mail': 'https://mail.google.com', correo: 'https://mail.google.com', 'el correo': 'https://mail.google.com',
  'mi correo': 'https://mail.google.com', email: 'https://mail.google.com', calendario: 'https://calendar.google.com',
  'google calendar': 'https://calendar.google.com', drive: 'https://drive.google.com', 'google drive': 'https://drive.google.com',
  youtube: 'https://www.youtube.com', 'you tube': 'https://www.youtube.com', whatsapp: 'https://web.whatsapp.com', 'whatsapp web': 'https://web.whatsapp.com',
  maps: 'https://www.google.com/maps', 'google maps': 'https://www.google.com/maps', mapas: 'https://www.google.com/maps',
  netflix: 'https://www.netflix.com', twitch: 'https://www.twitch.tv', twitter: 'https://x.com', instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com', chatgpt: 'https://chatgpt.com', 'chat gpt': 'https://chatgpt.com', amazon: 'https://www.amazon.es',
  google: 'https://www.google.com', wallapop: 'https://es.wallapop.com', 'prime video': 'https://www.primevideo.com', disney: 'https://www.disneyplus.com',
};
const NICE = { 'g mail': 'Gmail', correo: 'Gmail', 'el correo': 'Gmail', 'mi correo': 'Gmail', email: 'Gmail', gmail: 'Gmail', 'you tube': 'YouTube', youtube: 'YouTube' };

async function openUrl(url, area) {
  await placeAfter(area, () => shell.openExternal(url));
}

// El primer vídeo de YouTube para lo que pides (sin clave de API: se lee la página de resultados)
async function firstVideo(query) {
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=es`, {
      headers: { 'accept-language': 'es-ES,es;q=0.9', cookie: 'SOCS=CAI; CONSENT=YES+1', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();
    const id = /"videoRenderer":\{"videoId":"([\w-]{11})"/.exec(html)?.[1] || /"videoId":"([\w-]{11})"/.exec(html)?.[1];
    const title = id && /"videoRenderer":\{"videoId":"[\w-]{11}".*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(html)?.[1];
    return id ? { id, title: title ? JSON.parse(`"${title}"`) : '' } : null;
  } catch {
    return null;
  }
}

// Teclas de YouTube en la ventana de Chrome que tenga un vídeo de YouTube delante
const VIDEO_KEYS = { fullscreen: [0, 0x46], forward: [0, 0x4C], back: [0, 0x4A], next: [0x10, 0x4E], play: [0, 0x4B], mute: [0, 0x4D] };
async function videoKey(key, seconds) {
  if (key === 'volup' || key === 'voldown') {
    const launch = require('./launch');
    await launch.media(key);
    return { ok: true, line: key === 'volup' ? 'Subo el volumen.' : 'Bajo el volumen.' };
  }
  const win = (await chromeWindows()).find((w) => /youtube/i.test(w.title));
  if (!win) return { ok: false, line: 'No veo ningún vídeo de YouTube abierto en Chrome.' };
  const [mod, vk] = VIDEO_KEYS[key];
  const times = key === 'forward' || key === 'back' ? Math.max(1, Math.min(12, Math.round((seconds || 10) / 10))) : 1;
  await ps(`${WIN32}[CapriWin]::Front([IntPtr]${win.h}); Start-Sleep -Milliseconds 300; 1..${times} | ForEach-Object { [CapriWin]::Keys(${mod}, ${vk}); Start-Sleep -Milliseconds 120 }`).catch(() => {});
  const lines = { fullscreen: 'Pantalla completa.', forward: `Adelanto ${times * 10} segundos.`, back: `Atraso ${times * 10} segundos.`, next: 'Siguiente vídeo.', play: 'Hecho.', mute: 'Sonido del vídeo quitado o puesto.' };
  return { ok: true, line: lines[key] };
}

// ───────── Lo que tienes delante: elegir y pulsar cosas de la ventana de delante ─────────
// Lee con la accesibilidad de Windows (UI Automation) los enlaces y botones VISIBLES de la ventana que tienes
// delante (Chrome, YouTube, cualquier web o programa): su texto, su dirección y dónde están. No hace capturas.
const SCREEN = (selfPid) => `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
if (-not ('CapriSee' -as [type])) { Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class CapriSee {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public static IntPtr Front(uint self) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLength(h) == 0) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      int cl = 0; DwmGetWindowAttribute(h, 14, out cl, 4); if (cl != 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid); if (pid == self) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@ }
[void][CapriSee]::SetProcessDpiAwarenessContext([IntPtr](-4))
$h = [CapriSee]::Front([uint32]${selfPid})
if ($h -eq [IntPtr]::Zero) { '{"items":[]}'; return }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$T = [System.Windows.Automation.ControlType]
$P = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$conds = @($T::Hyperlink, $T::Button, $T::MenuItem, $T::TabItem, $T::ListItem, $T::CheckBox, $T::RadioButton) | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($P, $_) }
$cond = New-Object System.Windows.Automation.OrCondition(,[System.Windows.Automation.Condition[]]$conds)
$wr = $root.Current.BoundingRectangle
$out = New-Object System.Collections.ArrayList
for ($try = 0; $try -lt 2; $try++) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($all.Count -ge 5) { break }
  Start-Sleep -Milliseconds 1200   # Chrome enciende su accesibilidad la primera vez que se le pregunta
}
foreach ($e in $all) {
  try {
    $c = $e.Current
    if ($c.IsOffscreen) { continue }
    $r = $c.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 4 -or $r.Height -lt 4) { continue }
    if ($r.Bottom -lt $wr.Top -or $r.Top -gt $wr.Bottom -or $r.Right -lt $wr.Left -or $r.Left -gt $wr.Right) { continue }
    $v = ''
    if ($c.ControlType -eq $T::Hyperlink) { try { $v = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {} }
    $n = [string]$c.Name
    if (-not $n -and -not $v) { continue }
    [void]$out.Add(@{ n = $n.Substring(0, [Math]::Min(160, $n.Length)); t = $c.ControlType.ProgrammaticName.Replace('ControlType.', ''); v = $v; x = [int]$r.Left; y = [int]$r.Top; w = [int]$r.Width; h = [int]$r.Height })
  } catch {}
  if ($out.Count -ge 400) { break }
}
@{ hwnd = $h.ToInt64(); title = $root.Current.Name; items = $out } | ConvertTo-Json -Compress -Depth 4
`;

async function screenItems() {
  const out = await ps(SCREEN(process.pid), 30000).catch(() => '');
  try { return JSON.parse(out.split(/\r?\n/).filter(Boolean).pop() || '{}'); } catch { return { items: [] }; }
}

// Clic real en el centro de lo elegido (el puntero vuelve donde estaba)
const CLICK = (hwnd, x, y) => `
if (-not ('CapriClick' -as [type])) { Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CapriClick {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  public static void Click(IntPtr h, int x, int y) {
    P old; GetCursorPos(out old);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(150);
    SetCursorPos(x, y); System.Threading.Thread.Sleep(60);
    mouse_event(0x02, 0, 0, 0, UIntPtr.Zero); mouse_event(0x04, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(120);
    SetCursorPos(old.X, old.Y);
  }
}
'@ }
[void][CapriClick]::SetProcessDpiAwarenessContext([IntPtr](-4))
[CapriClick]::Click([IntPtr]${Number(hwnd) || 0}, ${Math.round(x)}, ${Math.round(y)})
`;

const words = (t) => plain(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3 && !['los', 'las', 'del', 'que', 'con', 'una', 'por', 'para', 'video', 'videos'].includes(w));
function matchScore(query, name) {
  const q = words(query);
  if (!q.length) return 0;
  const n = plain(name);
  const nw = new Set(words(name));
  const hits = q.filter((w) => nw.has(w) || (w.length >= 5 && n.includes(w)));
  return hits.length / q.length + (n.includes(plain(query)) ? 0.5 : 0);
}

// Vídeos de YouTube visibles, en el orden en que los ves (filas de arriba abajo, cada fila de izquierda a derecha)
function visibleVideos(items) {
  const byId = new Map();
  for (const it of items) {
    if (it.t !== 'Hyperlink') continue;
    const id = /[?&]v=([\w-]{11})/.exec(it.v || '')?.[1] || /\/shorts\/([\w-]{11})/.exec(it.v || '')?.[1];
    if (!id) continue;
    const cur = byId.get(id);
    const box = { x: it.x, y: it.y, w: it.w, h: it.h };
    if (!cur) byId.set(id, { id, title: it.n || '', top: it.y, left: it.x, click: box });
    else {
      if ((it.n || '').length > cur.title.length) { cur.title = it.n; cur.click = box; }   // el título, mejor sitio para el clic
      cur.top = Math.min(cur.top, it.y);
      cur.left = Math.min(cur.left, it.x);
    }
  }
  const list = [...byId.values()].filter((v) => v.title.trim().length > 0).sort((a, b) => a.top - b.top);
  const rows = [];
  for (const v of list) {
    const row = rows.find((r) => Math.abs(r.top - v.top) < 90);
    if (row) row.items.push(v); else rows.push({ top: v.top, items: [v] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.left - b.left));
}

async function select(intent, area) {
  const scr = await screenItems();
  const items = scr.items || [];
  if (!items.length) return { ok: false, line: 'No consigo leer lo que tienes delante. Pon la ventana delante y vuelve a pedírmelo.' };
  let target = null;
  let label = '';
  if (intent.kind === 'video') {
    const vids = visibleVideos(items);
    if (vids.length) {
      if (intent.nth) {
        const v = intent.nth === -1 ? vids[vids.length - 1] : vids[intent.nth - 1];
        if (!v) return { ok: false, line: `Solo veo ${vids.length} vídeos en pantalla.` };
        target = v.click; label = v.title;
      } else if (intent.query) {
        const best = vids.map((v) => [matchScore(intent.query, v.title), v]).sort((a, b) => b[0] - a[0])[0];
        if (best && best[0] >= 0.5) { target = best[1].click; label = best[1].title; }
      }
    }
    if (!target && intent.query) return run({ action: 'youtube_play', query: intent.query }, { area });   // no está en pantalla: se busca
    if (!target) return { ok: false, line: 'No veo vídeos de YouTube en la ventana de delante.' };
  } else {
    const q = String(intent.query || '');
    const ranked = items.filter((it) => it.n)
      .map((it) => [matchScore(q, it.n) + (plain(it.n) === plain(q) ? 1 : 0) + (/Hyperlink|Button/.test(it.t) ? 0.05 : 0), it])
      .sort((a, b) => b[0] - a[0]);
    if (!ranked.length || ranked[0][0] < 0.5) return { ok: false, line: `No veo nada que se llame «${q}» en la ventana de delante.` };
    target = ranked[0][1]; label = target.n;
  }
  await ps(CLICK(scr.hwnd, target.x + target.w / 2, target.y + target.h / 2)).catch(() => {});
  return { ok: true, line: `Abriendo «${String(label).slice(0, 80)}».` };
}

// Bajar / subir la página de delante
async function scroll(dir) {
  await ps(`${WIN32}[CapriWin]::Keys(0, ${dir === 'up' ? '0x21' : '0x22'})`).catch(() => {});
  return { ok: true, line: dir === 'up' ? 'Subo.' : 'Bajo.' };
}

async function run(intent, { overlay, area } = {}) {
  if (!WIN) return { ok: false, line: 'Esto solo funciona en Windows.' };
  try {
    switch (intent?.action) {
      case 'close_tab': return await closeTab(intent.target || '');
      case 'close_chrome': return await closeChrome();
      case 'shutdown': return shutdown();
      case 'cancel_shutdown': return await cancelShutdown();
      case 'typing_on':
        typingUntil = Date.now() + TYPING_MS;
        return { ok: true, line: 'Vale: durante 30 min puedo escribir donde tengas el cursor. Di «Capri, escribe …». Para quitármelo: «Capri, deja de escribir».' };
      case 'typing_off':
        typingUntil = 0;
        return { ok: true, line: 'Entendido, ya no escribo nada.' };
      case 'type': return await type(String(intent.text || '').trim(), overlay);
      case 'enter': return await enter(overlay);
      case 'open_site': {
        const url = SITE_URLS[intent.site];
        if (!url) return { ok: false, line: 'No conozco esa web.' };
        await openUrl(url, area);
        const name = NICE[intent.site] || intent.site.replace(/\b\w/g, (c) => c.toUpperCase());
        return { ok: true, line: `Abriendo ${name}.` };
      }
      case 'search_web': {
        const q = String(intent.query || '').trim();
        await openUrl(`https://www.google.com/search?q=${encodeURIComponent(q)}`, area);
        return { ok: true, line: `Buscando «${q}» en Google.` };
      }
      case 'youtube_search': {
        const q = String(intent.query || '').trim();
        await openUrl(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, area);
        return { ok: true, line: `Buscando «${q}» en YouTube.` };
      }
      case 'youtube_play': {
        const q = String(intent.query || '').trim();
        const v = await firstVideo(q);
        if (!v) {
          await openUrl(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, area);
          return { ok: true, line: `No he podido elegir uno: te dejo los resultados de «${q}» en YouTube.` };
        }
        await openUrl(`https://www.youtube.com/watch?v=${v.id}`, area);
        return { ok: true, line: v.title ? `Poniendo «${v.title}».` : `Poniendo el primer vídeo de «${q}».` };
      }
      case 'video_key': return await videoKey(intent.key, intent.seconds);
      case 'select': return await select(intent, area);
      case 'scroll': return await scroll(intent.dir);
      default: return { ok: false, line: 'Eso todavía no sé hacerlo.' };
    }
  } catch (err) {
    return { ok: false, line: `Algo ha fallado: ${err.message}` };
  }
}

module.exports = { run, placeAfter, _test: { visibleVideos, matchScore } };
