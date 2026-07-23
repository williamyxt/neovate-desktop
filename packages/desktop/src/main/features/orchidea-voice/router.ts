import { implement } from "@orpc/server";
import { systemPreferences } from "electron";
import { execFileSync } from "node:child_process";

import type { AppContext } from "../../router";

import { orchideaVoiceContract } from "../../../shared/features/orchidea-voice/contract";

const os = implement({ orchideaVoice: orchideaVoiceContract }).$context<AppContext>();

// #region debug-point mic-permission-denied-router
const DEBUG_SERVER_URL = (process.env.DEBUG_SERVER_URL || "").trim();
const DEBUG_SESSION_ID = (process.env.DEBUG_SESSION_ID || "").trim();
const DEBUG_RUN_ID = (process.env.ORCHIDEA_DEBUG_RUN_ID || "pre").trim() || "pre";
async function reportMicDebugEvent(event: string, data?: Record<string, unknown>): Promise<void> {
  if (!DEBUG_SERVER_URL || !DEBUG_SESSION_ID) return;
  try {
    await fetch(DEBUG_SERVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ts: Date.now(),
        sessionId: DEBUG_SESSION_ID,
        runId: DEBUG_RUN_ID,
        hypothesisId: "C",
        event,
        data: data ?? {},
      }),
    });
  } catch {}
}
// #endregion debug-point mic-permission-denied-router

function triggerNativeVoiceInput(): {
  ok: boolean;
  platform: NodeJS.Platform;
  method: string;
  message: string | null;
} {
  if (process.platform === "darwin") {
    try {
      execFileSync("osascript", [
        "-e",
        [
          'tell application "System Events"',
          "set frontApp to name of first application process whose frontmost is true",
          "tell process frontApp",
          'click menu item "Start Dictation…" of menu "Edit" of menu bar 1',
          "end tell",
          "end tell",
        ].join("\n"),
      ]);
      return {
        ok: true,
        platform: process.platform,
        method: "menu:start-dictation",
        message: null,
      };
    } catch {
      return {
        ok: false,
        platform: process.platform,
        method: "menu:start-dictation",
        message:
          "无法触发 macOS 听写。请先在系统设置中启用听写，并确认当前焦点在可输入文本的位置。",
      };
    }
  }

  if (process.platform === "win32") {
    try {
      execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        [
          "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class K {",
          '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);',
          "}'",
          "$VK_LWIN = 0x5B",
          "$VK_H = 0x48",
          "$KEYEVENTF_KEYUP = 0x0002",
          "[K]::keybd_event($VK_LWIN, 0, 0, 0)",
          "[K]::keybd_event($VK_H, 0, 0, 0)",
          "[K]::keybd_event($VK_H, 0, $KEYEVENTF_KEYUP, 0)",
          "[K]::keybd_event($VK_LWIN, 0, $KEYEVENTF_KEYUP, 0)",
        ].join("; "),
      ]);
      return {
        ok: true,
        platform: process.platform,
        method: "shortcut:Win+H",
        message: null,
      };
    } catch {
      return {
        ok: false,
        platform: process.platform,
        method: "shortcut:Win+H",
        message: "无法触发 Windows 语音输入。请确认系统支持语音键入，并手动按 Win+H。",
      };
    }
  }

  return {
    ok: false,
    platform: process.platform,
    method: "unsupported",
    message: "当前平台未实现系统原生语音输入触发，请使用操作系统自带语音输入快捷键。",
  };
}

export const orchideaVoiceRouter = os.orchideaVoice.router({
  getStatus: os.orchideaVoice.getStatus.handler(({ context }) => {
    return {
      running: context.orchideaVoiceService.running,
      url: context.orchideaVoiceService.url,
      port: context.orchideaVoiceService.port,
      lastError: context.orchideaVoiceService.lastError,
    };
  }),
  getMicPermissionStatus: os.orchideaVoice.getMicPermissionStatus.handler(() => {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    // #region debug-point mic-permission-denied-router
    reportMicDebugEvent("tcc:mic:status", {
      status,
      execPath: process.execPath,
    }).catch(() => {});
    // #endregion debug-point mic-permission-denied-router
    return {
      status:
        status === "not-determined" ||
        status === "granted" ||
        status === "denied" ||
        status === "restricted"
          ? status
          : "unknown",
    };
  }),
  requestMicPermission: os.orchideaVoice.requestMicPermission.handler(async () => {
    const pre = systemPreferences.getMediaAccessStatus("microphone");
    // #region debug-point mic-permission-denied-router
    reportMicDebugEvent("tcc:mic:request:pre", { status: pre, execPath: process.execPath }).catch(
      () => {},
    );
    // #endregion debug-point mic-permission-denied-router
    const granted = await systemPreferences.askForMediaAccess("microphone");
    const status = systemPreferences.getMediaAccessStatus("microphone");
    // #region debug-point mic-permission-denied-router
    reportMicDebugEvent("tcc:mic:request:post", {
      granted,
      status,
      execPath: process.execPath,
    }).catch(() => {});
    // #endregion debug-point mic-permission-denied-router
    return {
      granted,
      status:
        status === "not-determined" ||
        status === "granted" ||
        status === "denied" ||
        status === "restricted"
          ? status
          : "unknown",
    };
  }),
  triggerSystemVoiceInput: os.orchideaVoice.triggerSystemVoiceInput.handler(() => {
    const result = triggerNativeVoiceInput();
    void reportMicDebugEvent("voice:router:triggerSystemVoiceInput", result);
    return result;
  }),
  start: os.orchideaVoice.start.handler(async ({ context }) => {
    // #region debug-point voice-dualchat-route-switch-router-start
    void reportMicDebugEvent("voice:router:start", {
      running: context.orchideaVoiceService.running,
      port: context.orchideaVoiceService.port,
      lastError: context.orchideaVoiceService.lastError,
    });
    // #endregion debug-point voice-dualchat-route-switch-router-start
    await context.orchideaVoiceService.start();
    return {
      running: context.orchideaVoiceService.running,
      url: context.orchideaVoiceService.url,
      port: context.orchideaVoiceService.port,
      lastError: context.orchideaVoiceService.lastError,
    };
  }),
  stop: os.orchideaVoice.stop.handler(async ({ context }) => {
    // #region debug-point voice-dualchat-route-switch-router-stop
    void reportMicDebugEvent("voice:router:stop", {
      running: context.orchideaVoiceService.running,
      port: context.orchideaVoiceService.port,
      lastError: context.orchideaVoiceService.lastError,
    });
    // #endregion debug-point voice-dualchat-route-switch-router-stop
    await context.orchideaVoiceService.stop();
    return { ok: true };
  }),
  setFocusedSession: os.orchideaVoice.setFocusedSession.handler(({ context, input }) => {
    const sessionIdIn = typeof input?.sessionId === "string" ? input.sessionId.trim() : null;
    // #region debug-point voice-dualchat-route-switch-router-focused
    void reportMicDebugEvent("voice:router:setFocusedSession", {
      sessionId: sessionIdIn,
      running: context.orchideaVoiceService.running,
      port: context.orchideaVoiceService.port,
    });
    // #endregion debug-point voice-dualchat-route-switch-router-focused
    context.orchideaVoiceService.setFocusedSession(sessionIdIn || null);
    return { ok: true };
  }),
});
