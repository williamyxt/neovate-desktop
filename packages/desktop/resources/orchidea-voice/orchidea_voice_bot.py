import argparse
import asyncio
import datetime
import io
import json
import logging
import os
import pathlib
import subprocess
import sys
import tempfile
import uuid
import wave
import re

import aiohttp
from aiohttp import web
import websockets
from websockets.exceptions import InvalidStatus, ConnectionClosedError
from urllib.parse import urlparse

from funasr_engine import LocalFunASREngine

logger = logging.getLogger(__name__)

def _hex_id32() -> str:
    return uuid.uuid4().hex

def _env(name: str) -> str:
    v = os.environ.get(name) or ""
    return v.strip()

def _merge_json(a_raw: str, b_raw: str) -> str:
    try:
        a = json.loads(a_raw) if a_raw else {}
    except Exception:
        a = {}
    try:
        b = json.loads(b_raw) if b_raw else {}
    except Exception:
        b = {}
    if not isinstance(a, dict):
        a = {}
    if not isinstance(b, dict):
        b = {}
    a.update(b)
    return json.dumps(a, ensure_ascii=False)

# region debug-point voice-asr-modes-python
async def _report_debug_event(event: str, data: dict) -> None:
    url = _env("DEBUG_SERVER_URL")
    session_id = _env("DEBUG_SESSION_ID")
    run_id = _env("ORCHIDEA_DEBUG_RUN_ID") or "pre"
    if not url or not session_id:
        return
    payload = {
        "ts": int(__import__("time").time() * 1000),
        "sessionId": session_id,
        "runId": run_id,
        "hypothesisId": "C",
        "event": event,
        "data": data or {},
    }
    try:
        import urllib.request

        req = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        await asyncio.to_thread(lambda: urllib.request.urlopen(req, timeout=2).read())
    except Exception:
        return

# endregion debug-point voice-asr-modes-python


def _safe_json_loads(raw: str):
    try:
        return json.loads(raw)
    except Exception:
        return None


def _is_final(val, treat_missing_final_as_final: bool) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return bool(val)
    if val is None:
        return bool(treat_missing_final_as_final)
    return str(val).lower() in ("1", "true", "yes", "final", "done", "end")


def _is_http_url(url: str) -> bool:
    u = (url or "").lower()
    return u.startswith("http://") or u.startswith("https://")


def _pcm16_to_wav_bytes(pcm: bytes, *, sample_rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm)
    return buf.getvalue()

def _extract_wake_content(text: str, wake_word: str) -> tuple[bool, str]:
    if not wake_word:
        return (False, text)
    if wake_word in text:
        return (True, text.replace(wake_word, "", 1))
    if wake_word != "兰心":
        return (False, text)
    variants = ("兰欣", "蓝心", "蓝欣", "蓝溪斌", "蓝溪", "兰溪斌", "兰溪", "来亲", "来欣", "兰亲", "安心", "安欣")
    for v in variants:
        idx = text.find(v)
        if idx != -1 and idx < 6:
            return (True, text[:idx] + text[idx + len(v) :])
    m = re.search(r"[兰蓝来安][\s,，。.!！?？:：;；]{0,2}(心|欣|亲)", text)
    if m and m.start() < 6:
        return (True, text[: m.start()] + text[m.end() :])
    return (False, text)


class AsrClient:
    def __init__(self, *, url: str, cfg: dict):
        self._url = url
        self._cfg = cfg
        self._provider = str(cfg.get("provider") or "").strip().lower()
        self._ws = None
        self._recv_task: asyncio.Task | None = None
        self._on_message = None
        self._utterance_started = False
        self._origin = cfg.get("origin") if isinstance(cfg.get("origin"), str) else None
        self._subprotocols = cfg.get("subprotocols") if isinstance(cfg.get("subprotocols"), list) else None
        self._headers = cfg.get("headers") if isinstance(cfg.get("headers"), dict) else None
        self._open_timeout = float(cfg.get("openTimeoutSec") or 10) if isinstance(cfg.get("openTimeoutSec"), (int, float, str)) else 10

        self._send_mode = str(cfg.get("sendMode") or "binary").lower()
        self._audio_message = cfg.get("audioMessage") if isinstance(cfg.get("audioMessage"), dict) else None
        self._audio_field = str(cfg.get("audioField") or "audio")
        self._start_message = cfg.get("startMessage") if isinstance(cfg.get("startMessage"), dict) else None
        self._start_per_utterance = bool(cfg.get("startPerUtterance") or False)
        self._reset_message = cfg.get("resetMessage") if isinstance(cfg.get("resetMessage"), dict) else {"type": "reset"}
        self._close_on_reset = bool(cfg.get("closeOnReset") or False)
        self._result_text_field = str(cfg.get("resultTextField") or "text")
        self._result_final_field = str(cfg.get("resultFinalField") or "is_final")
        self._result_type_field = str(cfg.get("resultTypeField") or "type")
        self._result_type_value = cfg.get("resultTypeValue")
        self._treat_missing_final_as_final = bool(cfg.get("treatMissingFinalAsFinal") or False)
        self._user_id_field = str(cfg.get("userIdField") or "")
        self._log_raw = bool(cfg.get("logRaw") or False)
        self._ali_task_id = _hex_id32() if self._provider in ("aliyun_nls_asr", "aliyun_nls") else ""
        self._ali_appkey = str(cfg.get("appKey") or "")
        self._ali_sample_rate = int(cfg.get("sampleRate") or 16000)
        self._ali_enable_intermediate = bool(cfg.get("enableIntermediateResult") or False)
        self._ali_enable_punc = bool(cfg.get("enablePunctuationPrediction") or False)
        self._ali_enable_itn = bool(cfg.get("enableInverseTextNormalization") or False)

    async def connect(self, on_message):
        self._on_message = on_message
        if self._ws:
            return
        headers = None
        if isinstance(self._headers, dict):
            headers = [(str(k), str(v)) for k, v in self._headers.items() if k]
        try:
            self._ws = await websockets.connect(
                self._url,
                origin=self._origin,
                subprotocols=self._subprotocols,
                additional_headers=headers,
                open_timeout=self._open_timeout,
                ping_interval=None,
                ping_timeout=None,
                close_timeout=1,
            )
        except Exception as e:
            body = ""
            status_code = None
            if isinstance(e, InvalidStatus):
                try:
                    status_code = e.response.status_code
                except Exception:
                    status_code = None
                try:
                    body = bytes(e.response.body).decode("utf-8", errors="ignore")
                except Exception:
                    body = ""
            missing_subprotocol = "missing subprotocol" in (body or "").lower()
            if not missing_subprotocol and status_code == 400:
                missing_subprotocol = True
            if not self._subprotocols and missing_subprotocol:
                self._subprotocols = ["binary"]
                await _report_debug_event(
                    "python:asr:retry-with-subprotocol",
                    {"url": self._url, "statusCode": status_code, "bodyPreview": (body or "")[:200], "subprotocols": self._subprotocols},
                )
                self._ws = await websockets.connect(
                    self._url,
                    origin=self._origin,
                    subprotocols=self._subprotocols,
                    additional_headers=headers,
                    open_timeout=self._open_timeout,
                    ping_interval=None,
                    ping_timeout=None,
                    close_timeout=1,
                )
            else:
                raise
        if self._provider in ("aliyun_nls_asr", "aliyun_nls"):
            if self._ali_task_id and self._ali_appkey:
                await self._ws.send(
                    json.dumps(
                        {
                            "header": {
                                "appkey": self._ali_appkey,
                                "message_id": _hex_id32(),
                                "task_id": self._ali_task_id,
                                "namespace": "SpeechTranscriber",
                                "name": "StartTranscription",
                            },
                            "payload": {
                                "format": "pcm",
                                "sample_rate": int(self._ali_sample_rate),
                                "enable_intermediate_result": bool(self._ali_enable_intermediate),
                                "enable_punctuation_prediction": bool(self._ali_enable_punc),
                                "enable_inverse_text_normalization": bool(self._ali_enable_itn),
                            },
                        },
                        ensure_ascii=False,
                    )
                )
        elif self._start_message and not self._start_per_utterance:
            await self._ws.send(json.dumps(self._start_message, ensure_ascii=False))
        self._recv_task = asyncio.create_task(self._recv_loop())

    async def close(self):
        task = self._recv_task
        self._recv_task = None
        if task and not task.done():
            task.cancel()
        ws = self._ws
        self._ws = None
        if ws:
            try:
                await ws.close()
            except Exception:
                pass

    async def start_utterance(self):
        if not self._ws:
            return
        if self._start_message and self._start_per_utterance and not self._utterance_started:
            await self._ws.send(json.dumps(self._start_message, ensure_ascii=False))
        self._utterance_started = True

    async def end_utterance(self):
        if not self._ws:
            return
        try:
            if self._provider in ("aliyun_nls_asr", "aliyun_nls"):
                if self._ali_task_id and self._ali_appkey:
                    await self._ws.send(
                        json.dumps(
                            {
                                "header": {
                                    "appkey": self._ali_appkey,
                                    "message_id": _hex_id32(),
                                    "task_id": self._ali_task_id,
                                    "namespace": "SpeechTranscriber",
                                    "name": "StopTranscription",
                                }
                            },
                            ensure_ascii=False,
                        )
                    )
            else:
                await self._ws.send(json.dumps(self._reset_message, ensure_ascii=False))
        except Exception:
            pass
        self._utterance_started = False
        if self._provider in ("aliyun_nls_asr", "aliyun_nls") or self._close_on_reset:
            await self.close()

    async def send_audio(self, audio: bytes):
        if not self._ws:
            if self._on_message:
                try:
                    await self.connect(self._on_message)
                except Exception:
                    return
            else:
                return
        ws = self._ws
        if not ws:
            return

        async def _send_once():
            if self._send_mode == "json":
                msg: dict = {}
                if self._audio_message:
                    msg.update(self._audio_message)
                msg[self._audio_field] = __import__("base64").b64encode(audio).decode("ascii")
                await ws.send(json.dumps(msg, ensure_ascii=False))
                return
            await ws.send(audio)

        try:
            await _send_once()
        except ConnectionClosedError as e:
            await _report_debug_event(
                "python:asr:ws-send-closed",
                {
                    "code": getattr(e, "code", None),
                    "reason": (getattr(e, "reason", None) or "")[:200],
                },
            )
            try:
                await self.close()
            except Exception:
                pass
            if self._on_message:
                try:
                    await self.connect(self._on_message)
                    ws2 = self._ws
                    if ws2:
                        ws = ws2
                        await _send_once()
                except Exception as e2:
                    await _report_debug_event("python:asr:ws-reconnect-failed", {"error": str(e2)[:300]})
        except Exception as e:
            await _report_debug_event("python:asr:ws-send-error", {"error": str(e)[:300]})
            try:
                await self.close()
            except Exception:
                pass

    async def _recv_loop(self):
        ws = self._ws
        if not ws:
            return
        try:
            async for raw in ws:
                if raw is None:
                    continue
                if isinstance(raw, (bytes, bytearray)):
                    try:
                        raw = raw.decode("utf-8", errors="ignore")
                    except Exception:
                        continue
                msg = _safe_json_loads(str(raw))
                if not isinstance(msg, dict):
                    continue

                if self._log_raw:
                    logger.debug("ASR<- %s", msg)

                if self._provider in ("aliyun_nls_asr", "aliyun_nls"):
                    header = msg.get("header") if isinstance(msg.get("header"), dict) else {}
                    name = header.get("name") if isinstance(header.get("name"), str) else ""
                    payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
                    if name == "TranscriptionResultChanged":
                        text = payload.get("result") if isinstance(payload.get("result"), str) else ""
                        text = text.strip()
                        if text and self._on_message:
                            await self._on_message(text, False, "", payload if isinstance(payload, dict) else {})
                        continue
                    if name == "SentenceEnd":
                        text = payload.get("result") if isinstance(payload.get("result"), str) else ""
                        text = text.strip()
                        if text and self._on_message:
                            await self._on_message(text, True, "", payload if isinstance(payload, dict) else {})
                        continue
                    continue

                if self._result_type_value is not None:
                    if msg.get(self._result_type_field) != self._result_type_value:
                        continue

                text = msg.get(self._result_text_field)
                if not isinstance(text, str):
                    continue
                text = text.strip()
                if not text:
                    continue

                is_final = _is_final(msg.get(self._result_final_field), self._treat_missing_final_as_final)
                user_id = ""
                if self._user_id_field:
                    v = msg.get(self._user_id_field)
                    if isinstance(v, str) and v:
                        user_id = v

                if self._on_message:
                    await self._on_message(text, is_final, user_id, msg)
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error("ASR recv loop error: %s", e)


