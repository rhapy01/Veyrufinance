import express, { type ErrorRequestHandler, type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
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
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.json({ name: "Veyra Finance API", status: "ok", version: "1.0.0" });
});

app.use("/api", router);

app.use(((error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  logger.error({ err: error }, "Unhandled API request error");
  const databaseConnectionFailure = (candidate: unknown, depth = 0): boolean => {
    if (depth > 5 || !candidate) return false;
    if (candidate instanceof Error) {
      if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection terminated due to connection timeout/i.test(candidate.message)) return true;
      return databaseConnectionFailure(candidate.cause, depth + 1);
    }
    if (typeof candidate === "object") {
      const details = candidate as { message?: unknown; code?: unknown; cause?: unknown };
      if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection terminated due to connection timeout/i.test(`${String(details.code ?? "")} ${String(details.message ?? "")}`)) return true;
      return databaseConnectionFailure(details.cause, depth + 1);
    }
    return false;
  };
  if (databaseConnectionFailure(error)) {
    res.status(503).json({ error: "The database is temporarily unavailable. Check the configured database connection and try again." });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
}) satisfies ErrorRequestHandler);

export default app;
