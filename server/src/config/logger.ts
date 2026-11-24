import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(env.nodeEnv === "production"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      }),
});
