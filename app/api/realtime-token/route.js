export const runtime = "nodejs";

const DEFAULT_MODEL = "gpt-realtime-2.1";
const DEFAULT_VOICE = "marin";
const ALLOWED_VOICES = new Set(["marin", "cedar", "verse"]);

function sanitizeText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 120) : fallback;
}

function normalizeVad(value) {
  if (!value || typeof value !== "object") {
    return {
      threshold: 0.55,
      prefixPaddingMs: 300,
      silenceDurationMs: 650,
    };
  }

  return {
    threshold:
      typeof value.threshold === "number"
        ? Math.min(Math.max(value.threshold, 0.1), 0.9)
        : 0.55,
    prefixPaddingMs:
      typeof value.prefixPaddingMs === "number"
        ? Math.min(Math.max(value.prefixPaddingMs, 0), 1000)
        : 300,
    silenceDurationMs:
      typeof value.silenceDurationMs === "number"
        ? Math.min(Math.max(value.silenceDurationMs, 200), 2000)
        : 650,
  };
}

export async function POST(request) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response("Missing OPENAI_API_KEY in the environment.", {
      status: 500,
    });
  }

  const body = await request.json().catch(() => ({}));
  const model = sanitizeText(body?.model, DEFAULT_MODEL);
  const requestedVoice = sanitizeText(body?.voice, DEFAULT_VOICE);
  const voice = ALLOWED_VOICES.has(requestedVoice) ? requestedVoice : DEFAULT_VOICE;
  const vad = normalizeVad(body?.vad);

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              threshold: vad.threshold,
              prefix_padding_ms: vad.prefixPaddingMs,
              silence_duration_ms: vad.silenceDurationMs,
              interrupt_response: true,
              create_response: true,
            },
          },
          output: {
            voice,
          },
        },
      },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const details = await response.text();
    let message = "Could not create realtime client secret.";

    try {
      const parsed = JSON.parse(details);
      if (typeof parsed?.error?.message === "string") {
        message = parsed.error.message;
      }
    } catch {
      if (details.trim()) {
        message = details.trim().slice(0, 240);
      }
    }

    console.error("Realtime client secret error:", details);
    return new Response(message, {
      status: response.status,
    });
  }

  const data = await response.json();

  return Response.json(
    {
      value: data.value,
      expiresAt: data.expires_at,
      session: data.session,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
