import { Request, Response } from 'express';
import { incomingService, incomingSchema } from '../services/incoming.service';
import { success, fail } from '../utils/response';
import { prisma } from '../config/database';

export const incomingController = {
  async createIncoming(req: Request, res: Response) {
    const result = incomingSchema.safeParse(req.body);
    if (!result.success) {
      return fail(res, '请求参数验证失败', 400, result.error.issues);
    }
    if (!req.user) return fail(res, '请先登录', 401);

    const operator = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, region: true, role: true },
    });
    if (!operator) return fail(res, '账号信息不存在', 404);

    let region: string | undefined;
    if (operator.role === 'CDC_ADMIN') {
      region = undefined;
    } else {
      if (!operator.region) {
        return fail(res, `当前账号未配置所属区域，无法执行入库操作。请联系管理员在账号资料中完善区域信息`, 400);
      }
      region = operator.region;
    }

    const data = await incomingService.processIncoming(result.data, req.user.userId, region);
    return success(res, data, '疫苗入库成功', 201);
  },

  async listIncoming(req: Request, res: Response) {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const data = await incomingService.listIncomingRecords(page, pageSize);
    return success(res, data);
  },
};
