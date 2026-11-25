/**
 * The settings file written on first run. Every value equals the built-in default, so deleting
 * a line never changes behavior. Comments document what each knob does; the JSON Schema next to
 * the file gives editors completion and validation.
 */
export const SETTINGS_TEMPLATE = `{
  "$schema": "./settings.schema.json",
  // Voice MCP settings (JSON with comments). Changes apply to the next spoken line; no restart.
  // Run \`voice-mcp doctor\` to check this file and your speech setup.

  "notification": {
    // Play a short chime before each spoken message.
    "enabled": true,
    // WAV file to play instead of the bundled chime (null = bundled). "~" means your home folder.
    "path": null
  },

  "ntfy": {
    // Mirror every accepted line to an ntfy topic (https://ntfy.sh or self-hosted), even while muted.
    "enabled": false,
    "server": "https://ntfy.sh",
    // Anyone who knows an open topic name can read and post to it. Use a long random name or a token.
    "topic": "",
    "token": null,
    "title": "Voice",
    // 1..5 (4 = high)
    "priority": 4,
    // 0 = send the full line; >0 trims the body to that many characters.
    "maxBodyChars": 0
  },

  "audio": {
    // null = platform default: afplay (macOS), PowerShell SoundPlayer (Windows), paplay/aplay/ffplay (Linux).
    "player": null,
    // Extra arguments before the file, e.g. ["-v", "0.6"] lowers afplay volume.
    "playerArgs": [],
    "generationTimeoutMs": 600000,
    "playbackTimeoutMs": 600000,
    // Time between a polite stop and a forced kill.
    "killGraceMs": 1500
  },

  "queue": {
    // Pending messages kept in memory (1..250).
    "maxDepth": 12,
    // When full: "oldest" drops queued items, "newest" drops the new request.
    "dropPolicy": "oldest"
  },

  "guardrails": {
    "enabled": true,
    // Longer messages are dropped.
    "maxCharsPerMessage": 400,
    // Minimum time between accepted messages.
    "cooldownMs": 1200,
    // Token bucket: average messages per minute (0 = unlimited) and burst size.
    "maxMessagesPerMinute": 10,
    "burst": 3,
    // Drop exact repeats within this window.
    "dedupeWindowMs": 15000,
    // If messages are dropped too fast, stay silent for a while (in memory only; null disables).
    "panicMuteOnDrops": {
      "enabled": true,
      "threshold": 30,
      "windowMs": 60000,
      "muteForMs": 300000
    }
  },

  // Where Kokoro and Piper models live (null = "models" inside this folder).
  // VOICE_MCP_MODELS_DIR overrides this per machine.
  "modelsDir": null,

  "providers": {
    // Tried in order until one speaks. "system" is the built-in OS voice and needs no setup:
    // say on macOS, SAPI on Windows, espeak-ng on Linux.
    "order": ["kokoro", "piper", "system"],

    "kokoro": {
      "cli": "kokoro-tts",
      // null = <modelsDir>/kokoro/kokoro-v1.0.onnx and voices-v1.0.bin (or KOKORO_MODEL_PATH / KOKORO_VOICES_PATH).
      "modelPath": null,
      "voicesPath": null,
      "voice": "am_michael",
      "lang": "en-us",
      // 0.5..2.0
      "speed": 1.0
    },

    "piper": {
      // Python with piper-tts installed (null = "python" on Windows, "python3" elsewhere).
      "python": null,
      // null = <modelsDir>/piper (or PIPER_DATA_DIR).
      "dataDir": null,
      "model": "en_US-joe-medium"
    },

    "system": {
      // Voice name from \`voice-mcp voices --provider system\` (null = system default).
      "voice": null,
      // Words per minute (null = system default, about 175).
      "rate": null
    },

    "command": {
      // Bring your own TTS. Placeholders: {text} {textFile} {outFile} {voice}.
      // With {outFile} the file is played afterwards; without it the command must speak by itself.
      // Example: "command": "edge-tts", "args": ["--file", "{textFile}", "--write-media", "{outFile}"]
      "command": null,
      "args": []
    }
  },

  "logging": {
    // "error" | "warn" | "info" | "debug"
    "level": "info",
    // Also append to logs/voice-mcp.log in this folder.
    "file": true
  },

  // Named overrides, selected with \`voice-mcp set-profile <name>\`. Example:
  // "meeting": { "notification": { "enabled": false }, "audio": { "playerArgs": ["-v", "0.4"] } }
  "profiles": {}
}
`;
