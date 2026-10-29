"""La voz de Capri: convierte texto en voz y lo reproduce, todo en tu PC.

Motores (config.json -> "tts"):
  "edge"  : voz neuronal de Microsoft (edge-tts, necesita internet): "edge_voice", p. ej. en-US-AriaNeural,
            en-US-JennyNeural o en-US-AvaMultilingualNeural (esta habla espanol sin acento)
  "auto"  : XTTS v2 en la tarjeta grafica si esta instalado (voz natural), si no la voz de Windows
  "xtts"  : solo XTTS v2 (instalar-voz-natural.bat)
  "sapi"  : la voz de Windows en espanol (Helena / Laura), siempre disponible
  ""      : sin voz

XTTS usa una de sus voces de estudio ("tts_speaker") o, si existe voice/voz_referencia.wav (6-15 s de una
voz femenina clara, sin musica), copia esa voz. Prueba voces con:  py -3.12 capri_habla.py --muestras
"""

import os
import re
import subprocess
import sys
import threading
import time
import asyncio

# Efecto «construccion holografica»: fase + flanger + ecos cortos + una reverb ligera (FFmpeg)
CYBER = ("highpass=f=90,"
         "aphaser=type=t:in_gain=0.6:out_gain=0.9:delay=2.5:decay=0.35:speed=0.5,"
         "flanger=delay=1:depth=1.5:regen=-8:width=60:speed=0.35,"
         "aecho=0.85:0.55:35|85:0.22|0.12,"
         "aecho=0.8:0.35:160:0.10,"
         "apad=pad_dur=0.25,volume=1.4,alimiter=limit=0.95")

HERE = os.path.dirname(os.path.abspath(__file__))

# voces de estudio femeninas de XTTS v2 para probar (se saltan las que no existan)
FEMALE = ["Ana Florence", "Claribel Dervla", "Daisy Studious", "Gracie Wise", "Sofia Hellen", "Tammie Ema",
          "Alison Dietlinde", "Brenda Stern", "Gitta Nikolina", "Henriette Usha", "Tanja Adelina", "Alma María",
          "Nova Hogarth", "Narelle Moon"]

SAMPLE = "Hola, soy Capri. He abierto el collector y el dashboard; cuando quieras, activo el automático."


def clean_for_speech(text):
    """Lo que se lee en voz alta: sin etiquetas, enlaces, emojis ni simbolos raros."""
    t = re.sub(r"\[\[[^\]]*\]\]", " ", str(text or ""))
    t = re.sub(r"https?://\S+", " enlace ", t)
    t = re.sub(r"[*_`#>|~]", " ", t)
    t = re.sub(r"[\U0001F000-\U0001FAFF☀-➿️]", " ", t)
    t = t.replace("€", " euros").replace("%", " por ciento")
    t = re.sub(r"\s+", " ", t).strip()
    return t[:700]


def sentences(text):
    parts = re.split(r"(?<=[.!?…;])\s+", text)
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        # frases muy largas: se cortan en comas para empezar a hablar antes
        while len(p) > 220 and "," in p[:220]:
            cut = p[:220].rfind(",") + 1
            out.append(p[:cut].strip())
            p = p[cut:].strip()
        out.append(p)
    return out


