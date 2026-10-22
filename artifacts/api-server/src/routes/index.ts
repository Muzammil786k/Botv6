import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHealthCheck } from "./health";

export function handleApiRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/healthz") {
    handleHealthCheck(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Cannot ${req.method ?? "GET"} ${url.pathname}`);
}
