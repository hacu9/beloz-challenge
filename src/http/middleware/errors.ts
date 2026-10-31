import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError, notFound } from "../../platform/errors.js";
import type { Logger } from "../../platform/logger.js";

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => next(notFound("route not found"));
}

interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as BodyParserError).type === "string" &&
    typeof (err as BodyParserError).status === "number"
  );
}

// One JSON error shape. Never a stack trace or an internal message in a response.
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    let appError: AppError;
    if (err instanceof AppError) {
      appError = err;
    } else if (err instanceof ZodError) {
      appError = new AppError(422, "validation_failed", "the request is not valid", err.issues);
    } else if (isBodyParserError(err) && err.status < 500) {
      appError = new AppError(
        err.status,
        "malformed_request",
        "the request body is not valid JSON",
      );
    } else {
      logger.error({ err, method: req.method, path: req.path }, "unhandled error");
      appError = new AppError(500, "internal_error", "internal error");
    }
    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
        requestId: req.requestId,
      },
    });
  };
}