class Speaker:
    def __init__(self, cfg, log):
        self.cfg = cfg
        self.log = log
        self.engine = None      # "xtts" | "sapi" | None
        self.xtts = None
        self.rate = 24000
        self.lock = threading.Lock()
        self.queue_id = 0       # cada /say nuevo corta el anterior
        self.speaking_until = 0.0
        self.proc = None        # PowerShell de la voz de Windows
        self.ready = threading.Event()
        threading.Thread(target=self._load, daemon=True).start()

    @property
    def speaking(self):
        return time.time() < self.speaking_until

    def _load(self):
        want = (self.cfg.get("tts") if self.cfg.get("tts") is not None else "auto").lower()
        if want == "edge":
            try:
                self._load_edge()
                self.engine = "edge"
                self.log(f"voz: edge ({self.cfg.get('edge_voice') or 'en-US-AriaNeural'}"
                         f"{', efecto ' + self.effects_name() if self.effects() else ''})")
                self.ready.set()
                return
            except Exception as err:
                self.log(f"voz de Microsoft (edge) no disponible, uso la siguiente: {err!r}")
                want = "auto"
        if want in ("auto", "xtts"):
            try:
                self._load_xtts()
                self.engine = "xtts"
                if self.effects():
                    self._load_ffmpeg()
                    self.log(f"voz natural con efecto «{self.effects_name()}»")
            except Exception as err:  # no instalado, sin GPU...: la voz de Windows
                self.log(f"voz natural (XTTS) no disponible: {err!r}")
                if want == "xtts":
                    self.ready.set()
                    return
        if self.engine is None and want in ("auto", "xtts", "sapi") and os.name == "nt":
            self.engine = "sapi"
        self.log(f"voz: {self.engine or 'desactivada'}")
        self.ready.set()

    def _load_xtts(self):
        os.environ.setdefault("COQUI_TOS_AGREED", "1")  # licencia de uso no comercial de XTTS
        os.environ.setdefault("TTS_HOME", os.path.join(HERE, "tts_models"))
        import torch
        from TTS.api import TTS
        device = "cuda" if torch.cuda.is_available() else "cpu"
        t0 = time.time()
        self.xtts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
        try:
            self.rate = self.xtts.synthesizer.output_sample_rate
        except Exception:
            self.rate = 24000
        self.log(f"voz natural XTTS lista en {device} ({time.time() - t0:.0f}s)")
        # primera frase en vacio: la siguiente sale rapida
        self._xtts_wav("Hola.")

    # ── edge-tts + FFmpeg ──
    def _pip(self, *pkgs):
        flags = 0x08000000 if os.name == "nt" else 0
        py = sys.executable.replace("pythonw.exe", "python.exe")
        subprocess.run([py, "-m", "pip", "install", "--user", "--quiet", *pkgs], creationflags=flags, timeout=600)

    def _load_ffmpeg(self):
        """FFmpeg para los efectos de voz (se instala solo la primera vez). Sin el, la voz suena sin efecto."""
        try:
            try:
                import imageio_ffmpeg  # noqa: F401
            except ImportError:
                self.log("instalando FFmpeg para los efectos de voz…")
                self._pip("imageio-ffmpeg")
            import imageio_ffmpeg
            self.ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception as err:
            self.ffmpeg = None
            self.log(f"sin efectos de voz (FFmpeg no disponible: {err!r})")

    def _load_edge(self):
        try:
            import edge_tts  # noqa: F401
        except ImportError:
            self.log("instalando la voz de Microsoft (edge-tts)…")
            self._pip("edge-tts")
        self._load_ffmpeg()
        if not self.ffmpeg:
            raise RuntimeError("FFmpeg no disponible")
        self.rate = 24000
        self._edge_wav("Hola.")  # que falle aqui (sin internet...) y no a mitad de una respuesta

    def effects_name(self):
        return str(self.cfg.get("tts_effects") or "")

    def effects(self):
        fx = self.effects_name()
        if not fx or fx.lower() in ("no", "none", "off", "ninguno"):
            return ""
        return CYBER if fx.lower() in ("cyber", "holografico", "holográfico") else fx  # o tu propio filtro FFmpeg

    def _ffmpeg(self, data, in_args):
        import numpy as np
        flags = 0x08000000 if os.name == "nt" else 0
        af = self.effects()
        cmd = [self.ffmpeg, "-hide_banner", "-loglevel", "error", *in_args, "-i", "pipe:0", "-ac", "1", "-ar", str(self.rate)]
        if af:
            cmd += ["-af", af]
        cmd += ["-f", "f32le", "pipe:1"]
        out = subprocess.run(cmd, input=data, capture_output=True, creationflags=flags, timeout=30).stdout
        return np.frombuffer(out, dtype=np.float32).copy()

    def _edge_wav(self, text):
        import edge_tts
        voice = self.cfg.get("edge_voice") or "en-US-AriaNeural"
        rate = self.cfg.get("edge_rate") or "+0%"
        pitch = self.cfg.get("edge_pitch") or "+0Hz"

        async def grab():
            audio = bytearray()
            async for chunk in edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).stream():
                if chunk.get("type") == "audio":
                    audio += chunk["data"]
            return bytes(audio)

        mp3 = asyncio.run(grab())
        if not mp3:
            raise RuntimeError("edge-tts no ha devuelto audio")
        return self._ffmpeg(mp3, ["-f", "mp3"])

    def _synth(self, text):
        if self.engine == "edge":
            return self._edge_wav(text)
        wav = self._xtts_wav(text)
        if self.effects() and getattr(self, "ffmpeg", None):
            wav = self._ffmpeg(wav.astype("float32").tobytes(), ["-f", "f32le", "-ar", str(self.rate), "-ac", "1"])
        return wav

    def _voice_args(self):
        name = self.cfg.get("tts_reference", "voz_referencia.wav")
        ref = os.path.join(HERE, name) if name else ""   # "" = no copiar ninguna voz: usar tts_speaker
        if ref and os.path.exists(ref):
            return {"speaker_wav": ref}
        return {"speaker": self.cfg.get("tts_speaker") or "Ana Florence"}

    def _xtts_wav(self, text, speaker=None):
        import numpy as np
        args = {"speaker": speaker} if speaker else self._voice_args()
        speed = float(self.cfg.get("tts_speed") or 1.0)
        if abs(speed - 1.0) > 0.01:
            args["speed"] = speed
        wav = self.xtts.tts(text=text, language="es", **args)
        return np.asarray(wav, dtype=np.float32)

    def say(self, text):
        text = clean_for_speech(text)
        if not text or not self.engine:
            self.log(f"voz: no hablo ({'sin texto' if not text else 'voz aun cargando o desactivada'})")
            return False
        self.log(f"voz: digo «{text[:60]}»")
        self.stop()
        with self.lock:
            self.queue_id += 1
            my = self.queue_id
        self.speaking_until = time.time() + 60
        threading.Thread(target=self._run, args=(my, text), daemon=True).start()
        return True

    def _run(self, my, text):
        try:
            if self.engine in ("xtts", "edge"):
                import sounddevice as sd
                parts = sentences(text)
                nxt = None
                for i, part in enumerate(parts):
                    if my != self.queue_id:
                        return
                    wav = nxt if nxt is not None else self._synth(part)
                    nxt = None
                    if my != self.queue_id:
                        return
                    self.speaking_until = time.time() + len(wav) / self.rate + 0.6
                    if i == 0:
                        try:
                            dev = sd.query_devices(kind="output")["name"]
                        except Exception:
                            dev = "?"
                        self.log(f"voz: sonando {len(wav) / self.rate:.1f}s por «{dev}»")
                    sd.play(wav, self.rate, device=self.cfg.get("speaker_device"))
                    # mientras suena esta frase se prepara la siguiente
                    if i + 1 < len(parts):
                        nxt = self._synth(parts[i + 1])
                    sd.wait()
            elif self.engine == "sapi":
                self._sapi(text, my)
        except Exception as err:
            self.log(f"error de voz: {err!r}")
        finally:
            if my == self.queue_id:
                self.speaking_until = time.time() + 0.5  # la cola del eco

    def _sapi(self, text, my):
        safe = text.replace("'", "''")
        rate = int(round((float(self.cfg.get("tts_speed") or 1.0) - 1) * 10))
        script = (
            "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es-*' -and $_.VoiceInfo.Gender -eq 'Female' } | Select-Object -First 1; "
            "if (-not $v) { $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es-*' } | Select-Object -First 1 }; "
            "if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; "
            f"$s.Rate = {max(-10, min(10, rate))}; $s.Speak('{safe}')"
        )
        flags = 0x08000000 if os.name == "nt" else 0  # sin ventana
        self.proc = subprocess.Popen(["powershell", "-NoProfile", "-Command", script], creationflags=flags)
        while self.proc.poll() is None:
            if my != self.queue_id:
                return
            self.speaking_until = time.time() + 1.0
            time.sleep(0.1)

    def stop(self):
        with self.lock:
            self.queue_id += 1
        try:
            import sounddevice as sd
            sd.stop()
        except Exception:
            pass
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.speaking_until = time.time() + 0.3


