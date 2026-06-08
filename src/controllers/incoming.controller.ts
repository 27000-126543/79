import { Request, Response } from 'express';
import { incomingService, incomingSchema } from '../services/incoming.service';
import { success, fail } from '../utils/response';

export const incomingController = {
  async createIncoming(req: Request, res: Response) {
    const result = incomingSchema.safeParse(req.body);
    if (!result.success) {
      return fail(res, '请求参数验证失败', 400, result.error.issues);
    }
    if (!req.user) return fail(res, '请先登录', 401);
    const data = await incomingService.processIncoming(result.data, req.user.userId, req.user.role === 'CDC_ADMIN' ? undefined : 'default');
    return success(res, data, '疫苗入库成功', 201);
  },

  async listIncoming(req: Request, res: Response) {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const data = await incomingService.listIncomingRecords(page, pageSize);
    return success(res, data);
  },
};
