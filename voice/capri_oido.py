"""El oido de Capri: escucha el micro, espera a que digas su nombre y le pasa la orden.

  "Capri, abre Spotify"      -> la orden va directa a su chat
  "Capri" ... "abre YouTube" -> dice su nombre, ella salta, y la siguiente frase es la orden

Dos pasos, todo en tu PC y sin internet:
  - Vosk escucha de fondo (gasta poco) solo para pillar su nombre y cortar las frases.
  - Whisper transcribe la frase en la que la llamas, mucho mejor (nombres de apps, palabras raras).
Si Whisper no esta instalado, se usa lo que entendio Vosk. Solo envia el texto a Capri en 127.0.0.1.
Capri lo arranca sola si existe la carpeta voice/model. Para probarlo a mano:
    python capri_oido.py --debug
"""

import argparse
import difflib
import json
import os
import queue
import re
import socket
import sys
import threading
import time
import unicodedata
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(HERE, "config.json")
LOG_FILE = os.path.join(HERE, "oido.log")

DEFAULT_CONFIG = {
    # como suena su nombre segun el reconocedor (si no te entiende, mira oido.log y anade lo que oye)
    "wake_words": ["capri", "kapri", "cabri", "capris", "la capri", "capra", "cupri"],
    "similarity": 0.72,       # 0-1, lo parecida que tiene que ser una palabra a su nombre
    # Whisper: "base" (rapido), "small" (recomendado), "medium" (mejor, mas lento); "" = solo Vosk
    "whisper_model": "small",
    # palabras que dices a menudo (apps, juegos, webs): Whisper las escribe bien a la primera
    "vocabulary": ["Spotify", "Discord", "Chrome", "YouTube", "Steam", "WhatsApp", "Netflix",
                   "Bloc de notas", "Explorador", "Brawlhalla"],
    "follow_up_seconds": 8,   # tras decir solo "Capri", cuanto espera la orden
    # tras contestarte (o hacer lo que pediste), cuantos segundos sigue escuchando sin que digas "Capri" (0 = nada)
    "conversation_seconds": 6,
    "mic_device": None,       # None = micro por defecto; o el numero/nombre que sale con --list-mics
    "whisper_device": "auto", # "auto" (tarjeta grafica si se puede), "cuda" o "cpu"
    # su voz (capri_habla.py): "auto" (natural en la grafica si esta instalada, si no la de Windows), "xtts", "sapi", ""
    "tts": "auto",
    "tts_speaker": "Ana Florence",  # voz de estudio de XTTS (prueba otras: py -3.12 capri_habla.py --muestras)
    "tts_reference": "voz_referencia.wav",  # si existe este audio, copia esa voz
    "tts_speed": 1.0,
}


def log(msg, debug=False):
    line = time.strftime("%H:%M:%S ") + msg
    if debug:
        print(line, flush=True)
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 512 * 1024:
            os.remove(LOG_FILE)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except (OSError, ValueError) as err:
            log(f"config.json no valido, uso los valores por defecto: {err}")
    else:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
    return cfg


def plain(word):
    word = unicodedata.normalize("NFD", word.lower())
    return "".join(c for c in word if unicodedata.category(c) != "Mn" and c.isalnum())


def split_wake(text, cfg):
    """Si la frase empieza (o casi) por su nombre: (True, resto). Si no: (False, "")."""
    words = text.split()
    wakes = [plain(w) for w in cfg["wake_words"]]
    # su nombre en las 3 primeras palabras ("oye capri", "capri"), o partido en dos ("ca pri")
    for i in range(min(3, len(words))):
        candidates = [(plain(words[i]), i + 1)]
        if i + 1 < len(words):
            candidates.append((plain(words[i]) + plain(words[i + 1]), i + 2))
        for cand, end in candidates:
            if not cand:
                continue
            best = max(difflib.SequenceMatcher(None, cand, w).ratio() for w in wakes)
            if best >= cfg["similarity"]:
                return True, " ".join(words[end:]).strip(" ,.")
    return False, ""


