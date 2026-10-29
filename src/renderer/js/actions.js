// Órdenes que Capri hace al momento, sin preguntar a su modelo: las reconoce aquí (lo que dijiste por voz
// o escribiste en su chat) y main/actions.js las ejecuta.
// ¿Una orden nueva? Añade aquí su frase (RULES o webIntent) y su «case» en main/actions.js.
// Pensado para lo que escribe Whisper: con o sin acentos, con «por favor», «puedes…», «me…», etc.

const plain = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[¿?¡!.,;:"«»]/g, ' ').replace(/\s+/g, ' ').trim();

// lo que se dice antes de la orden y no cambia nada
const LEAD = /^(?:(?:oye|eh|hey|venga|vale|bueno|ahora|ya|porfa|por favor|please|capri|cabri|kapri|me|te|tu|y|pues|quiero|quiero que|necesito que|haz el favor de|hazme el favor de|puedes|podrias|me puedes|me podrias|puedes por favor|seria posible)\s+)*/;

const CLOSE = '(?:cierras|quitas|cierra(?:me|lo|la)?|cerrar(?:me)?|cierre|quita(?:me)?|quitar|elimina(?:me)?|eliminar|mata|matar|apaga(?:me)?)';

const PC = '(?:el |la |mi )?(?:ordenador|ordena|computadora|computador|pc|pece|equipo|maquina|windows)';

const re = (body) => new RegExp(`^(?:${body})(?:\\s|$)`);
// órdenes que no se hacen si van con condiciones («apaga el ordenador cuando acabe el partido»):
// solo valen solas, o con «ya», «ahora», «por favor»…
const END = '(?: (?:ya|ahora|ahora mismo|ya mismo|por favor|porfa|please|gracias|venga|vale|capri))*$';
const only = (body) => new RegExp(`^(?:${body})${END}`);

const RULES = [
  // apagar: antes que nada, para no confundir «apaga el ordenador» con otras órdenes con «apaga»
  [re(`(?:cancela(?:r)?|anula(?:r)?|para(?:r)?|deten(?:er)?|no) (?:el |lo )?(?:apagado|apagues|apagar|apagues el ordenador|apagues el pc)`), () => ({ action: 'cancel_shutdown' })],
  [only(`(?:apaga(?:me|lo|r)?|apagame|cierra|cerrar|desconecta|desconectar) ${PC}`), () => ({ action: 'shutdown' })],
  [only(`(?:apagate|apagalo todo|apaga todo el ordenador|a dormir el ordenador)`), () => ({ action: 'shutdown' })],

  // permiso para escribir
  [re(`(?:deja de escribir|no escribas(?: nada)?|ya no escribas|desactiva (?:el )?(?:modo )?(?:escritura|dictado)|quita(?:te)? (?:el )?permiso(?: de| para)? escribir)`), () => ({ action: 'typing_off' })],
  [re(`(?:ya )?(?:puedes|te dejo|tienes permiso (?:de|para)|te doy permiso (?:de|para)) escribir|^escribir$|(?:activa|pon) (?:el )?(?:modo )?(?:escritura|dictado)`), () => ({ action: 'typing_on' })],
  [re('(?:pulsa|dale (?:a|al)|presiona|aprieta) (?:el )?(?:enter|intro|entrar)|envialo|mandalo'), () => ({ action: 'enter' })],

  // cerrar
  [re(`${CLOSE} (?:el |todo el |todo )?(?:chrome|crome|cromo|navegador|google chrome)`), () => ({ action: 'close_chrome' })],
  [/^(?:cierra(?:me)?|cerrar|quita(?:me)?|quitar) (?:esta |la |una |esa )?(?:pestana|pestanas|pestaña|ventana|tab)(?: (?:de|del|de la|que pone|que se llama|llamada) (.+))?$/, (m) => ({ action: 'close_tab', target: m[1] || '' })],

];

// Webs conocidas que abre sin preguntar (main/actions.js tiene las direcciones)
const SITES = '(gmail|g mail|el correo|mi correo|correo|email|calendario|google calendar|drive|google drive|youtube|you tube|whatsapp|whatsapp web|maps|google maps|mapas|netflix|twitch|twitter|instagram|facebook|chatgpt|chat gpt|amazon|google|wallapop|prime video|disney)';

// Internet y vídeos: se reconocen sobre el texto con acentos (lo que buscas se busca tal cual lo dijiste)
function webIntent(original) {
  const t = original.toLowerCase().replace(/[¿?¡!"«»]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:oye|eh|venga|vale|bueno|porfa|por favor|capri|me puedes|puedes|podrías|podrias)[\s,]+)+/, '').replace(/[.,;]+$/, '');
  const num = (s) => Number(s) || ({ diez: 10, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, un: 60, uno: 60 })[s] || 0;
  let m;
  // YouTube: poner un vídeo
  if ((m = /^(?:pon(?:me)?|reproduce|quiero ver|ponme a)\s+(?:en youtube\s+)(.+)$/.exec(t))
   || (m = /^(?:pon(?:me)?|reproduce|quiero ver)\s+(.+?)\s+en youtube$/.exec(t))
   || (m = /^(?:pon(?:me)?|reproduce|quiero ver|busca(?:me)? y pon)\s+(?:un )?v[ií]deo (?:de|del|sobre)\s+(.+)$/.exec(t))) {
    return { action: 'youtube_play', query: m[1].trim() };
  }
  // YouTube: solo buscar
  if ((m = /^busca(?:me)?\s+en youtube\s+(.+)$/.exec(t)) || (m = /^busca(?:me)?\s+(.+?)\s+en youtube$/.exec(t))) {
    return { action: 'youtube_search', query: m[1].trim() };
  }
  // el vídeo que estás viendo
  if (/^(?:pon(?:lo|me)?(?: el v[ií]deo)? en |quita (?:la )?)?pantalla completa$/.test(t)) return { action: 'video_key', key: 'fullscreen' };
  if ((m = /^(?:adelanta|avanza)(?: el v[ií]deo)?(?: (\d+|diez|veinte|treinta|cuarenta|cincuenta|sesenta|un|uno) (?:segundos?|minuto))?$/.exec(t))) return { action: 'video_key', key: 'forward', seconds: m[1] ? num(m[1]) : 10 };
  if ((m = /^(?:atrasa|retrocede|rebobina|vuelve atr[aá]s|tira para atr[aá]s)(?: el v[ií]deo)?(?: (\d+|diez|veinte|treinta|cuarenta|cincuenta|sesenta|un|uno) (?:segundos?|minuto))?$/.exec(t))) return { action: 'video_key', key: 'back', seconds: m[1] ? num(m[1]) : 10 };
  if (/^(?:siguiente v[ií]deo|pasa(?: al)? siguiente v[ií]deo|pasa el v[ií]deo|otro v[ií]deo)$/.test(t)) return { action: 'video_key', key: 'next' };
  if (/^(?:pausa|para|det[eé]n|reanuda|continúa|continua|quita la pausa|dale al play)(?: el v[ií]deo)$/.test(t) || /^dale al play$/.test(t)) return { action: 'video_key', key: 'play' };
  if (/^(?:silencia|quita el sonido(?: de| del)?|mutea)(?: el)? v[ií]deo$/.test(t)) return { action: 'video_key', key: 'mute' };
  if ((m = /^(sube|baja)(?:me)? el volumen del v[ií]deo$/.exec(t))) return { action: 'video_key', key: m[1] === 'sube' ? 'volup' : 'voldown' };
  // lo que tienes delante: «pon el segundo vídeo», «abre el vídeo de los gatos», «pulsa suscribirse»
  const ORD = { primer: 1, primero: 1, segundo: 2, tercer: 3, tercero: 3, cuarto: 4, quinto: 5, sexto: 6, 'séptimo': 7, septimo: 7, octavo: 8, noveno: 9, 'décimo': 10, decimo: 10, 'último': -1, ultimo: -1 };
  const PICK = '(?:pon(?:me)?|[aá]bre(?:me)?|abrir|entra en|entra al|m[eé]tete en|selecciona|elige|dale al?|reproduce|clica en|haz cli(?:c|ck) en)';
  if ((m = new RegExp(`^${PICK}\\s+(?:el\\s+)?(primer|primero|segundo|tercer|tercero|cuarto|quinto|sexto|s[eé]ptimo|octavo|noveno|d[eé]cimo|[uú]ltimo|\\d+)\\s*(?:º\\s*)?v[ií]deo$`).exec(t))
   || (m = new RegExp(`^${PICK}\\s+(?:el\\s+)?v[ií]deo\\s+(?:n[uú]mero\\s+)?(\\d+)$`).exec(t))) {
    const nth = /^\d+$/.test(m[1]) ? Number(m[1]) : ORD[m[1]] ?? ORD[m[1].normalize('NFKD').replace(/[\u0300-\u036f]/g, '')];
    if (nth) return { action: 'select', kind: 'video', nth };
  }
  if ((m = new RegExp(`^${PICK}\\s+el\\s+v[ií]deo\\s+(?:de|del|de la|de los|que (?:pone|se llama|habla de)|sobre)\\s+(.+)$`).exec(t))) {
    return { action: 'select', kind: 'video', query: m[1].trim() };
  }
  if (/^(?:baja(?:me)?|ve hacia abajo|scroll|desplaza(?:te)?)(?: la p[aá]gina| un poco| m[aá]s)?$/.test(t)) return { action: 'scroll', dir: 'down' };
  if (/^(?:sube(?:me)?|ve hacia arriba)(?: la p[aá]gina| un poco| m[aá]s)?$/.test(t)) return { action: 'scroll', dir: 'up' };
  if ((m = /^(?:haz cli(?:c|ck) en|clica(?: en)?|cli(?:c|ck) en|pulsa(?: en)?|dale a(?:l)?|selecciona|abre el enlace (?:de|que pone))\s+(?:el |la |los |las |en )?(.{2,})$/.exec(t))) {
    if (!/^(?:enter|intro|entrar|play|el play)$/.test(m[1])) return { action: 'select', kind: 'any', query: m[1].trim() };
  }
  // webs conocidas
  if ((m = new RegExp(`^(?:[aá]bre(?:me)?|abrir|ve a|vete a|entra en|entra a|ll[eé]vame a|ponme)\\s+(?:el |la |mi |el de )?${SITES}$`).exec(t))) return { action: 'open_site', site: m[1] };
  // buscar en internet
  if ((m = /^(?:b[uú]sca(?:me)?|buscar|googlea|b[uú]sca(?:me)? en google|b[uú]sca(?:me)? en internet|mira en google|mira en internet)\s+(?:en google\s+|en internet\s+)?(?:informaci[oó]n (?:de|sobre)\s+|qu[eé] es\s+)?(.{2,})$/.exec(t))) {
    if (!/^(?:la |una |esa |esta )?pesta[ñn]a/.test(m[1])) return { action: 'search_web', query: m[1].trim() };
  }
  return null;
}

// { action, … } si es una de estas órdenes, si no null (entonces Capri contesta como siempre)
export function actionIntent(raw) {
  const original = String(raw || '').trim();
  const web = webIntent(original);
  if (web) return web;
  // «escribe …»: el texto se escribe tal cual lo dijiste (mayúsculas, acentos, signos)
  const write = /^(?:(?:oye|vale|venga|capri|por favor|puedes|me puedes|podrias)[\s,]+)*(?:escr[ií]be(?:me|lo)?|escribir|teclea|pon escrito|ap[uú]nta(?:me|lo)?)\s*[:,]?\s+(?:que\s+)?(.+)$/i.exec(original);
  if (write) {
    const text = write[1].trim().replace(/^["«]|["»]$/g, '');
    if (!/^(?:algo|nada)$/i.test(text)) return { action: 'type', text };
  }
  const text = plain(original).replace(LEAD, '');
  if (!text || text.split(' ').length > 14) return null; // una charla larga no es una orden
  for (const [rule, make] of RULES) {
    const m = rule.exec(text);
    if (m) return make(m);
  }
  return null;
}

// La cara que pone según cómo le fue
export const actionFace = (res) => (res?.ok ? 'smug' : 'aside');