class LocalQwenTts:
    def __init__(self):
        self._model = None
        self._model_id = _env("ORCHIDEA_VOICE_QWEN_MODEL") or "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
        self._speaker = _env("ORCHIDEA_VOICE_QWEN_SPEAKER") or "Vivian"
        self._language = _env("ORCHIDEA_VOICE_QWEN_LANGUAGE") or "Auto"
        self._instruct = _env("ORCHIDEA_VOICE_QWEN_INSTRUCT") or ""
        self._offline = _env("ORCHIDEA_VOICE_LOCAL_TTS_OFFLINE") in ("1", "true", "yes", "on") or _env("HF_HUB_OFFLINE") in ("1", "true", "yes", "on")
        self._disabled_until_ms = 0
        self._disabled_reason = ""

    def reset(self) -> None:
        self._model = None
        self._disabled_until_ms = 0
        self._disabled_reason = ""

    async def _ensure_model(self):
        if self._model is not None:
            return
        now_ms = int(__import__("time").time() * 1000)
        if int(self._disabled_until_ms or 0) > now_ms:
            raise RuntimeError(self._disabled_reason or "Qwen3-TTS temporarily unavailable")
        import torch
        from qwen_tts import Qwen3TTSModel

        device_map = "mps" if torch.backends.mps.is_available() else "cpu"
        # region debug-point tts-model-load
        load_id = uuid.uuid4().hex[:8]
        t0 = __import__("time").perf_counter()
        await _report_debug_event(
            "python:tts:model-load-start",
            {"id": load_id, "modelId": self._model_id, "deviceMap": device_map, "offline": bool(self._offline)},
        )

        async def _watchdog():
            await asyncio.sleep(30)
            await _report_debug_event(
                "python:tts:model-load-still-running",
                {"id": load_id, "secs": int(__import__("time").perf_counter() - t0)},
            )

        watchdog = asyncio.create_task(_watchdog())
        # endregion debug-point tts-model-load
        try:
            timeout_s = int(_env("ORCHIDEA_VOICE_MODEL_LOAD_TIMEOUT_S") or "30")
            self._model = await asyncio.wait_for(
                asyncio.to_thread(Qwen3TTSModel.from_pretrained, self._model_id, device_map=device_map),
                timeout=float(timeout_s),
            )
            watchdog.cancel()
            await _report_debug_event(
                "python:tts:model-load-ok",
                {"id": load_id, "ms": int((__import__("time").perf_counter() - t0) * 1000)},
            )
        except asyncio.TimeoutError as e:
            watchdog.cancel()
            await _report_debug_event(
                "python:tts:model-load-timeout",
                {"id": load_id, "secs": int(__import__("time").perf_counter() - t0), "timeoutS": timeout_s},
            )
            self._disabled_until_ms = int(__import__("time").time() * 1000) + 10 * 60 * 1000
            self._disabled_reason = f"Qwen3-TTS model load timeout ({timeout_s}s)"
            raise RuntimeError(f"Qwen3-TTS model load timeout ({timeout_s}s)") from e
        except Exception as e:
            watchdog.cancel()
            await _report_debug_event(
                "python:tts:model-load-error",
                {
                    "id": load_id,
                    "type": type(e).__name__,
                    "error": (str(e) or repr(e))[:500],
                    "ms": int((__import__("time").perf_counter() - t0) * 1000),
                },
            )
            if self._offline:
                self._disabled_until_ms = int(__import__("time").time() * 1000) + 10 * 60 * 1000
                self._disabled_reason = f"Qwen3-TTS offline mode: missing cache for {self._model_id}"
                raise RuntimeError(f"Qwen3-TTS offline mode: missing cache for {self._model_id}") from e
            self._disabled_until_ms = int(__import__("time").time() * 1000) + 10 * 60 * 1000
            self._disabled_reason = (str(e) or repr(e) or "Qwen3-TTS load failed")[:200]
            raise

    async def synth_wav(self, text: str) -> bytes:
        await self._ensure_model()
        if self._model is None:
            raise RuntimeError("Qwen3-TTS model not available")
        import numpy as np

        # region debug-point tts-generate-timing
        tts_run_id = uuid.uuid4().hex[:8]
        t0 = __import__("time").perf_counter()
        await _report_debug_event("python:tts:gen-start", {"id": tts_run_id, "chars": len(text)})

        async def _watchdog():
            await asyncio.sleep(30)
            await _report_debug_event(
                "python:tts:gen-still-running",
                {"id": tts_run_id, "secs": int(__import__("time").perf_counter() - t0)},
            )

        watchdog = asyncio.create_task(_watchdog())
        # endregion debug-point tts-generate-timing

        try:
            wavs, sr = await asyncio.to_thread(
                self._model.generate_custom_voice,
                text=text,
                language=self._language,
                speaker=self._speaker,
                instruct=self._instruct,
            )
        finally:
            watchdog.cancel()
            await _report_debug_event(
                "python:tts:gen-done",
                {"id": tts_run_id, "ms": int((__import__("time").perf_counter() - t0) * 1000)},
            )
        wav = wavs[0]
        if not isinstance(wav, np.ndarray):
            wav = np.array(wav)
        if wav.dtype != np.int16:
            wav = np.clip(wav, -1.0, 1.0)
            wav = (wav * 32767.0).astype(np.int16)

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(int(sr))
            wf.writeframes(wav.tobytes())
        return buf.getvalue()


