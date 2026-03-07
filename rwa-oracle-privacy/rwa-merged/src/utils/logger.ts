// src/utils/logger.ts — Production logger
// JSON structured logs in production (written to console + rotating files).
// Pretty-printed in development. Creates log directory if missing.

import winston from "winston";
import path from "path";
import fs from "fs";

const isProd = process.env.NODE_ENV === "production";

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.colorize(),
  winston.format.printf(
    ({ timestamp, level, message, ...meta }) =>
      `${timestamp} [${level}] ${message}${
        Object.keys(meta).length ? " " + JSON.stringify(meta) : ""
      }`
  )
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: isProd ? jsonFormat : consoleFormat,
  }),
];

// In production, also write to rotating log files if LOG_DIR is set and writable
if (isProd) {
  const logDir = process.env.LOG_DIR ?? "/var/log/rwa-oracle";
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    transports.push(
      new winston.transports.File({
        filename: path.join(logDir, "error.log"),
        level: "error",
        format: jsonFormat,
        maxsize: 10 * 1024 * 1024, // 10 MB
        maxFiles: 10,
        tailable: true,
      }),
      new winston.transports.File({
        filename: path.join(logDir, "combined.log"),
        format: jsonFormat,
        maxsize: 50 * 1024 * 1024, // 50 MB
        maxFiles: 10,
        tailable: true,
      })
    );
  } catch (err) {
    // Log dir not writable — console only. This is fine in containers.
    console.warn(`[logger] Could not create log directory ${logDir}: ${(err as Error).message}. Using console only.`);
  }
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  transports,
  exitOnError: false,
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: String(reason) });
});
