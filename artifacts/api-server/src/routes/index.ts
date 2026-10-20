import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { handleHealthCheck } from "./health";
import { handleTopggWebhook } from "../bot/topggVotes";
import { handleDiscadiaWebhook } from "../bot/discadiaVotes";
import { logger } from "../lib/logger";

export function handleApiRequest(req: IncomingMessage, res: ServerResponse, client: Client | null = null): void {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/healthz") {
    handleHealthCheck(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/topgg/webhook") {
    void handleTopggWebhook(req, res, client).catch((error: unknown) => {
      logger.error({ err: error }, "Top.gg webhook handler failed unexpectedly");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Webhook processing failed" }));
      }
    });
    return;
  }

  const discadiaWebhookMatch = /^\/api\/discadia\/webhook(?:\/([A-Za-z0-9_-]{32,128}))?$/.exec(url.pathname);
  if (req.method === "POST" && discadiaWebhookMatch) {
    void handleDiscadiaWebhook(req, res, client, discadiaWebhookMatch[1]).catch((error: unknown) => {
      logger.error({ err: error }, "Discadia webhook handler failed unexpectedly");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Webhook processing failed" }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Cannot ${req.method ?? "GET"} ${url.pathname}`);
}