async def _agent_chat(session: aiohttp.ClientSession, speaker_id: str, text: str, state: dict) -> str:
    url = (_env("ORCHIDEA_VOICE_AGENT_URL") or "").rstrip("/")
    token = _env("ORCHIDEA_VOICE_AGENT_TOKEN")
    if not url or not token:
        return ""

    t0 = __import__("time").perf_counter()
    user_id = (speaker_id or "user").strip() or "user"
    prompt_text = text
    if user_id and user_id != "user":
        prompt_text = f"[Speaker {user_id}] {text}"
    else:
        prompt_text = f"{text}\n\n你是语音助手，请直接回复用户。"

    payload: dict = {"text": prompt_text}
    sid = state.get(user_id)
    if isinstance(sid, str) and sid:
        payload["sessionId"] = sid
    else:
        payload["createNewSession"] = True

    try:
        await _report_debug_event("python:agent:chat-start", {"userId": user_id, "chars": len(prompt_text)})
        async with session.post(
            f"{url}/chat",
            data=json.dumps(payload),
            headers={"content-type": "application/json", "x-orchidea-token": token},
            timeout=aiohttp.ClientTimeout(total=120),
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                await _report_debug_event(
                    "python:agent:chat-non200",
                    {"status": resp.status, "userId": user_id, "body": body[:500]},
                )
                return ""
            data = await resp.json()
    except Exception as e:
        await _report_debug_event(
            "python:agent:chat-error",
            {
                "userId": user_id,
                "error": (str(e) or repr(e))[:500],
                "type": type(e).__name__,
                "ms": int((__import__("time").perf_counter() - t0) * 1000),
            },
        )
        return ""

    sid = data.get("sessionId")
    if isinstance(sid, str) and sid:
        state[user_id] = sid

    out = data.get("text")
    if isinstance(out, str):
        await _report_debug_event("python:agent:chat-end", {"userId": user_id, "ms": int((__import__("time").perf_counter() - t0) * 1000)})
        await _report_debug_event("python:agent:chat-ok", {"userId": user_id, "chars": len(out)})
        return out.strip()
    return ""


async def _agent_chat_with_timeout(session: aiohttp.ClientSession, speaker_id: str, text: str, state: dict, *, timeout_s: float) -> str:
    try:
        return await asyncio.wait_for(_agent_chat(session, speaker_id, text, state), timeout=timeout_s)
    except asyncio.TimeoutError:
        await _report_debug_event("python:agent:chat-timeout", {"userId": (speaker_id or "user"), "timeoutS": timeout_s})
        return ""


def _build_asr_config() -> tuple[str, dict, str, bool]:
    mode = _env("ORCHIDEA_VOICE_MODE") or "dualChat"

    asr_engine = _env("ORCHIDEA_VOICE_ASR_ENGINE")
    if asr_engine in ("funasr", "local"):
        cfg = {}
        return mode, cfg, "", True

    voiceprint_enabled = _env("ORCHIDEA_VOICE_VOICEPRINT_ENABLED") in ("1", "true", "yes", "on")
    voiceprint_params_raw = _env("ORCHIDEA_VOICE_VOICEPRINT_PARAMS_JSON") or "{}"

    if mode == "meeting":
        asr_url = _env("ORCHIDEA_VOICE_MEETING_ASR_WS_URL")
        asr_params_raw = _env("ORCHIDEA_VOICE_MEETING_ASR_PARAMS_JSON") or "{}"
        if voiceprint_enabled:
            asr_params_raw = _merge_json(asr_params_raw, voiceprint_params_raw)
    else:
        asr_url = _env("ORCHIDEA_VOICE_DUAL_ASR_WS_URL")
        asr_params_raw = _env("ORCHIDEA_VOICE_DUAL_ASR_PARAMS_JSON") or "{}"

    cfg = _safe_json_loads(asr_params_raw)
    if not isinstance(cfg, dict):
        cfg = {}

    # #region debug-point voiceprint-auto-auth-python-asr-config
    try:
        voiceprint_cfg = _safe_json_loads(voiceprint_params_raw)
        if not isinstance(voiceprint_cfg, dict):
            voiceprint_cfg = {}
    except Exception:
        voiceprint_cfg = {}
    asyncio.get_event_loop().create_task(
        _report_debug_event(
            "python:asr:config",
            {
                "mode": mode,
                "voiceprintEnabled": bool(voiceprint_enabled),
                "userIdField": str(cfg.get("userIdField") or ""),
                "scoreField": str(voiceprint_cfg.get("scoreField") or ""),
                "spkField": str(voiceprint_cfg.get("spkField") or ""),
                "diarization": bool(voiceprint_cfg.get("diarization") or False),
            },
        )
    )
    # #endregion debug-point voiceprint-auto-auth-python-asr-config

    if mode != "meeting":
        u = (asr_url or "").strip()
        if u.startswith("ws://") and "192.168.0.70:8000" in u and "/api/stream" in u:
            asr_url = "http://192.168.0.70:8000"
        if "language" not in cfg:
            cfg["language"] = "Chinese"
        if "return_time_stamps" not in cfg:
            cfg["return_time_stamps"] = False
        if "resultTextField" not in cfg:
            cfg["resultTextField"] = "text"
        if "model" not in cfg:
            cfg["model"] = "Qwen3-ASR-1.7B"
    return mode, cfg, asr_url, False


def _client_html() -> str:
    return """<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orchidea Voice</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; padding: 16px; background: #0b0b0c; color: #f2f2f2; }
      .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      button { background: #2b2d31; color: #fff; border: 1px solid #3b3d42; padding: 8px 12px; border-radius: 8px; cursor: pointer; }
      button[disabled] { opacity: 0.5; cursor: not-allowed; }
      .card { margin-top: 12px; padding: 12px; border-radius: 12px; border: 1px solid #2a2c30; background: rgba(255,255,255,0.04); }
      pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-size: 12px; opacity: 0.85; }
    </style>
  </head>
  <body>
    <div class="row">
      <button id="btnConnect">Connect</button>
      <button id="btnStart" disabled>Start</button>
      <button id="btnStop" disabled>Stop</button>
      <span id="status" style="opacity:0.8">disconnected</span>
    </div>
    <div class="card"><pre id="log"></pre></div>
    <script>
      const elLog = document.getElementById('log');
      const elStatus = document.getElementById('status');
      const btnConnect = document.getElementById('btnConnect');
      const btnStart = document.getElementById('btnStart');
      const btnStop = document.getElementById('btnStop');

      let ws = null;
      let audioCtx = null;
      let src = null;
      let proc = null;
      let ingestActive = false;

      function log(line) {
        elLog.textContent = (elLog.textContent + line + "\\n").slice(-8000);
      }

      function setStatus(s) {
        elStatus.textContent = s;
      }

      function floatTo16BitPCM(input) {
        const output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          let s = Math.max(-1, Math.min(1, input[i]));
          output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return output;
      }

      function downsampleBuffer(buffer, sampleRate, outSampleRate) {
        if (outSampleRate === sampleRate) return buffer;
        const ratio = sampleRate / outSampleRate;
        const newLen = Math.round(buffer.length / ratio);
        const result = new Float32Array(newLen);
        let offset = 0;
        for (let i = 0; i < newLen; i++) {
          const next = Math.round((i + 1) * ratio);
          let sum = 0;
          let count = 0;
          for (let j = offset; j < next && j < buffer.length; j++) {
            sum += buffer[j];
            count++;
          }
          result[i] = count ? sum / count : 0;
          offset = next;
        }
        return result;
      }

      async function startMic() {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        src = audioCtx.createMediaStreamSource(stream);
        proc = audioCtx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => {
          if (!ws || ws.readyState !== 1) return;
          const input = e.inputBuffer.getChannelData(0);
          const down = downsampleBuffer(input, audioCtx.sampleRate, 16000);
          const pcm16 = floatTo16BitPCM(down);
          ws.send(pcm16.buffer);
        };
        src.connect(proc);
        proc.connect(audioCtx.destination);
      }

      function stopMic() {
        try { proc && proc.disconnect(); } catch {}
        try { src && src.disconnect(); } catch {}
        try { audioCtx && audioCtx.close(); } catch {}
        proc = null; src = null; audioCtx = null;
      }

      function playWav(arrayBuffer) {
        const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play().catch(() => {});
      }

      btnConnect.onclick = () => {
        if (ws && ws.readyState === 1) return;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(proto + '//' + location.host + '/ws');
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          setStatus('connected');
          btnStart.disabled = false;
          log('[ws] open');
        };
        ws.onclose = () => {
          setStatus('disconnected');
          btnStart.disabled = true;
          btnStop.disabled = true;
          stopMic();
          log('[ws] close');
        };
        ws.onerror = () => log('[ws] error');
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === 'status') {
                ingestActive = Boolean(msg.ingestActive);
                log('[status] mode=' + (msg.mode || '') + ' ingestActive=' + ingestActive + ' recording=' + Boolean(msg.recording));
              }
              if (msg.type === 'asr') log('[asr] ' + (msg.final ? '(final) ' : '') + msg.text);
              if (msg.type === 'agent') log('[agent] ' + msg.text);
              if (msg.type === 'notes') log('[notes] ' + msg.text);
              if (msg.type === 'error') log('[error] ' + msg.message);
              return;
            } catch {}
            log('[msg] ' + ev.data);
            return;
          }
          playWav(ev.data);
        };
      };

      btnStart.onclick = async () => {
        if (!ws || ws.readyState !== 1) return;
        btnStart.disabled = true;
        btnStop.disabled = false;
        ws.send(JSON.stringify({ type: 'start' }));
        if (!ingestActive) {
          await startMic();
          log('[mic] started');
        } else {
          log('[capture] external ingest active');
        }
      };

      btnStop.onclick = () => {
        if (!ws || ws.readyState !== 1) return;
        btnStart.disabled = false;
        btnStop.disabled = true;
        stopMic();
        ws.send(JSON.stringify({ type: 'stop' }));
        log('[mic] stopped');
      };
    </script>
  </body>
</html>"""


async def handle_client(_request):
    return web.Response(text=_client_html(), content_type="text/html")


class VoiceServerState:
    def __init__(self, *, mode: str, cfg: dict, asr_url: str, local_asr: LocalFunASREngine | None = None):
        self.mode = mode
        self.cfg = cfg
        self.asr_url = asr_url
        self.local_asr = local_asr
        self._asr_is_local = local_asr is not None
        self.agent_state: dict[str, str] = {}
        self.tts = LocalQwenTts()
        self.tts_url = _env("ORCHIDEA_VOICE_TTS_URL")
        self.tts_cfg = _safe_json_loads(_env("ORCHIDEA_VOICE_TTS_PARAMS_JSON") or "{}")
        self._asr_is_http = _is_http_url(asr_url)
        self.asr = AsrClient(url=asr_url, cfg=cfg) if not self._asr_is_http and not self._asr_is_local else None
        self.session: aiohttp.ClientSession | None = None
        self._session: aiohttp.ClientSession | None = None
        self.listeners: set[web.WebSocketResponse] = set()
        self.ingest_connected = False
        self.recording = False
        self._lock = asyncio.Lock()
        self._notes_task: asyncio.Task | None = None
        self._transcript: list[tuple[str, str]] = []
        self._transcript_cursor = 0
        self._record_pcm_buf = bytearray()
        self._utterance_id = ""
        self._last_final_asr: tuple[str, str] | None = None
        self._last_agent_reply = ""
        self._last_notes = ""
        self._project_dir = _env("ORCHIDEA_VOICE_PROJECT_DIR") or ""
        self._last_asr_send_error_ts = 0
        self._wake_word = _env("ORCHIDEA_VOICE_WAKE_WORD") or "兰心"
        self._wake_latched = False
        self._wake_partial_tail: list[str] = []
        self._agent_invoked = False
        self._notes_requested = False
        self._debug_asr_text = _env("ORCHIDEA_VOICE_DEBUG_ASR_TEXT")
        self._debug_speaker_id = _env("ORCHIDEA_VOICE_DEBUG_SPEAKER_ID") or "spk1"
        self._debug_asr_sent = False
        self._debug_audio_chunk_count = 0
        self._debug_audio_reported = False
        self._speaker_alias_seq = 0
        self._speaker_alias_map: dict[str, str] = {}
        self._speaker_alias_reverse: dict[str, str] = {}
        self._voiceprint_enabled = (
            self.mode == "meeting"
            and (_env("ORCHIDEA_VOICE_VOICEPRINT_ENABLED") or "").lower().strip() in ("1", "true", "yes", "on")
        )
        self._voiceprint_score_field = str(self.cfg.get("scoreField") or "spk_score")
        try:
            self._voiceprint_threshold = float(self.cfg.get("scoreThreshold") or self.cfg.get("voiceprintThreshold") or 0.65)
        except Exception:
            self._voiceprint_threshold = 0.65
        try:
            self._voiceprint_min_samples = int(self.cfg.get("minScoreSamples") or self.cfg.get("minSamples") or 3)
        except Exception:
            self._voiceprint_min_samples = 3
        try:
            self._voiceprint_window = int(self.cfg.get("scoreWindow") or self.cfg.get("windowSize") or 12)
        except Exception:
            self._voiceprint_window = 12
        self._voiceprint_scores: dict[str, list[float]] = {}
        self._voiceprint_verified: dict[str, float] = {}

    async def _alias_speaker(self, raw_speaker_id: str) -> str:
        raw = (raw_speaker_id or "").strip()
        if not raw:
            return ""
        existing = self._speaker_alias_map.get(raw)
        if existing:
            return existing
        self._speaker_alias_seq += 1
        alias = f"user{self._speaker_alias_seq}"
        self._speaker_alias_map[raw] = alias
        self._speaker_alias_reverse[alias] = raw
        await _report_debug_event("python:speaker:alias", {"rawSpeakerId": raw, "speakerId": alias, "mode": self.mode})
        await self.broadcast_str({"type": "speaker", "speakerId": alias, "rawSpeakerId": raw})
        return alias

    async def ensure_started(self) -> bool:
        if self._asr_is_local:
            if self._session is None:
                self._session = aiohttp.ClientSession()
            return True
        if self.session is None:
            self.session = aiohttp.ClientSession()
        if self._asr_is_http:
            return True
        try:
            if self.asr:
                await self.asr.connect(self._on_asr)
            return True
        except Exception as e:
            await _report_debug_event("python:asr:connect-failed", {"mode": self.mode, "asrUrl": self.asr_url, "error": str(e)[:500]})
            await self.broadcast_str({"type": "error", "message": f"ASR connect failed: {str(e) or 'unknown'}"})
            return False

    async def close(self):
        try:
            if self.asr:
                await self.asr.close()
        except Exception:
            pass
        if self.local_asr:
            self.local_asr.unload()
        if self.session:
            try:
                await self.session.close()
            except Exception:
                pass
        self.session = None
        if self._session:
            try:
                await self._session.close()
            except Exception:
                pass
        self._session = None

    async def broadcast_str(self, payload: dict) -> int:
        raw = json.dumps(payload, ensure_ascii=False)
        sent = 0
        dead: list[web.WebSocketResponse] = []
        async with self._lock:
            listeners = list(self.listeners)
        for ws in listeners:
            try:
                await ws.send_str(raw)
                sent += 1
            except Exception as e:
                await _report_debug_event(
                    "python:ws:send-str-error",
                    {
                        "error": str(e)[:500] or "send_str_failed",
                        "mode": self.mode,
                        "wsClosed": bool(getattr(ws, "closed", False)),
                        "closeCode": getattr(ws, "close_code", None),
                        "exception": str(getattr(ws, "exception", lambda: None)() or "")[:500],
                        "listeners": len(self.listeners),
                    },
                )
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self.listeners.discard(ws)
        return sent

    async def broadcast_bytes(self, data: bytes) -> int:
        sent = 0
        dead: list[web.WebSocketResponse] = []
        async with self._lock:
            listeners = list(self.listeners)
        for ws in listeners:
            try:
                await ws.send_bytes(data)
                sent += 1
            except Exception as e:
                await _report_debug_event(
                    "python:ws:send-bytes-error",
                    {
                        "error": str(e)[:500] or "send_bytes_failed",
                        "bytes": len(data),
                        "mode": self.mode,
                        "wsClosed": bool(getattr(ws, "closed", False)),
                        "closeCode": getattr(ws, "close_code", None),
                        "exception": str(getattr(ws, "exception", lambda: None)() or "")[:500],
                        "listeners": len(self.listeners),
                    },
                )
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self.listeners.discard(ws)
        return sent

    def _spawn(self, coro, *, tag: str) -> None:
        async def _runner():
            try:
                await coro
            except Exception as e:
                await _report_debug_event("python:task:error", {"tag": tag, "error": str(e)[:500], "mode": self.mode})

        asyncio.create_task(_runner())

    def _maybe_latch_wake(self, text: str) -> None:
        if self._wake_latched:
            return
        current = (text or "").strip()
        if not current:
            return
        candidates = [current]
        if self._wake_partial_tail:
            candidates.append(self._wake_partial_tail[-1] + current)
        if len(self._wake_partial_tail) >= 2:
            candidates.append(self._wake_partial_tail[-2] + self._wake_partial_tail[-1] + current)
        for c in candidates:
            wake, _ = _extract_wake_content(c, self._wake_word)
            if wake:
                self._wake_latched = True
                break
        self._wake_partial_tail.append(current)
        if len(self._wake_partial_tail) > 3:
            self._wake_partial_tail = self._wake_partial_tail[-3:]

    async def set_recording(self, on: bool) -> None:
        persist_job: tuple[str, bytes, tuple[str, str] | None, list[tuple[str, str]]] | None = None
        persist_meeting_job: tuple[str, bytes, int, str] | None = None
        http_finalize: tuple[str, bytes, str] | None = None
        local_asr_pcm: bytes | None = None
        mode = self.mode
        async with self._lock:
            if on == self.recording:
                return
            self.recording = on
            try:
                if on:
                    self._utterance_id = self._new_utterance_id()
                    self._record_pcm_buf.clear()
                    self._last_final_asr = None
                    self._last_agent_reply = ""
                    self._wake_latched = False
                    self._wake_partial_tail = []
                    self._agent_invoked = False
                    self._notes_requested = False
                    self._debug_asr_sent = False
                    self._debug_audio_chunk_count = 0
                    self._debug_audio_reported = False
                    self._transcript_cursor = len(self._transcript)
                    if (not self._asr_is_http) and not self._asr_is_local and self.asr:
                        await self.asr.start_utterance()
                else:
                    utterance_id = self._utterance_id or self._new_utterance_id()
                    pcm_for_save = bytes(self._record_pcm_buf)
                    self._record_pcm_buf.clear()
                    self._utterance_id = ""
                    if self._asr_is_http:
                        http_finalize = (utterance_id, pcm_for_save, mode)
                    elif self._asr_is_local and self.local_asr and pcm_for_save:
                        local_asr_pcm = pcm_for_save
                    elif self.asr:
                        await self.asr.end_utterance()
                    if mode == "meeting":
                        persist_meeting_job = (utterance_id, pcm_for_save, self._transcript_cursor, mode)
                    else:
                        persist_job = (utterance_id, pcm_for_save, self._last_final_asr, list(self._transcript))
            except Exception:
                pass
        await _report_debug_event(
            "python:recording:set",
            {
                "on": bool(on),
                "mode": self.mode,
                "ingestConnected": bool(self.ingest_connected),
                "listeners": len(self.listeners),
            },
        )
        await self.broadcast_str({"type": "status", "ingestActive": self.ingest_connected, "recording": self.recording, "mode": self.mode})
        if on:
            return
        if local_asr_pcm:
            result = self.local_asr.transcribe(local_asr_pcm, sample_rate=16000)
            text = result.get("text", "")
            sentences = result.get("sentences", [])
            usable_sentences: list[dict] = []
            if isinstance(sentences, list):
                for seg in sentences:
                    if not isinstance(seg, dict):
                        continue
                    seg_text = seg.get("text", "")
                    if isinstance(seg_text, str) and seg_text.strip():
                        usable_sentences.append(seg)

            if usable_sentences:
                for seg in usable_sentences:
                    seg_text = seg.get("text", "")
                    speaker = seg.get("speaker", 0)
                    emotion = seg.get("emotion", "neutral")
                    raw = {"emotion": emotion, "events": seg.get("audio_events", [])}
                    await self._on_asr(seg_text, True, str(speaker), raw)
            elif isinstance(text, str) and text.strip():
                await self._on_asr(text, True, "0", {})
        if http_finalize:
            utterance_id, pcm_for_save, finalize_mode = http_finalize
            if pcm_for_save:
                self._spawn(
                    self._finalize_http_stop(utterance_id=utterance_id, pcm16=pcm_for_save, mode=finalize_mode),
                    tag="finalize-http-stop",
                )
            else:
                self._spawn(
                    self._persist_after_stop(
                        utterance_id=utterance_id,
                        pcm16=b"",
                        last_asr=None,
                        transcript=[],
                        mode=finalize_mode,
                        reply=None,
                    ),
                    tag="persist-after-stop-empty",
                )
            return
        if persist_meeting_job:
            utterance_id, pcm_for_save, start_idx, persist_mode = persist_meeting_job
            self._spawn(
                self._persist_meeting_after_stop(utterance_id=utterance_id, pcm16=pcm_for_save, start_idx=start_idx, mode=persist_mode),
                tag="persist-after-stop-meeting",
            )
            return
        if persist_job:
            utterance_id, pcm_for_save, last_asr, transcript = persist_job
            self._spawn(
                self._persist_after_stop(
                    utterance_id=utterance_id,
                    pcm16=pcm_for_save,
                    last_asr=last_asr,
                    transcript=transcript,
                    mode=mode,
                    reply=None,
                ),
                tag="persist-after-stop",
            )

    async def _persist_meeting_after_stop(self, *, utterance_id: str, pcm16: bytes, start_idx: int, mode: str) -> None:
        deadline = __import__("time").time() + 5.0
        while __import__("time").time() < deadline:
            if self._last_final_asr is not None and len(self._transcript) > start_idx:
                break
            await asyncio.sleep(0.2)
        transcript = list(self._transcript[start_idx:])
        await self._persist_after_stop(
            utterance_id=utterance_id,
            pcm16=pcm16,
            last_asr=self._last_final_asr,
            transcript=transcript,
            mode=mode,
            reply=None,
        )

    async def push_audio(self, audio: bytes) -> None:
        if not self.recording:
            return
        self._debug_audio_chunk_count += 1
        if (not self._debug_audio_reported) or self._debug_audio_chunk_count in (10, 50):
            self._debug_audio_reported = True
            await _report_debug_event(
                "python:audio:chunk",
                {
                    "bytes": len(audio),
                    "chunks": self._debug_audio_chunk_count,
                    "mode": self.mode,
                    "ingestConnected": bool(self.ingest_connected),
                },
            )
        self._record_pcm_buf.extend(audio)
        if self._asr_is_http:
            return
        if self._asr_is_local:
            # Local engine handles in batch at stop time — just buffer
            return
        if self._debug_asr_text and (not self._debug_asr_sent):
            self._debug_asr_sent = True
            await _report_debug_event("python:asr:debug", {"chars": len(self._debug_asr_text), "speakerId": self._debug_speaker_id})
            await self._on_asr(self._debug_asr_text, True, self._debug_speaker_id, {"debug": True})
            return
        if self.asr:
            try:
                await self.asr.send_audio(audio)
            except Exception as e:
                now = int(__import__("time").time() * 1000)
                if now - int(self._last_asr_send_error_ts or 0) > 1000:
                    self._last_asr_send_error_ts = now
                    await self.broadcast_str(
                        {
                            "type": "error",
                            "message": "ASR WS 断开，正在重连（如持续出现请检查 ASR 服务是否支持 WS / 是否被 keepalive 拒绝）。",
                        }
                    )
                await _report_debug_event("python:asr:send-audio-error", {"error": str(e)[:300]})

    async def _http_asr_transcribe(self, pcm16: bytes) -> str:
        if self.local_asr:
            try:
                result = self.local_asr.transcribe(pcm16, sample_rate=16000)
                return result.get("text", "")
            except Exception as e:
                logger.exception("local_asr_transcribe_failed")
                return ""
        if self.session is None:
            self.session = aiohttp.ClientSession()

        url = (self.asr_url or "").strip()
        if url:
            p = urlparse(url)
            if p.path in ("", "/"):
                url = url.rstrip("/") + "/v1/audio/transcriptions"
        is_openai_transcriptions = "/v1/audio/transcriptions" in url

        language = self.cfg.get("language")
        if not isinstance(language, str) or not language:
            language = "Chinese"
        return_time_stamps = bool(self.cfg.get("return_time_stamps") or False)
        text_field = self.cfg.get("resultTextField")
        if not isinstance(text_field, str) or not text_field:
            text_field = "text"
        model = self.cfg.get("model")
        if not isinstance(model, str) or not model:
            model = "Qwen3-ASR-1.7B"

        wav_bytes = _pcm16_to_wav_bytes(pcm16, sample_rate=16000)
        form = aiohttp.FormData()
        if is_openai_transcriptions:
            form.add_field("file", wav_bytes, filename="audio.wav", content_type="audio/wav")
            form.add_field("model", model)
            form.add_field("response_format", "json")
        else:
            form.add_field("file", wav_bytes, filename="audio.wav", content_type="application/octet-stream")
            form.add_field("language", language)
            form.add_field("return_time_stamps", "true" if return_time_stamps else "false")

        try:
            async with self.session.post(url, data=form, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                data = await resp.json()
                if resp.status != 200:
                    await _report_debug_event("python:asr:http-failed", {"status": resp.status, "data": data})
                    await self.broadcast_str({"type": "error", "message": f"ASR HTTP failed: {resp.status}"})
                    return ""
        except Exception as e:
            await _report_debug_event("python:asr:http-error", {"error": str(e)[:500]})
            await self.broadcast_str({"type": "error", "message": f"ASR HTTP error: {str(e) or 'unknown'}"})
            return ""

        if is_openai_transcriptions:
            out = data.get("text") if isinstance(data, dict) else None
        else:
            out = data.get(text_field) if isinstance(data, dict) else None
        if isinstance(out, str):
            return out.strip()
        return ""

    async def _on_asr(self, text: str, is_final: bool, speaker_id: str, _raw: dict):
        raw_speaker_id = speaker_id
        speaker_id = await self._alias_speaker(speaker_id)
        # #region debug-point voiceprint-auto-auth-python-asr-raw
        voiceprint_score = None
        voiceprint_avg = None
        voiceprint_verified = False
        try:
            raw_keys = list(_raw.keys()) if isinstance(_raw, dict) else []
            score_field = self._voiceprint_score_field
            if isinstance(_raw, dict) and score_field in _raw:
                v = _raw.get(score_field)
                if isinstance(v, (int, float, str)):
                    try:
                        voiceprint_score = float(v)
                    except Exception:
                        voiceprint_score = None
            if self._voiceprint_enabled and speaker_id and voiceprint_score is not None:
                arr = self._voiceprint_scores.get(speaker_id) or []
                arr.append(float(voiceprint_score))
                if len(arr) > max(1, self._voiceprint_window):
                    arr = arr[-max(1, self._voiceprint_window) :]
                self._voiceprint_scores[speaker_id] = arr
                voiceprint_avg = sum(arr) / float(len(arr) or 1)
                voiceprint_verified = speaker_id in self._voiceprint_verified
                if (not voiceprint_verified) and len(arr) >= max(1, self._voiceprint_min_samples) and float(voiceprint_avg) >= float(self._voiceprint_threshold):
                    self._voiceprint_verified[speaker_id] = float(voiceprint_avg)
                    voiceprint_verified = True
                    await _report_debug_event(
                        "python:voiceprint:verified",
                        {
                            "speakerId": speaker_id,
                            "score": float(voiceprint_avg),
                            "threshold": float(self._voiceprint_threshold),
                            "samples": len(arr),
                            "mode": self.mode,
                        },
                    )
                    await self.broadcast_str(
                        {
                            "type": "voiceprint",
                            "userId": speaker_id,
                            "score": float(voiceprint_avg),
                            "threshold": float(self._voiceprint_threshold),
                            "samples": len(arr),
                            "verified": True,
                        }
                    )
            await _report_debug_event(
                "python:asr:voiceprint",
                {
                    "mode": self.mode,
                    "final": bool(is_final),
                    "speakerId": speaker_id,
                    "rawSpeakerId": raw_speaker_id,
                    "scoreField": score_field,
                    "score": voiceprint_score,
                    "avg": voiceprint_avg,
                    "verified": bool(voiceprint_verified),
                    "rawKeys": raw_keys[:50],
                },
            )
        except Exception:
            pass
        # #endregion debug-point voiceprint-auto-auth-python-asr-raw
        await _report_debug_event(
            "python:asr:message",
            {
                "final": bool(is_final),
                "speakerId": speaker_id,
                "rawSpeakerId": raw_speaker_id,
                "textPreview": (text or "")[:120],
                "textLength": len(text or ""),
                "mode": self.mode,
            },
        )
        if speaker_id:
            if (not self._voiceprint_enabled) or (voiceprint_score is None) or bool(voiceprint_verified):
                await self._notify_active_speaker(speaker_id)
        await self.broadcast_str({"type": "asr", "text": text, "final": bool(is_final), "userId": speaker_id})

        if not is_final:
            self._maybe_latch_wake(text)
            return

        self._last_final_asr = (speaker_id or "", text)
        if self.mode == "meeting":
            self._transcript.append((speaker_id or "spk", text))
            wake, content = _extract_wake_content(text, self._wake_word)
            if (not wake) and self._wake_latched:
                wake = True
                content = text[2:] if isinstance(text, str) and len(text) >= 2 else ""
            if wake:
                content = content.lstrip(" ,，。.!！?？:：;；")
                content = content.strip()
                want_notes = any(k in content for k in ("会议纪要", "纪要", "总结", "会议总结", "会议记录"))
                if want_notes:
                    self._notes_requested = True
                    await self.broadcast_str({"type": "agent", "text": "好的，我来整理会议纪要。"})
                    await self._tts_speak("好的，我来整理会议纪要。")
                    self._schedule_notes_update(delay_s=0.0)
                if content and (not want_notes):
                    self._agent_invoked = True
                    await self._reply_and_maybe_speak(speaker_id, content, speak=True)
            return

        wake, content = _extract_wake_content(text, self._wake_word)
        if (not wake) and self._wake_latched:
            wake = True
            content = text[2:] if isinstance(text, str) and len(text) >= 2 else ""
        if not wake:
            return
        content = content.lstrip(" ,，。.!！?？:：;；")
        content = content.strip()
        if not content:
            return
        want_notes = any(k in content for k in ("会议纪要", "纪要", "总结"))
        if want_notes:
            self._notes_requested = True
            await self.broadcast_str({"type": "agent", "text": "好的，我来整理纪要。"})
            await self._tts_speak("好的，我来整理纪要。")
            return
        self._agent_invoked = True
        await self._reply_and_maybe_speak(speaker_id, content, speak=True)

    async def _notify_active_speaker(self, speaker_id: str) -> None:
        url = (_env("ORCHIDEA_VOICE_AGENT_URL") or "").rstrip("/")
        token = _env("ORCHIDEA_VOICE_AGENT_TOKEN")
        if not url or not token:
            return
        try:
            async with aiohttp.ClientSession() as s:
                await s.post(
                    f"{url}/active-speaker",
                    data=json.dumps({"userId": speaker_id}),
                    headers={"content-type": "application/json", "x-orchidea-token": token},
                    timeout=aiohttp.ClientTimeout(total=5),
                )
        except Exception:
            return

    async def _reply_and_maybe_speak(self, speaker_id: str, text: str, *, speak: bool) -> None:
        if self.session is None:
            self.session = aiohttp.ClientSession()
        debug_reply = _env("ORCHIDEA_VOICE_DEBUG_REPLY_TEXT")
        if debug_reply:
            await _report_debug_event("python:agent:bypassed", {"mode": self.mode, "chars": len(debug_reply)})
            reply = debug_reply
        else:
            timeout_s = float(_env("ORCHIDEA_VOICE_AGENT_TIMEOUT_S") or "20")
            reply = await _agent_chat_with_timeout(self.session, speaker_id, text, self.agent_state, timeout_s=timeout_s)
        if not reply:
            await self.broadcast_str(
                {
                    "type": "agent",
                    "text": "（Agent 无响应或未配置。请到 Settings → Providers/Chat 配置可用模型与 API Key 后重试。）",
                }
            )
            await self.broadcast_str({"type": "error", "message": "Agent 无响应或未配置（timeout/non-200）。"})
            return
        self._last_agent_reply = reply
        await self.broadcast_str({"type": "agent", "text": reply})
        if not speak:
            return
        await self._tts_speak(reply)

    async def _tts_aliyun_stream_wav(self, text: str) -> bytes:
        cfg = self.tts_cfg if isinstance(self.tts_cfg, dict) else {}
        url = str(self.tts_url or "").strip()
        appkey = str(cfg.get("appKey") or "")
        if not url or not appkey:
            raise RuntimeError("Aliyun TTS missing url/appKey")
        task_id = _hex_id32()
        audio_parts: list[bytes] = []
        ws = await websockets.connect(
            url,
            open_timeout=10,
            ping_interval=None,
            ping_timeout=None,
            close_timeout=1,
        )
        try:
            await ws.send(
                json.dumps(
                    {
                        "header": {
                            "message_id": _hex_id32(),
                            "task_id": task_id,
                            "namespace": "FlowingSpeechSynthesizer",
                            "name": "StartSynthesis",
                            "appkey": appkey,
                        },
                        "payload": {
                            "voice": str(cfg.get("voice") or "xiaoyun"),
                            "format": str(cfg.get("format") or "wav"),
                            "sample_rate": int(cfg.get("sampleRate") or 16000),
                            "volume": int(cfg.get("volume") or 50),
                            "speech_rate": int(cfg.get("speechRate") or 0),
                            "pitch_rate": int(cfg.get("pitchRate") or 0),
                            "enable_subtitle": bool(cfg.get("enableSubtitle") or False),
                            "enable_phoneme_timestamp": bool(cfg.get("enablePhonemeTimestamp") or False),
                        },
                    },
                    ensure_ascii=False,
                )
            )
            await ws.send(
                json.dumps(
                    {
                        "header": {
                            "message_id": _hex_id32(),
                            "task_id": task_id,
                            "namespace": "FlowingSpeechSynthesizer",
                            "name": "RunSynthesis",
                            "appkey": appkey,
                        },
                        "payload": {"text": text},
                    },
                    ensure_ascii=False,
                )
            )
            await ws.send(
                json.dumps(
                    {
                        "header": {
                            "message_id": _hex_id32(),
                            "task_id": task_id,
                            "namespace": "FlowingSpeechSynthesizer",
                            "name": "StopSynthesis",
                            "appkey": appkey,
                        }
                    },
                    ensure_ascii=False,
                )
            )

            async for raw in ws:
                if raw is None:
                    continue
                if isinstance(raw, (bytes, bytearray)):
                    audio_parts.append(bytes(raw))
                    continue
                msg = _safe_json_loads(str(raw))
                if not isinstance(msg, dict):
                    continue
                header = msg.get("header") if isinstance(msg.get("header"), dict) else {}
                name = header.get("name") if isinstance(header.get("name"), str) else ""
                if name == "SynthesisCompleted":
                    break
        finally:
            try:
                await ws.close()
            except Exception:
                pass

        return b"".join(audio_parts)

    async def _tts_speak(self, reply: str) -> None:
        tts_text = (reply or "").replace("\n", " ").replace("·", " ").strip()
        tts_text = " ".join(tts_text.split())
        truncated = False
        if len(tts_text) > 280:
            tts_text = tts_text[:280]
            truncated = True
        try:
            if (
                self.tts_url
                and isinstance(self.tts_cfg, dict)
                and str(self.tts_cfg.get("provider") or "").strip().lower() in ("aliyun_nls_tts", "aliyun_nls")
            ):
                stage = "aliyun"
                t0 = __import__("time").perf_counter()
                wav = await self._tts_aliyun_stream_wav(tts_text)
                synth_ms = int((__import__("time").perf_counter() - t0) * 1000)
                await _report_debug_event("python:tts:aliyun:ok", {"bytes": len(wav), "mode": self.mode, "synthMs": synth_ms})
                if wav:
                    sent_to = await self.broadcast_bytes(wav)
                    await _report_debug_event("python:tts:sent", {"bytes": len(wav), "mode": self.mode, "sentTo": sent_to, "provider": "aliyun"})
                    return

            if sys.platform == "darwin" and _env("ORCHIDEA_VOICE_TTS_PREFER_SAY").lower() not in ("0", "false", "no", "off"):
                stage = "prefer-say"
                t0 = __import__("time").perf_counter()

                def _run_say() -> bytes:
                    with tempfile.TemporaryDirectory() as d:
                        aiff = os.path.join(d, "tts.aiff")
                        wav = os.path.join(d, "tts.wav")
                        subprocess.run(["/usr/bin/say", tts_text, "-o", aiff], check=True)
                        subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav], check=True)
                        with open(wav, "rb") as f:
                            return f.read()

                wav = await asyncio.wait_for(asyncio.to_thread(_run_say), timeout=15.0)
                synth_ms = int((__import__("time").perf_counter() - t0) * 1000)
                await _report_debug_event("python:tts:fallback-say", {"bytes": len(wav), "mode": self.mode, "synthMs": synth_ms, "prefer": True})
                sent_to = await self.broadcast_bytes(wav)
                await _report_debug_event("python:tts:sent", {"bytes": len(wav), "mode": self.mode, "sentTo": sent_to, "fallback": True, "prefer": True})
                return

            stage = "synth"
            t0 = __import__("time").perf_counter()
            await _report_debug_event(
                "python:tts:start",
                {"mode": self.mode, "chars": len(tts_text), "truncated": truncated, "listeners": len(self.listeners)},
            )
            wav = await self.tts.synth_wav(tts_text)
            synth_ms = int((__import__("time").perf_counter() - t0) * 1000)
            await _report_debug_event("python:tts:synth-ok", {"bytes": len(wav), "mode": self.mode, "synthMs": synth_ms})
            stage = "send"
            t1 = __import__("time").perf_counter()
            sent_to = await self.broadcast_bytes(wav)
            send_ms = int((__import__("time").perf_counter() - t1) * 1000)
            await _report_debug_event(
                "python:tts:sent",
                {"bytes": len(wav), "mode": self.mode, "sendMs": send_ms, "sentTo": sent_to, "listeners": len(self.listeners)},
            )
        except Exception as e:
            message = str(e) or "TTS error"
            if "Broken pipe" in message:
                try:
                    self.tts.reset()
                    await _report_debug_event("python:tts:retry", {"mode": self.mode})
                    wav = await self.tts.synth_wav(tts_text)
                    await _report_debug_event("python:tts:synth-ok", {"bytes": len(wav), "mode": self.mode, "retry": True})
                    await self.broadcast_bytes(wav)
                    await _report_debug_event("python:tts:sent", {"bytes": len(wav), "mode": self.mode, "retry": True})
                    return
                except Exception as e2:
                    message = str(e2) or message
            if sys.platform == "darwin" and _env("ORCHIDEA_VOICE_TTS_FALLBACK_SAY").lower() not in ("0", "false", "no", "off"):
                try:
                    stage = "fallback-say"
                    t0 = __import__("time").perf_counter()

                    def _run_say() -> bytes:
                        with tempfile.TemporaryDirectory() as d:
                            aiff = os.path.join(d, "tts.aiff")
                            wav = os.path.join(d, "tts.wav")
                            subprocess.run(["/usr/bin/say", tts_text, "-o", aiff], check=True)
                            subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav], check=True)
                            with open(wav, "rb") as f:
                                return f.read()

                    wav = await asyncio.wait_for(asyncio.to_thread(_run_say), timeout=15.0)
                    synth_ms = int((__import__("time").perf_counter() - t0) * 1000)
                    await _report_debug_event("python:tts:fallback-say", {"bytes": len(wav), "mode": self.mode, "synthMs": synth_ms})
                    sent_to = await self.broadcast_bytes(wav)
                    await _report_debug_event("python:tts:sent", {"bytes": len(wav), "mode": self.mode, "sentTo": sent_to, "fallback": True})
                    return
                except Exception as e3:
                    message = str(e3) or message
            await _report_debug_event("python:tts:error", {"error": message[:500], "mode": self.mode, "stage": locals().get("stage", "unknown")})
            await self.broadcast_str({"type": "error", "message": message})

    async def _finalize_http_stop(self, *, utterance_id: str, pcm16: bytes, mode: str) -> None:
        if not pcm16:
            return
        if self.session is None:
            self.session = aiohttp.ClientSession()
        last_asr: tuple[str, str] | None = None
        reply: str | None = None
        try:
            text = await self._http_asr_transcribe(pcm16)
            if text:
                last_asr = ("", text)
                await self.broadcast_str({"type": "asr", "text": text, "final": True, "userId": ""})
                wake, content = _extract_wake_content(text, self._wake_word)
                if not wake:
                    return
                content = content.lstrip(" ,，。.!！?？:：;；")
                content = content.strip()
                if not content:
                    return
                debug_reply = _env("ORCHIDEA_VOICE_DEBUG_REPLY_TEXT")
                if debug_reply:
                    await _report_debug_event("python:agent:bypassed", {"mode": self.mode, "chars": len(debug_reply), "transport": "http"})
                    reply = debug_reply
                else:
                    timeout_s = float(_env("ORCHIDEA_VOICE_AGENT_TIMEOUT_S") or "20")
                    reply = await _agent_chat_with_timeout(self.session, "", content, self.agent_state, timeout_s=timeout_s)
                if reply:
                    await self.broadcast_str({"type": "agent", "text": reply})
                    await self._tts_speak(reply)
                else:
                    await self.broadcast_str(
                        {
                            "type": "agent",
                            "text": "（Agent 无响应或未配置。请到 Settings → Providers/Chat 配置可用模型与 API Key 后重试。）",
                        }
                    )
                    await self.broadcast_str({"type": "error", "message": "Agent 无响应或未配置（timeout/non-200）。"})
        except Exception as e:
            await _report_debug_event("python:http-finalize:error", {"error": str(e)[:500], "mode": mode})
        try:
            await self._persist_after_stop(
                utterance_id=utterance_id,
                pcm16=pcm16,
                last_asr=last_asr,
                transcript=[],
                mode=mode,
                reply=reply,
            )
        except Exception as e:
            await _report_debug_event("python:persist:error", {"error": str(e)[:500], "mode": mode})

    def _schedule_notes_update(self, *, delay_s: float = 1.2) -> None:
        if self._notes_task and not self._notes_task.done():
            self._notes_task.cancel()
        self._notes_task = asyncio.create_task(self._notes_update(delay_s=delay_s))

    async def _notes_update(self, *, delay_s: float) -> None:
        try:
            if delay_s > 0:
                await asyncio.sleep(float(delay_s))
        except asyncio.CancelledError:
            return

        if not self._notes_requested:
            return

        if self.session is None:
            self.session = aiohttp.ClientSession()

        tail = self._transcript[-40:]
        lines = []
        for spk, t in tail:
            sid = spk or "spk"
            lines.append(f"{sid}: {t}")
        prompt = (
            "你是会议助理。请根据以下最近的会议转写，输出：\n"
            "1) 最新会议纪要（要点列表）\n"
            "2) 行动项（带负责人/截止，如无法确定则标未知）\n"
            "3) 建议/风险提示（最多3条）\n\n"
            "会议转写：\n" + "\n".join(lines)
        )
        debug_notes = _env("ORCHIDEA_VOICE_DEBUG_NOTES_TEXT")
        if debug_notes:
            out = debug_notes
        else:
            timeout_s = float(_env("ORCHIDEA_VOICE_NOTES_TIMEOUT_S") or "30")
            out = await _agent_chat_with_timeout(self.session, "meeting-notes", prompt, self.agent_state, timeout_s=timeout_s)
        if out:
            self._last_notes = out
            await self.broadcast_str({"type": "notes", "text": out})

    def _new_utterance_id(self) -> str:
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"{ts}_{uuid.uuid4().hex[:8]}"

    def _voice_dirs(self, *, mode: str) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
        project_dir = self._project_dir or os.getcwd()
        root = pathlib.Path(project_dir) / "voice"
        kind = "会议" if mode == "meeting" else "语音"
        base = root / kind
        audio_dir = base / "音频"
        transcript_dir = base / "转写文字"
        notes_dir = base / "ai整理的纪要"
        return audio_dir, transcript_dir, notes_dir

    async def _write_bytes(self, path: pathlib.Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_bytes, data)

    async def _write_text(self, path: pathlib.Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_text, text, encoding="utf-8")

    async def _persist_after_stop(
        self,
        *,
        utterance_id: str,
        pcm16: bytes,
        last_asr: tuple[str, str] | None,
        transcript: list[tuple[str, str]],
        mode: str,
        reply: str | None = None,
    ) -> None:
        # region debug-point voice-persist-paths
        await _report_debug_event(
            "python:persist:paths",
            {
                "mode": mode,
                "utteranceId": utterance_id,
                "projectDir": self._project_dir or "",
                "cwd": os.getcwd(),
            },
        )
        # endregion debug-point voice-persist-paths
        audio_dir, transcript_dir, notes_dir = self._voice_dirs(mode=mode)
        audio_dir.mkdir(parents=True, exist_ok=True)
        transcript_dir.mkdir(parents=True, exist_ok=True)
        notes_dir.mkdir(parents=True, exist_ok=True)
        stem = utterance_id

        if pcm16:
            wav_bytes = _pcm16_to_wav_bytes(pcm16, sample_rate=16000)
            await self._write_bytes(audio_dir / f"{stem}.wav", wav_bytes)
            # region debug-point voice-persist-files
            await _report_debug_event(
                "python:persist:file",
                {
                    "mode": mode,
                    "utteranceId": utterance_id,
                    "kind": "audio",
                    "path": str(audio_dir / f"{stem}.wav"),
                    "bytes": len(wav_bytes),
                },
            )
            # endregion debug-point voice-persist-files

        if mode == "meeting":
            lines = [f"{spk}: {t}" for spk, t in transcript]
            transcript_text = "\n".join(lines).strip()
            if transcript_text:
                await self._write_text(transcript_dir / f"{stem}.txt", transcript_text + "\n")
                await self._write_text(
                    transcript_dir / f"{stem}.json",
                    json.dumps({"mode": mode, "utteranceId": utterance_id, "lines": transcript}, ensure_ascii=False, indent=2) + "\n",
                )
                # region debug-point voice-persist-files
                await _report_debug_event(
                    "python:persist:file",
                    {
                        "mode": mode,
                        "utteranceId": utterance_id,
                        "kind": "transcript",
                        "pathTxt": str(transcript_dir / f"{stem}.txt"),
                        "pathJson": str(transcript_dir / f"{stem}.json"),
                        "chars": len(transcript_text),
                    },
                )
                # endregion debug-point voice-persist-files
        else:
            speaker_id = last_asr[0] if last_asr else ""
            asr_text = last_asr[1] if last_asr else ""
            if asr_text:
                await self._write_text(transcript_dir / f"{stem}.txt", asr_text.strip() + "\n")
                await self._write_text(
                    transcript_dir / f"{stem}.json",
                    json.dumps({"mode": mode, "utteranceId": utterance_id, "speakerId": speaker_id, "text": asr_text}, ensure_ascii=False, indent=2) + "\n",
                )
                # region debug-point voice-persist-files
                await _report_debug_event(
                    "python:persist:file",
                    {
                        "mode": mode,
                        "utteranceId": utterance_id,
                        "kind": "transcript",
                        "pathTxt": str(transcript_dir / f"{stem}.txt"),
                        "pathJson": str(transcript_dir / f"{stem}.json"),
                        "chars": len(asr_text),
                    },
                )
                # endregion debug-point voice-persist-files

        notes = ""
        if self._notes_requested:
            notes = await self._generate_notes(mode=mode, last_asr=last_asr, transcript=transcript, reply=reply)
        if notes:
            await self._write_text(notes_dir / f"{stem}.md", notes.strip() + "\n")
            # region debug-point voice-persist-files
            await _report_debug_event(
                "python:persist:file",
                {
                    "mode": mode,
                    "utteranceId": utterance_id,
                    "kind": "notes",
                    "path": str(notes_dir / f"{stem}.md"),
                    "chars": len(notes),
                },
            )
            # endregion debug-point voice-persist-files

    async def _generate_notes(
        self,
        *,
        mode: str,
        last_asr: tuple[str, str] | None,
        transcript: list[tuple[str, str]],
        reply: str | None = None,
    ) -> str:
        if self.session is None:
            self.session = aiohttp.ClientSession()
        debug_notes = _env("ORCHIDEA_VOICE_DEBUG_NOTES_TEXT")
        if debug_notes:
            return debug_notes.strip()
        if mode == "meeting":
            lines = []
            for spk, t in transcript[-200:]:
                sid = spk or "spk"
                lines.append(f"{sid}: {t}")
            if not lines:
                return ""
            prompt = (
                "你是会议助理。请根据以下会议转写，输出：\n"
                "1) 会议纪要（要点列表）\n"
                "2) 行动项（带负责人/截止，如无法确定则标未知）\n"
                "3) 结论/待确认事项\n\n"
                "会议转写：\n" + "\n".join(lines)
            )
            timeout_s = float(_env("ORCHIDEA_VOICE_NOTES_TIMEOUT_S") or "30")
            out = await _agent_chat_with_timeout(self.session, "meeting-final-notes", prompt, self.agent_state, timeout_s=timeout_s)
            return out.strip() if isinstance(out, str) else ""

        asr_text = last_asr[1].strip() if last_asr and last_asr[1] else ""
        if not asr_text:
            return ""
        reply_text = (reply if reply is not None else (self._last_agent_reply or "")).strip()
        prompt = (
            "你是语音助手。请根据以下转写内容，输出：\n"
            "1) 本次语音纪要（要点列表）\n"
            "2) 待办/行动项（如无则写无）\n"
            "3) 关键词（3-8个）\n\n"
            f"转写：\n{asr_text}\n\n"
        )
        if reply_text:
            prompt += f"助手回复：\n{reply_text}\n\n"
        timeout_s = float(_env("ORCHIDEA_VOICE_NOTES_TIMEOUT_S") or "30")
        out = await _agent_chat_with_timeout(self.session, "voice-notes", prompt, self.agent_state, timeout_s=timeout_s)
        return out.strip() if isinstance(out, str) else ""


