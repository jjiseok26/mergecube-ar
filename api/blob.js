import { handleUpload } from "@vercel/blob/client";

const ALLOWED = /^project\/(meta\.json|[A-Za-z]+\.glb)$/;

export async function POST(request) {
  const body = await request.json();
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!ALLOWED.test(pathname)) throw new Error("bad path");
        return {
          allowedContentTypes: [
            "model/gltf-binary",
            "application/gltf-binary",
            "application/octet-stream",
            "application/json",
          ],
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: 60,
          maximumSizeInBytes: 100 * 1024 * 1024,
        };
      },
      onUploadCompleted: async () => {},
    });
    return Response.json(jsonResponse);
  } catch (error) {
    return Response.json({ error: error.message || String(error) }, { status: 400 });
  }
}
