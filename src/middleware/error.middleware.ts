import { Request, Response, NextFunction } from 'express';
import { fail, AppError } from '../utils/response';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${err.message}`);
  console.error(err.stack);

  if (err instanceof AppError) {
    return fail(res, err.message, err.statusCode, err.errors);
  }

  if (err.name === 'PrismaClientKnownRequestError') {
    return fail(res, '数据库操作错误', 500, { code: (err as { code?: string }).code });
  }

  if (err.name === 'ZodError') {
    return fail(res, '请求数据验证失败', 400, (err as { issues?: unknown }).issues);
  }

  return fail(res, '服务器内部错误', 500, { error: err.message });
}

export function notFoundHandler(req: Request, res: Response) {
  return fail(res, `路由不存在: ${req.method} ${req.path}`, 404);
}