def samples():
    """Genera voice/muestras/*.wav con varias voces femeninas para elegir."""
    import json
    import wave
    import numpy as np
    cfg = {}
    try:
        with open(os.path.join(HERE, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        pass
    sp = Speaker({**cfg, "tts": "xtts"}, print)
    sp.ready.wait()
    if sp.engine != "xtts":
        print("La voz natural no esta instalada: ejecuta instalar-voz-natural.bat")
        return
    out = os.path.join(HERE, "muestras")
    os.makedirs(out, exist_ok=True)
    names = FEMALE
    try:
        names = [n for n in FEMALE if n in (sp.xtts.speakers or [])] or FEMALE
    except Exception:
        pass
    for name in names:
        try:
            wav = sp._xtts_wav(SAMPLE, speaker=name)
        except Exception as err:
            print(f"  {name}: no disponible ({err})")
            continue
        path = os.path.join(out, f"{name}.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sp.rate)
            w.writeframes((np.clip(wav, -1, 1) * 32767).astype(np.int16).tobytes())
        print(f"  {name}: {path}")
    print("\nEscucha las muestras (carpeta voice\\muestras) y pon el nombre de tu favorita en config.json -> tts_speaker")
    os.startfile(out) if os.name == "nt" else None


if __name__ == "__main__":
    if "--muestras" in sys.argv:
        samples()
    else:
        import json
        cfg = {}
        try:
            with open(os.path.join(HERE, "config.json"), encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            pass
        sp = Speaker(cfg, print)
        sp.ready.wait()
        sp.say(" ".join(a for a in sys.argv[1:] if not a.startswith("--")) or SAMPLE)
        time.sleep(1)
        while sp.speaking:
            time.sleep(0.2)
