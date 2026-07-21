# Production Guardrails

This template includes a production guardrail baseline for API routes:

- The Next.js API proxy rate limits requests by client IP.
- Request bodies are capped with `API_MAX_BODY_BYTES` to limit abuse and runaway costs.
- JSON handlers normalize text fields, redact obvious secrets, cap conversation history, and block common prompt-injection or credential-exfiltration attempts.
- Upload handlers limit file size, restrict file types to PDF/plain-text formats, sanitize titles, and reject hostile pasted text.
- Realtime routes clamp VAD values, restrict voices, and allow only known realtime model identifiers.
- API responses include no-store and security headers to reduce accidental data exposure.
- Server errors are redacted before returning to clients.

Environment knobs:

- `API_RATE_LIMIT_WINDOW_MS`: rate-limit window in milliseconds. Default: `60000`.
- `API_RATE_LIMIT_MAX`: max API requests per window per client. Default: `60`.
- `API_MAX_BODY_BYTES`: max request body size enforced by the API proxy. Default: `1000000`.

Before production launch, connect these baseline controls to persistent auth, tenant-aware quotas, structured logging, and your abuse-monitoring pipeline.
