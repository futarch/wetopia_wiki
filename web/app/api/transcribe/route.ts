// Dictation: audio in, French text out.
//
// Deliberately NOT the browser's Web Speech API: in Chrome that ships the
// microphone stream to Google's servers, which would quietly break the one
// promise this project makes about where its data goes. Transcription runs on
// Mistral's speech model instead — same provider, same jurisdiction as the rest
// of the stack — and the text is only ever inserted into the composer, so the
// user still reads and sends it themselves.
import { currentViewer } from "../../../lib/server/auth.ts";
import { config } from "../../../lib/server/config.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  const viewer = await currentViewer(req.headers);
  if (!viewer) return new Response("non authentifié", { status: 401 });

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return Response.json({ error: "transcription indisponible" }, { status: 503 });

  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob)) return Response.json({ error: "audio manquant" }, { status: 400 });
  if (audio.size > MAX_BYTES) return Response.json({ error: "enregistrement trop long" }, { status: 413 });

  const upstream = new FormData();
  upstream.set("file", audio, "dictee.webm");
  upstream.set("model", config.transcriptionModel);
  upstream.set("language", "fr");

  const res = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: upstream,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return Response.json(
      { error: "la transcription a échoué", detail: detail.slice(0, 300) },
      { status: 502 },
    );
  }

  const data = await res.json();
  return Response.json({ text: (data.text ?? "").trim() });
}
