import { createServer } from "node:http";
import cors from "cors";
import pinoHttp from "pino-http";
import type { Client } from "discord.js";
import { handleApiRequest } from "./routes";
import { logger } from "./lib/logger";

let discordClient: Client | null = null;

export function setApiBotClient(client: Client): void {
  discordClient = client;
}

const requestLogger = pinoHttp({
  logger,
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url?.startsWith("/api/discadia/webhook/")
          ? "/api/discadia/webhook/[redacted]"
          : req.url?.split("?")[0],
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
});
const corsMiddleware = cors();

const app = createServer((req, res) => {
  requestLogger(req, res, () => {
    corsMiddleware(req, res, () => handleApiRequest(req, res, discordClient));
  });
});

export default app;