async def handle_ws(request):
    state: VoiceServerState = request.app["voice_state"]
    ws = web.WebSocketResponse(autoping=True, heartbeat=15)
    await ws.prepare(request)

    async with state._lock:
        state.listeners.add(ws)
    await state.ensure_started()
    await _report_debug_event("python:ws:connect", {"mode": state.mode})
    await ws.send_str(json.dumps({"type": "status", "ingestActive": state.ingest_connected, "recording": state.recording, "mode": state.mode}))

    break_reason: dict | None = None
    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = _safe_json_loads(msg.data)
                if isinstance(data, dict) and data.get("type") == "start":
                    await state.set_recording(True)
                elif isinstance(data, dict) and data.get("type") == "stop":
                    await state.set_recording(False)
                continue
            if msg.type == aiohttp.WSMsgType.BINARY:
                if not state.ingest_connected:
                    await state.push_audio(msg.data)
                continue
            if msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break_reason = {
                    "type": str(msg.type),
                    "data": str(getattr(msg, "data", "") or "")[:200],
                    "extra": str(getattr(msg, "extra", "") or "")[:200],
                }
                break
    finally:
        async with state._lock:
            state.listeners.discard(ws)
        await _report_debug_event(
            "python:ws:disconnect",
            {
                "mode": state.mode,
                "closeCode": ws.close_code,
                "wsClosed": bool(getattr(ws, "closed", False)),
                "exception": str(getattr(ws, "exception", lambda: None)() or "")[:500],
                "breakReason": break_reason,
                "listeners": len(state.listeners),
            },
        )
        await ws.close()
    return ws


