import { head } from "@vercel/blob";

export async function GET(request) {
  const file = new URL(request.url).searchParams.get("file") || "";
  if (!/^(meta\.json|[A-Za-z]+\.glb)$/.test(file)) {
    return new Response("bad file", { status: 400 });
  }
  try {
    const blob = await head(`project/${file}`);
    return Response.redirect(blob.url, 302);
  } catch {
    return new Response("not found", { status: 404 });
  }
}
