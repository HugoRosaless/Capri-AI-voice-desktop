# El oído de Capri

Capri te escucha y hace lo que le pides por voz. Todo funciona en tu PC, sin internet:
Vosk escucha de fondo para oír su nombre, y Whisper transcribe tu orden (entiende mucho mejor).

- **"Capri, abre Spotify"**: la orden va directa a su chat.
- **"Capri"** (pausa) **"pon música"**: ella salta al oír su nombre y espera 8 segundos tu orden.

Entiende lo mismo que su chat: abrir y cerrar apps y juegos, la música (pausa, siguiente, sube el volumen), webs,
recordatorios ("recuérdame en 20 minutos sacar la ropa") o simplemente hablar con ella.

## Instalar

1. Doble clic en `instalar-voz.bat`. Instala Python si falta, las librerías y el modelo de voz en español.
2. Al terminar abre una prueba: habla y verás lo que entiende. Ctrl+C para salir.
3. Reinicia Capri (Salir en su menú, y `npm start`). Desde entonces arranca su oído sola.

Para que se abra al encender el PC: clic derecho en Capri › **Iniciar con Windows**.

## Si no te entiende

- **Nombres que fallan** (apps, juegos, webs): añádelos a `vocabulary` en `config.json`.
- **Va lento**: en `config.json` pon `"whisper_model": "base"`. ¿Quieres que entienda aún mejor? `"medium"`
  (más lento y descarga 1,5 GB). Después de cambiarlo, reinicia Capri.

- Mira `oido.log` en esta carpeta: ahí sale todo lo que ha oído.
- Si cuando dices "Capri" escribe otra cosa, añádela a `wake_words` en `config.json`.
- ¿Micro equivocado? `py capri_oido.py --list-mics` y pon el número en `mic_device`.
- Windows › Configuración › Privacidad › Micrófono: activa "Permitir que las aplicaciones de escritorio accedan al micrófono".

## Su voz

`voice/capri_habla.py` la hace hablar (todo en tu PC salvo la voz de Microsoft). En `config.json` → `"tts"`:

- `"xtts"` / `"auto"`: voz natural XTTS v2 en tu tarjeta gráfica (instálala con `instalar-voz-natural.bat`).
  Elige una de sus voces (`py -3.12 capri_habla.py --muestras` crea ejemplos) en `"tts_speaker"`, o pon un audio
  `voz_referencia.wav` (10–30 s de una voz clara, **con permiso de esa persona**) y copiará esa voz.
- `"edge"`: voces neuronales de Microsoft (necesita internet), p. ej. `"edge_voice": "es-ES-ElviraNeural"`.
- `"sapi"`: la voz de Windows en español.
- `"tts_effects": "cyber"` le da un toque holográfico (phaser, flanger, ecos), o pon tu propio filtro de FFmpeg.

«Capri, calla» la corta; «Capri, no hables» / «habla en voz alta» quitan o ponen la voz.

## Órdenes al momento

| Dices | Hace |
|---|---|
| «Capri, abre Gmail» / «abre YouTube» / «abre WhatsApp»… | Abre la web |
| «Capri, busca recetas de lentejas» | Busca en Google |
| «Capri, ponme un vídeo de gatos» / «busca en YouTube …» | Pone el primer vídeo / enseña los resultados |
| «Capri, pon el segundo vídeo» / «pulsa suscribirse» | Elige y pulsa lo que tienes delante (accesibilidad de Windows) |
| «Capri, pausa el vídeo» / «adelanta 30 segundos» / «pantalla completa» | Controla el vídeo de YouTube |
| «Capri, cierra la pestaña» / «cierra Chrome» | Cierra la pestaña de delante o Chrome |
| «Capri, puedes escribir» → «escribe …» → «pulsa enter» | Escribe donde tengas el cursor (permiso de 30 min) |
| «Capri, apaga el ordenador» / «cancela el apagado» | Apaga en 60 s |
| «Capri, abre Brawlhalla» | Cualquier icono de tu escritorio |

## Que aprenda

- **Órdenes nuevas hablando**: «Capri, cuando diga modo relax, abre YouTube y ponme un vídeo de lluvia».
  Luego «Capri, modo relax». «¿Qué órdenes te he enseñado?», «olvida la orden modo relax».
- **Recuerdos**: cada 4 mensajes apunta lo que vale la pena recordar de ti. «Olvida lo que sabes de mí» lo borra.

## Su cerebro: modo agente, MCP y modo experto

- **Modo agente** (encendido por defecto): su IA local puede usar **herramientas MCP** para hacer cosas de verdad
  (leer y escribir archivos, manejar un navegador…), encadenándolas. Lo delicado (escribir, borrar, enviar, ejecutar…)
  te pregunta antes: pulsa «Sí, hazlo» o dile «sí» / «no». Necesita un modelo de Ollama que sepa usar herramientas
  (`qwen3:14b`, `gpt-oss:20b`…). «Capri, desactiva el modo agente» / «activa el modo agente».
- **Herramientas**: en `mcp.json` (carpeta de Capri; se crea solo la primera vez con «archivos» y «navegador»).
  Hay miles ya hechas: [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers), smithery.ai, mcp.so.
  Se añaden con el mismo formato que Claude Desktop. «Capri, ¿qué herramientas tienes?»
- **Modo experto**: «Capri, modo experto» hace que piense Claude Code (si lo tienes instalado), mucho más capaz para
  tareas complicadas. «Capri, modo normal» vuelve a su IA local.

## Hazla tuya

Las órdenes al momento están en `src/renderer/js/actions.js` (las frases) y `src/main/actions.js` (lo que hacen):
añade la tuya con su frase y su `case`. Lo que Capri aprende y tus ajustes se guardan en tu PC, fuera del repositorio.