async def handle_ingest(request):
    state: VoiceServerState = request.app["voice_state"]
    ws = web.WebSocketResponse(autoping=True, heartbeat=15, max_msg_size=0)
    await ws.prepare(request)
    ok = await state.ensure_started()
    if not ok:
        await ws.send_str(json.dumps({"type": "error", "message": "ASR connect failed"}))
        await ws.close()
        return ws

    state.ingest_connected = True
    await _report_debug_event("python:ingest:connect", {"mode": state.mode})
    await state.broadcast_str({"type": "status", "ingestActive": True, "recording": state.recording, "mode": state.mode})

    break_reason: dict | None = None
    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                await state.push_audio(msg.data)
                continue
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = _safe_json_loads(msg.data)
                if isinstance(data, dict) and data.get("type") == "start":
                    await state.set_recording(True)
                elif isinstance(data, dict) and data.get("type") == "stop":
                    await state.set_recording(False)
                continue
            if msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break_reason = {
                    "type": str(msg.type),
                    "data": str(getattr(msg, "data", "") or "")[:200],
                    "extra": str(getattr(msg, "extra", "") or "")[:200],
                }
                break
    finally:
        state.ingest_connected = False
        await _report_debug_event(
            "python:ingest:disconnect",
            {
                "mode": state.mode,
                "closeCode": ws.close_code,
                "wsClosed": bool(getattr(ws, "closed", False)),
                "exception": str(getattr(ws, "exception", lambda: None)() or "")[:500],
                "breakReason": break_reason,
            },
        )
        await state.broadcast_str({"type": "status", "ingestActive": False, "recording": state.recording, "mode": state.mode})
        await ws.close()
    return ws


