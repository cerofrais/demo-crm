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

        audio, _sr = sf.read(wav_path, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        wav = torch.from_numpy(audio).unsqueeze(0)

        try:
            result = _model(wav, lang, DEFAULT_DECODING)
        except Exception as err:  # noqa: BLE001 — surface any inference failure as a 500
            logger.exception("inference failed")
            raise HTTPException(500, f"ASR inference failed: {err}")

    text = result[0] if isinstance(result, (list, tuple)) else result
    return JSONResponse({"text": str(text).strip()})


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model is not None, "model_id": MODEL_ID}