class Whisper:
    """Transcribe una frase ya grabada (int16, 16 kHz) con faster-whisper."""

    def __init__(self, cfg, debug):
        from faster_whisper import WhisperModel
        self.debug = debug
        self.gpu = False
        want = str(cfg.get("whisper_device") or "auto").lower()
        self.model = None
        name = cfg["whisper_model"]
        if want in ("auto", "cuda"):
            # en la grafica: el modelo pedido; si no se puede (p. ej. sin descargar y sin internet), "medium"
            for model_name in dict.fromkeys([name, "medium"]):
                try:
                    cuda_dlls()
                    self.model = WhisperModel(model_name, device="cuda", compute_type="float16",
                                              download_root=os.path.join(HERE, "whisper"))
                    import numpy as np
                    list(self.model.transcribe(np.zeros(16000, dtype=np.float32), language="es")[0])  # que falle aqui, no luego
                    log(f"Whisper '{model_name}' en la tarjeta grafica", debug)
                    self.gpu = True
                    break
                except Exception as err:
                    self.model = None
                    log(f"Whisper '{model_name}' en la grafica no disponible ({err!r})", debug)
        if self.model is None:
            self.model = WhisperModel(cfg["whisper_model"], device="cpu", compute_type="int8",
                                      download_root=os.path.join(HERE, "whisper"))
        words = ", ".join(cfg.get("vocabulary") or [])
        # el contexto: le hablan a Capri, en espanol, con estas palabras (sin empezar cada frase por "Capri,":
        # con Whisper en cada frase, eso le haria "oir" su nombre donde no lo hay)
        self.prompt = f"Conversación en español con Capri, una asistente. Órdenes: abre Spotify, pon un vídeo, cierra la pestaña. {words}."

    def __call__(self, pcm):
        import numpy as np
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        t0 = time.time()
        segments, _ = self.model.transcribe(
            audio, language="es", beam_size=5, initial_prompt=self.prompt,
            vad_filter=True, condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        # lo que Whisper se inventa con ruido o silencio
        if re.search(r"amara\.org|subt[ií]tulos|suscr[ií]bete|gracias por ver|¡?gracias!?$", text, re.I) and len(text) < 80:
            text = ""
        if text:
            log(f"whisper ({time.time() - t0:.1f}s): {text}", self.debug)
        return text


def cuda_dlls():
    """En Windows, las DLL de CUDA que instala pip (nvidia-cublas / nvidia-cudnn) para Whisper en la grafica."""
    if os.name != "nt":
        return
    try:
        import nvidia
        roots = list(getattr(nvidia, "__path__", []))
    except Exception:
        return
    for root in roots:
        for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
            d = os.path.join(root, sub, "bin")
            if os.path.isdir(d):
                try:
                    os.add_dll_directory(d)
                except Exception:
                    pass
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


VOICE_PORT = 47825  # Capri le pide aqui que hable (/say) o que se calle (/stop)


def serve_voice(speaker, debug):
    """Servidor local (solo 127.0.0.1) para la voz de Capri."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, obj, code=200):
            data = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith("/state"):
                return self._send({"engine": speaker.engine, "speaking": speaker.speaking, "ready": speaker.ready.is_set()})
            self._send({"error": "no"}, 404)

        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            try:
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            except ValueError:
                body = {}
            if self.path.startswith("/say"):
                return self._send({"ok": speaker.say(body.get("text", ""))})
            if self.path.startswith("/stop"):
                speaker.stop()
                return self._send({"ok": True})
            self._send({"error": "no"}, 404)

    try:
        srv = ThreadingHTTPServer(("127.0.0.1", VOICE_PORT), Handler)
    except OSError as err:
        log(f"la voz no puede abrir su puerto {VOICE_PORT}: {err}", debug)
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def tell_capri(port, payload, debug):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/voice", data=data,
        headers={"content-type": "application/json"}, method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=3).read()
        return True
    except Exception as err:  # Capri cerrada o arrancando: no pasa nada
        log(f"Capri no responde ({err})", debug)
        return False


LOCK_PORT = 47824  # un solo oido a la vez: el que tiene este puerto


def only_one():
    """Se queda el puerto LOCK_PORT; si ya lo tiene otro oido, devuelve None."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name == "nt":
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        sock.bind(("127.0.0.1", LOCK_PORT))
        sock.listen(1)
        return sock
    except OSError:
        sock.close()
        return None


def capri_pid(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as res:
            return json.loads(res.read()).get("pid")
    except Exception:
        return None


def watch_capri(port, parent_pid, debug):
    """Si Capri se cierra (o arranca otra), este oido se va con ella: nunca se queda huerfano."""
    missing = 0
    while True:
        time.sleep(5)
        pid = capri_pid(port)
        if pid == parent_pid:
            missing = 0
            continue
        missing += 1
        if pid is not None or missing >= 4:  # otra Capri, o 20 s sin ella
            log("Capri ya no esta: el oido se cierra", debug)
            os._exit(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("CAPRI_PORT", 47823)))
    ap.add_argument("--debug", action="store_true", help="muestra todo lo que oye")
    ap.add_argument("--list-mics", action="store_true", help="lista los microfonos y sale")
    ap.add_argument("--parent", type=int, default=0, help="pid de Capri (lo pone ella)")
    args = ap.parse_args()

    import sounddevice as sd
    from vosk import KaldiRecognizer, Model, SetLogLevel

    if args.list_mics:
        print(sd.query_devices())
        return

    lock = only_one()
    if lock is None:
        log("Ya hay un oido escuchando (el de Capri o una prueba). Cierralo antes de abrir otro.", True)
        if args.debug:
            input("Pulsa Enter para salir...")
        sys.exit(0)
    if args.parent:
        threading.Thread(target=watch_capri, args=(args.port, args.parent, args.debug), daemon=True).start()

    cfg = load_config()
    model_dir = os.path.join(HERE, "model")
    if not os.path.isdir(model_dir):
        log("Falta voice/model: ejecuta instalar-voz.bat", True)
        sys.exit(1)

    SetLogLevel(-1)
    model = Model(model_dir)
    rate = 16000
    rec = KaldiRecognizer(model, rate)
    audio = queue.Queue()

    # su voz: se carga aparte (la natural tarda unos segundos) y mientras tanto ya escucha
    speaker = None
    try:
        from capri_habla import Speaker
        speaker = Speaker(cfg, lambda m: log(m, args.debug))
        serve_voice(speaker, args.debug)
    except Exception as err:
        log(f"sin voz ({err!r})", True)

    whisper = None
    if cfg.get("whisper_model"):
        try:
            whisper = Whisper(cfg, args.debug)
            log(f"Whisper '{cfg['whisper_model']}' listo", True)
        except Exception as err:  # no instalado, o sin descargar: sigue con Vosk
            log(f"Whisper no disponible, uso solo Vosk ({err!r})", True)

    def better(pcm, fallback):
        """La frase con Whisper si esta, si no lo que oyo Vosk."""
        if not whisper:
            return fallback
        try:
            return whisper(pcm).strip(" .,!?¡¿") or fallback
        except Exception as err:
            log(f"error de Whisper: {err!r}", True)
            return fallback

    max_bytes = rate * 2 * 30  # como mucho 30 s de audio por frase

    def on_audio(indata, frames, t, status):
        audio.put(bytes(indata))

    waiting_until = 0.0  # dijiste "Capri" a secas (o te acaba de contestar): la siguiente frase es la orden
    # Con Whisper en la tarjeta grafica (rapido) se transcribe CADA frase con Whisper y su nombre se busca ahi:
    # Vosk (pequeno) solo corta las frases. Asi no se pierde cuando Vosk entiende "abri" o "hambre" en vez de "Capri".
    every_phrase = bool(whisper and getattr(whisper, "gpu", False))
    conv = float(cfg.get("conversation_seconds") or 0)
    was_speaking = False
    with sd.RawInputStream(samplerate=rate, blocksize=8000, dtype="int16", channels=1,
                           device=cfg.get("mic_device"), callback=on_audio):
        log("Escuchando. Di 'Capri, ...'" + (" (Whisper en cada frase)" if every_phrase else ""), True)
        phrase = bytearray()  # el audio de la frase en curso, para Whisper
        while True:
            chunk = audio.get()
            now = time.time()
            # acaba de terminar de hablar: un rato para seguir la conversacion sin decir su nombre
            speaking = bool(speaker and speaker.speaking)
            if was_speaking and not speaking and conv > 0:
                waiting_until = max(waiting_until, now + conv)
            was_speaking = speaking
            phrase += chunk
            if len(phrase) > max_bytes:
                del phrase[: len(phrase) - max_bytes]
            if not rec.AcceptWaveform(chunk):
                continue
            pcm = bytes(phrase)
            phrase.clear()
            vtext = json.loads(rec.Result()).get("text", "").strip()
            if not vtext:
                continue
            log(f"vosk: {vtext}", args.debug)
            now = time.time()
            seconds = len(pcm) / (rate * 2)
            v_woke, v_rest = split_wake(vtext, cfg)
            if every_phrase and seconds >= 0.5 and (v_woke or now < waiting_until or speaking or len(vtext.split()) >= 2 or seconds >= 1.2):
                full = better(pcm, "")
                w_woke, w_rest = split_wake(full, cfg) if full else (False, "")
                woke = w_woke or v_woke
                rest = w_rest if w_woke else (full if v_woke and full else v_rest)
                heard = full or vtext
            else:
                full = ""
                woke, rest, heard = v_woke, v_rest, vtext
            # mientras ella habla, el micro la oye a ella: solo cuenta si la llamas por su nombre (y se calla)
            if speaking:
                if not woke:
                    continue
                speaker.stop()
                if not rest:
                    tell_capri(args.port, {"heard": True}, args.debug)
                    waiting_until = now + cfg["follow_up_seconds"]
                    continue
            if woke:
                # sin Whisper en cada frase: Whisper reescribe solo la frase en la que la llamas
                if rest and whisper and not full:
                    tell_capri(args.port, {"heard": True}, args.debug)  # que salte ya, mientras transcribe
                    better_text = better(pcm, vtext)
                    w_woke, w_rest = split_wake(better_text, cfg)
                    rest = w_rest if w_woke else better_text
                if rest:
                    log(f"orden: {rest}", True)
                    tell_capri(args.port, {"text": rest}, args.debug)
                    waiting_until = 0
                else:
                    tell_capri(args.port, {"heard": True}, args.debug)
                    waiting_until = now + cfg["follow_up_seconds"]
            elif now < waiting_until:
                order = full or better(pcm, vtext)
                order = order.strip(" .,!?¡¿")
                if len(order) < 2:
                    continue
                log(f"orden (sin nombre): {order}", True)
                tell_capri(args.port, {"text": order}, args.debug)
                waiting_until = 0

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as err:
        log(f"error: {err!r}", True)
        sys.exit(1)
