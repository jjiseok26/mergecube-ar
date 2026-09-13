import { del } from "@vercel/blob";

export async function DELETE(request) {
  const face = new URL(request.url).searchParams.get("face") || "";
  if (!/^[A-Za-z]+$/.test(face)) return new Response("bad face", { status: 400 });
  try {
    await del(`project/${face}.glb`);
  } catch {
    /* already gone */
  }
  return new Response(null, { status: 204 });
}
