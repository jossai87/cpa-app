/**
 * Log redaction utility.
 * Recursively replaces values of keys named `ssn`, `ein`, or `password`
 * (case-insensitive) with `[REDACTED]` before any logging call.
 */
/**
 * Recursively redacts sensitive fields from an object before logging.
 * Handles nested objects and arrays.
 *
 * @param obj - Any value (object, array, primitive)
 * @returns A deep copy with sensitive values replaced by `[REDACTED]`
 */
export declare function redact(obj: unknown): unknown;
//# sourceMappingURL=redact.d.ts.map