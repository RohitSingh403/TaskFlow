const SENSITIVE_KEY = /^(password|passwordhash|secret|token|accesstoken|refreshtoken|authorization|apikey|api_key|keyhash|cookie|setcookie|connectionstring)$/i;

function normalizeKey(key: string) {
  return key.replace(/[-_\s]/g, "");
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return "[MaxDepth]" as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY.test(normalizeKey(key)) ? "[REDACTED]" : redact(entry, depth + 1);
    }
    return output as T;
  }
  return value;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function findUnsafeKey(value: unknown, path = "payload"): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnsafeKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (UNSAFE_KEYS.has(key)) return `${path}.${key}`;
      const found = findUnsafeKey(entry, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}
