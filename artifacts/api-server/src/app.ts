import { createServer } from "node:http";
import cors from "cors";
import pinoHttp from "pino-http";
import { handleApiRequest } from "./routes";
import { logger } from "./lib/logger";

const requestLogger = pinoHttp({
  logger,
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url?.split("?")[0],
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
    corsMiddleware(req, res, () => handleApiRequest(req, res));
  });
});

export default app;
