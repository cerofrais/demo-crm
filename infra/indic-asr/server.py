"""
OpenAI-compatible /v1/audio/transcriptions shim around AI4Bharat's
IndicConformer (ai4bharat/indic-conformer-600m-multilingual) — a
conformer-based ASR covering 22 official Indian languages. No English
support; use this only for calls conducted primarily in a regional language.

The gated HF model needs HF_TOKEN (a Hugging Face access token, after
requesting access on the model page) to download on first run.
"""
import logging
import os
import subprocess
import tempfile

import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from transformers import AutoModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("indic-asr")

MODEL_ID = os.environ.get("ASR_MODEL_ID", "ai4bharat/indic-conformer-600m-multilingual")
DEFAULT_LANGUAGE = os.environ.get("ASR_LANGUAGE", "te")
DEFAULT_DECODING = os.environ.get("ASR_DECODING", "rnnt")  # "rnnt" (accurate) | "ctc" (fast)
HF_TOKEN = os.environ.get("HF_TOKEN") or None

# Windowed decoding — see the chunking loop in transcribe(). 25s sits inside
# the model's trained utterance length; the overlap keeps a word that straddles
# a boundary from being clipped out of both neighbouring windows.
CHUNK_SECONDS = float(os.environ.get("ASR_CHUNK_SECONDS", "25"))
CHUNK_OVERLAP_SECONDS = float(os.environ.get("ASR_CHUNK_OVERLAP_SECONDS", "2"))
MIN_CHUNK_SECONDS = float(os.environ.get("ASR_MIN_CHUNK_SECONDS", "1"))

# The model's 22 supported Indian-language codes — English is not among them.
SUPPORTED_LANGUAGES = {
    "as", "bn", "brx", "doi", "gu", "hi", "kn", "kok", "ks", "mai", "ml",
    "mni", "mr", "ne", "or", "pa", "sa", "sat", "sd", "ta", "te", "ur",
}

app = FastAPI(title="Indic ASR (AI4Bharat IndicConformer)")
_model = None


@app.on_event("startup")
def load_model() -> None:
    global _model
    logger.info("loading %s — first run downloads weights, can take several minutes", MODEL_ID)
    _model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True, token=HF_TOKEN)
    logger.info("model loaded (default language=%s, decoding=%s)", DEFAULT_LANGUAGE, DEFAULT_DECODING)


def _to_wav16k_mono(src_path: str, dst_path: str) -> None:
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", src_path, "-ac", "1", "-ar", "16000", "-f", "wav", dst_path],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='ignore')[:500]}")


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(None),  # accepted for OpenAI-API compatibility; this server has one model
    language: str = Form(None),
    response_format: str = Form("json"),
):
    if _model is None:
        raise HTTPException(503, "Model is still loading — retry shortly")

    lang = (language or DEFAULT_LANGUAGE).lower()
    if lang not in SUPPORTED_LANGUAGES:
        raise HTTPException(400, f"Unsupported language '{lang}'. Supported: {sorted(SUPPORTED_LANGUAGES)}")

    with tempfile.TemporaryDirectory() as tmp:
        src_path = os.path.join(tmp, "input")
        wav_path = os.path.join(tmp, "audio.wav")
        with open(src_path, "wb") as f:
            f.write(await file.read())

        try:
            _to_wav16k_mono(src_path, wav_path)
        except RuntimeError as err:
            raise HTTPException(422, str(err))

        audio, sr = sf.read(wav_path, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        # IndicConformer is trained on utterance-length audio. Handing it a
        # whole call in one forward pass does not error — it silently returns
        # an EMPTY string, which is how multi-minute recordings ended up with
        # no transcript at all. Decode in windows and stitch the pieces.
        window = int(CHUNK_SECONDS * sr)
        overlap = int(CHUNK_OVERLAP_SECONDS * sr)
        step = max(window - overlap, 1)
        total = len(audio)

        pieces: list[str] = []
        try:
            for start in range(0, max(total, 1), step):
                segment = audio[start : start + window]
                # Conformer needs a minimum span to produce anything; a sub-second
                # tail is silence-padding at the end of the call, not speech.
                if len(segment) < sr * MIN_CHUNK_SECONDS:
                    break
                wav = torch.from_numpy(segment).unsqueeze(0)
                result = _model(wav, lang, DEFAULT_DECODING)
                piece = result[0] if isinstance(result, (list, tuple)) else result
                piece = str(piece).strip()
                if piece:
                    pieces.append(piece)
        except Exception as err:  # noqa: BLE001 — surface any inference failure as a 500
            logger.exception("inference failed")
            raise HTTPException(500, f"ASR inference failed: {err}")

    text = " ".join(pieces).strip()
    logger.info("decoded %d chunk(s), %d chars, lang=%s", len(pieces), len(text), lang)
    return JSONResponse({"text": text})


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model is not None, "model_id": MODEL_ID}
