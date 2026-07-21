const DEFAULT_TEXT_MAX = 6000;
const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const SAFE_FILE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const BLOCKED_INTENT_PATTERNS = [
  /(?:ignore|bypass|override)\s+(?:all\s+)?(?:previous|system|developer)\s+(?:instructions|messages|prompts)/i,
  /reveal\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions)/i,
  /(?:exfiltrate|steal|dump)\s+(?:secrets|tokens|api\s*keys|credentials)/i,
  /(?:write|generate|create).*(?:malware|ransomware|keylogger|credential\s*harvester)/i,
];

function redactSecrets(value) {
  if (typeof value !== "string") return value;
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted-secret]"),
    value,
  );
}

function normalizeText(value, maxLength = DEFAULT_TEXT_MAX) {
  if (typeof value !== "string") return "";
  return redactSecrets(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function hasBlockedIntent(value) {
  return BLOCKED_INTENT_PATTERNS.some((pattern) => pattern.test(value));
}

export async function parseJsonRequest(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function validateRequestBody(body, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object." };
  }

  const textFields = options.textFields || ["prompt", "message", "query", "input"];
  const maxLength = options.maxLength || DEFAULT_TEXT_MAX;

  for (const field of textFields) {
    if (field in body && typeof body[field] === "string") {
      const normalized = normalizeText(body[field], maxLength);

      if (body[field].trim() && !normalized) {
        return { ok: false, status: 400, error: field + " contains no usable text." };
      }

      if (hasBlockedIntent(normalized)) {
        return {
          ok: false,
          status: 400,
          error: "Request was blocked by prompt-injection and credential-safety guardrails.",
        };
      }

      body[field] = normalized;
    }
  }

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.slice(-20).map((message) => ({
      ...message,
      content: normalizeText(message?.content, maxLength),
    }));

    if (body.messages.some((message) => hasBlockedIntent(message.content))) {
      return {
        ok: false,
        status: 400,
        error: "Conversation was blocked by prompt-injection and credential-safety guardrails.",
      };
    }
  }

  return { ok: true, body };
}

export function validatePrompt(value, options = {}) {
  const field = options.field || "prompt";
  const text = normalizeText(value, options.maxLength || DEFAULT_TEXT_MAX);

  if (!text) {
    return { ok: false, status: 400, error: field + " is required." };
  }

  if (hasBlockedIntent(text)) {
    return {
      ok: false,
      status: 400,
      error: "Request was blocked by prompt-injection and credential-safety guardrails.",
    };
  }

  return { ok: true, value: text };
}

export function validateUploadInput({ file, text, title }, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_UPLOAD_MAX_BYTES;
  const normalizedText = normalizeText(text || "", options.maxTextLength || 500000);
  const normalizedTitle = normalizeText(title || "", 180);

  if (file && typeof file.arrayBuffer === "function") {
    if (typeof file.size === "number" && file.size > maxBytes) {
      return { ok: false, status: 413, error: "File is too large for this template upload limit." };
    }

    const fileName = typeof file.name === "string" ? file.name.toLowerCase() : "";
    const isPdf = file.type === "application/pdf" || fileName.endsWith(".pdf");
    const isSafeText = SAFE_FILE_TYPES.has(file.type) || /\.(txt|md|csv|json)$/i.test(fileName);

    if (!isPdf && !isSafeText) {
      return { ok: false, status: 415, error: "Unsupported file type. Upload PDF or plain text documents only." };
    }
  } else if (!normalizedText) {
    return { ok: false, status: 400, error: "Provide a file or pasted text." };
  }

  if (hasBlockedIntent(normalizedText) || hasBlockedIntent(normalizedTitle)) {
    return {
      ok: false,
      status: 400,
      error: "Upload was blocked by prompt-injection and credential-safety guardrails.",
    };
  }

  return { ok: true, text: normalizedText, title: normalizedTitle };
}

export function toSafeError(error, fallback = "Request failed.") {
  const message = typeof error?.message === "string" ? error.message : fallback;
  const redacted = redactSecrets(message).slice(0, 240);
  if (/api[_-]?key|token|secret|password/i.test(redacted)) return fallback;
  return redacted || fallback;
}

export function safeJsonResponse(payload, init = {}) {
  return Response.json(payload, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(init.headers || {}),
    },
  });
}
