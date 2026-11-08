export const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  Response.json(data, { status, headers: { ...noStore, ...headers } });
export const fail = (status: number, error: string) => json({ error }, status);

/** A small JSON object body, or null for anything else: oversized, not JSON, or not an object. */
export async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.body || !request.headers.get("Content-Type")?.startsWith("application/json")) return null;
  const reader = request.body.getReader();
  const data = new Uint8Array(4096);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > data.length) {
        await reader.cancel();
        return null;
      }
      data.set(value, offset);
      offset += value.length;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(data.subarray(0, offset)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
