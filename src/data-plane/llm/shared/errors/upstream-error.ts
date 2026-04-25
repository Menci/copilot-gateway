import type { UpstreamErrorResult } from "./result.ts";

export const readUpstreamError = async (
  response: Response,
): Promise<UpstreamErrorResult> => ({
  type: "upstream-error",
  status: response.status,
  headers: new Headers(response.headers),
  body: new Uint8Array(await response.arrayBuffer()),
});

export const upstreamErrorToResponse = (error: UpstreamErrorResult): Response =>
  new Response(error.body.slice().buffer, {
    status: error.status,
    headers: new Headers(error.headers),
  });

export const decodeUpstreamErrorBody = (error: UpstreamErrorResult): string =>
  new TextDecoder().decode(error.body);
