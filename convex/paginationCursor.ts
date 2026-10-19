/**
 * Convex pagination cursors fail in two observable ways.
 *
 * Production cursors are hex-encoded encrypted blobs. A blob that cannot be
 * decrypted raises ErrorMetadata bad_request("InvalidCursor", "Failed to parse
 * cursor"). The message does not contain the code. convex-test cursors are
 * JSON arrays, and a bad one throws a JSON parse error from paginate().
 */

const CURSOR_ERROR_TEXT = /Failed to parse cursor|InvalidCursor/;
const CURSOR_PARSE_TEXT = /not valid JSON|in JSON at position|Unexpected token/;

export function paginationCursorShapeAccepted(cursor: string): boolean {
  if (cursor.length === 0) return true;
  if (cursor.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(cursor)) return true;
  try {
    return Array.isArray(JSON.parse(cursor));
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

function errorData(err: unknown): unknown {
  const raw = (err as { data?: unknown } | null)?.data;
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function dataNamesInvalidCursor(data: unknown): boolean {
  if (typeof data === "string") return data === "InvalidCursor" || CURSOR_ERROR_TEXT.test(data);
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  if (record.paginationError === "InvalidCursor") return true;
  if (record.code === "InvalidCursor" || record.kind === "InvalidCursor") return true;
  return typeof record.message === "string" && CURSOR_ERROR_TEXT.test(record.message);
}

export function isInvalidPaginationCursorError(err: unknown): boolean {
  const message = errorMessage(err);
  if (CURSOR_ERROR_TEXT.test(message) || CURSOR_PARSE_TEXT.test(message)) return true;
  if (err instanceof SyntaxError) return true;
  return dataNamesInvalidCursor(errorData(err));
}

export function isInvalidCursorPage(result: unknown): boolean {
  return !!result
    && typeof result === "object"
    && (result as { error?: unknown }).error === "INVALID_CURSOR";
}
