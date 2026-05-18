"use strict";
/**
 * Log redaction utility.
 * Recursively replaces values of keys named `ssn`, `ein`, or `password`
 * (case-insensitive) with `[REDACTED]` before any logging call.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.redact = redact;
const SENSITIVE_KEYS = new Set(['ssn', 'ein', 'password']);
/**
 * Recursively redacts sensitive fields from an object before logging.
 * Handles nested objects and arrays.
 *
 * @param obj - Any value (object, array, primitive)
 * @returns A deep copy with sensitive values replaced by `[REDACTED]`
 */
function redact(obj) {
    if (obj === null || obj === undefined) {
        return obj;
    }
    if (typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map((item) => redact(item));
    }
    const record = obj;
    return Object.fromEntries(Object.entries(record).map(([key, value]) => {
        if (SENSITIVE_KEYS.has(key.toLowerCase())) {
            return [key, '[REDACTED]'];
        }
        return [key, redact(value)];
    }));
}
//# sourceMappingURL=redact.js.map