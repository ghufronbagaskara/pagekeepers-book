import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { api, type ReaderEnv } from "../../server/api";

export const prerender = false;
export const ALL: APIRoute = ({ request, params }) => api(request, params.route ?? "", env as unknown as ReaderEnv);