# ---------------------------------------------------------------------------
# REST API handlers for AI agent tool calls (transcription / hotwords / status)
# ---------------------------------------------------------------------------

_MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB max upload


async def handle_transcribe(request: web.Request) -> web.Response:
    """POST /transcribe — transcribe an uploaded WAV file using the local FunASR engine.
    Accepts multipart/form-data with a ``file`` field (audio/wav).
    Returns JSON: {ok, text, sentences, language, duration_ms, model_info}
    """
    voice_state: "VoiceServerState" = request.app["voice_state"]
    if not voice_state.local_asr:
        return web.json_response({"ok": False, "error": "Local ASR engine not available"}, status=503)

    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "file":
        return web.json_response({"ok": False, "error": "Missing 'file' field in multipart form"}, status=400)

    audio_bytes = b""
    while True:
        chunk = await field.read_chunk(65536)
        if not chunk:
            break
        audio_bytes += chunk
        if len(audio_bytes) > _MAX_UPLOAD_BYTES:
            return web.json_response({"ok": False, "error": "Audio file too large (max 50 MB)"}, status=413)

    if not audio_bytes:
        return web.json_response({"ok": False, "error": "Empty audio file"}, status=400)

    try:
        result = voice_state.local_asr.transcribe(audio_bytes, sample_rate=16000)
    except RuntimeError as exc:
        logger.exception("transcribe endpoint: engine error")
        return web.json_response({"ok": False, "error": str(exc)}, status=503)
    except Exception as exc:
        logger.exception("transcribe endpoint: unexpected error")
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    return web.json_response({
        "ok": True,
        "text": result.get("text", ""),
        "sentences": result.get("sentences", []),
        "language": result.get("language", ""),
        "duration_ms": result.get("duration_ms", 0),
        "model_info": voice_state.local_asr.model_info,
    })


