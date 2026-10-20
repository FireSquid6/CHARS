import { readSnapshotOutput } from "@/lib/snapshot-output";
import { SnapshotOutputMigrationError } from "@/lib/snapshot-output-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ year: string; key: string }> }) {
  const { year, key } = await params;
  if (!/^\d{4}$/.test(year) || !key.startsWith(`${year}:`))
    return Response.json({ error: "Invalid season or snapshot key" }, { status: 400 });
  const raw = new URL(request.url).searchParams.get("revision");
  if (raw !== null && (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))))
    return Response.json({ error: "Invalid revision" }, { status: 400 });
  try {
    const output = readSnapshotOutput(Number(year), key, raw === null ? undefined : Number(raw));
    return output ? Response.json(output, { headers: { "Cache-Control": "no-store" } }) :
      Response.json({ error: "Published snapshot revision not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof SnapshotOutputMigrationError)
      return Response.json({ error: error.message }, { status: 503, headers: { "Cache-Control": "no-store" } });
    return Response.json({ error: "Snapshot output unavailable" }, { status: 503 });
  }
}
