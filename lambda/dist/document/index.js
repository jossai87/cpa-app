"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
/**
 * documentHandler — Phase 1 stub.
 *
 * All document routes return HTTP 501 in Phase 1.
 * Phase 2 will implement:
 *   - POST /documents/upload-url  → S3 pre-signed URL generation
 *   - POST /documents/bda-job     → Bedrock Data Automation job trigger
 */
function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}
const handler = async (event) => {
    switch (event.routeKey) {
        case 'POST /documents/upload-url':
            return json(501, { error: 'Not implemented in Phase 1' });
        case 'POST /documents/bda-job':
            return json(501, { error: 'Not implemented in Phase 1' });
        default:
            return json(404, { error: 'Route not found' });
    }
};
exports.handler = handler;
//# sourceMappingURL=index.js.map