async def handle_hotwords_get(request: web.Request) -> web.Response:
    """GET /hotwords — list current hotwords."""
    voice_state: "VoiceServerState" = request.app["voice_state"]
    if not voice_state.local_asr:
        return web.json_response({"ok": False, "error": "Local ASR engine not available"}, status=503)
    return web.json_response({"ok": True, "hotwords": voice_state.local_asr.get_hotwords()})


async def handle_hotwords_post(request: web.Request) -> web.Response:
    """POST /hotwords — add hotwords. JSON body: {words: ["word1","word2"], weight?: float}"""
    voice_state: "VoiceServerState" = request.app["voice_state"]
    if not voice_state.local_asr:
        return web.json_response({"ok": False, "error": "Local ASR engine not available"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)
    words = body.get("words")
    if not isinstance(words, list) or not all(isinstance(w, str) for w in words):
        return web.json_response({"ok": False, "error": "'words' must be a list of strings"}, status=400)
    weight = body.get("weight", 10.0)
    if not isinstance(weight, (int, float)):
        weight = 10.0
    voice_state.local_asr.add_hotwords(words, float(weight))
    return web.json_response({"ok": True, "hotwords": voice_state.local_asr.get_hotwords()})


async def handle_hotwords_delete(request: web.Request) -> web.Response:
    """DELETE /hotwords — remove hotwords. Query: ?words=word1,word2 or ?all=1"""
    voice_state: "VoiceServerState" = request.app["voice_state"]
    if not voice_state.local_asr:
        return web.json_response({"ok": False, "error": "Local ASR engine not available"}, status=503)
    if request.query.get("all") == "1":
        voice_state.local_asr.clear_hotwords()
    else:
        raw = request.query.get("words", "")
        if raw.strip():
            voice_state.local_asr.remove_hotwords([w.strip() for w in raw.split(",")])
    return web.json_response({"ok": True, "hotwords": voice_state.local_asr.get_hotwords()})


async def handle_asr_status(request: web.Request) -> web.Response:
    """GET /asr/status — return local ASR engine status."""
    voice_state: "VoiceServerState" = request.app["voice_state"]
    if not voice_state.local_asr:
        return web.json_response({"local_asr": False, "message": "Local ASR not configured"})
    info = voice_state.local_asr.model_info
    return web.json_response({
        "local_asr": True,
        "loaded": info.get("loaded", False),
        "device": info.get("device", ""),
        "model_dir": info.get("model_dir", ""),
        "disabled": info.get("disabled_until_ms", 0) > 0 if isinstance(info.get("disabled_until_ms"), int) else False,
        "disabled_reason": info.get("disabled_reason", ""),
        "load_fail_count": info.get("load_fail_count", 0),
        "hotword_count": info.get("hotword_count", 0),
    })


async def main():
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Orchidea Voice Bot (WebSocket)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--transport", default="webrtc")
    args = parser.parse_args()

    mode, _cfg, asr_url, asr_is_local = _build_asr_config()

    local_asr = None
    if asr_is_local:
        import torch
        device = "mps" if hasattr(torch.backends, "mps") and torch.backends.mps.is_available() else "cpu"
        model_dir = _env("ORCHIDEA_VOICE_MODEL_DIR") or None
        local_asr = LocalFunASREngine(device=device, model_dir=model_dir)
        asr_url = "local://funasr"

    await _report_debug_event(
        "python:voice-config",
        {
            "mode": mode,
            "asrUrl": asr_url,
            "asrEngine": _env("ORCHIDEA_VOICE_ASR_ENGINE") or "remote",
            "ttsUrlConfigured": bool(_env("ORCHIDEA_VOICE_TTS_URL")),
            "localTtsModelId": _env("ORCHIDEA_VOICE_QWEN_MODEL"),
            "localTtsSpeaker": _env("ORCHIDEA_VOICE_QWEN_SPEAKER"),
            "localTtsOffline": _env("ORCHIDEA_VOICE_LOCAL_TTS_OFFLINE") in ("1", "true", "yes", "on"),
            "debugReplyConfigured": bool(_env("ORCHIDEA_VOICE_DEBUG_REPLY_TEXT")),
        },
    )

    app = web.Application()
    app.router.add_get("/", lambda r: web.HTTPFound("/client/"))
    app.router.add_get("/client/", handle_client)
    app.router.add_get("/client", lambda r: web.HTTPFound("/client/"))
    app.router.add_get("/health", lambda r: web.json_response({"ok": True}))
    app.router.add_get("/ws", handle_ws)
    app.router.add_get("/ingest", handle_ingest)
    # AI agent tool REST endpoints (local FunASR transcription + hotword management)
    app.router.add_post("/transcribe", handle_transcribe)
    app.router.add_get("/hotwords", handle_hotwords_get)
    app.router.add_post("/hotwords", handle_hotwords_post)
    app.router.add_delete("/hotwords", handle_hotwords_delete)
    app.router.add_get("/asr/status", handle_asr_status)

    if not asr_url and not asr_is_local:
        raise RuntimeError("Missing ASR URL")
    app["voice_state"] = VoiceServerState(
        mode=mode,
        cfg=_cfg if isinstance(_cfg, dict) else {},
        asr_url=asr_url,
        local_asr=local_asr,
    )

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host=args.host, port=args.port)
    await site.start()
    logger.info("orchidea-voice server started on %s:%s", args.host, args.port)
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
