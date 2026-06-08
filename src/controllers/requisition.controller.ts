import { Request, Response } from 'express';
import { requisitionService, requisitionCreateSchema, requisitionApproveSchema } from '../services/requisition.service';
import { success, fail } from '../utils/response';
import { z } from 'zod';

export const requisitionController = {
  async create(req: Request, res: Response) {
    const result = requisitionCreateSchema.safeParse(req.body);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    if (!req.user) return fail(res, '请先登录', 401);
    const data = await requisitionService.createRequisition(result.data, req.user.userId);
    return success(res, data, '申领提交成功', 201);
  },

  async approve(req: Request, res: Response) {
    const result = requisitionApproveSchema.safeParse(req.body);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    if (!req.user) return fail(res, '请先登录', 401);
    const data = await requisitionService.approveRequisition(req.params.id, result.data, req.user.userId);
    return success(res, data, '审批通过');
  },

  async reject(req: Request, res: Response) {
    const schema = z.object({ reason: z.string().min(1) });
    const result = schema.safeParse(req.body);
    if (!result.success) return fail(res, '请提供拒绝原因', 400);
    if (!req.user) return fail(res, '请先登录', 401);
    const data = await requisitionService.rejectRequisition(req.params.id, result.data.reason, req.user.userId);
    return success(res, data, '已拒绝申领');
  },

  async list(req: Request, res: Response) {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const data = await requisitionService.listRequisitions(
      req.query.status as string,
      req.query.siteId as string,
      page,
      pageSize
    );
    return success(res, data);
  },

  async getById(req: Request, res: Response) {
    const { prisma } = await import('../config/database');
    const record = await prisma.vaccineRequisition.findUnique({
      where: { id: req.params.id },
      include: {
        items: { include: { vaccine: true } },
        site: true,
        vehicle: true,
        delivery: true,
      },
    });
    if (!record) return fail(res, '申领单不存在', 404);
    return success(res, record);
  },
};
