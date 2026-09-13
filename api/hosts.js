export function GET(request) {
  const origin = new URL(request.url).origin;
  return Response.json({
    storage: "blob",
    hosts: [origin],
  });
}
