import { Request, Response } from 'express';
import { deliveryService, temperatureLogSchema, emergencyOrderSchema } from '../services/delivery.service';
import { success, fail } from '../utils/response';
import { EmergencyOrderStatus } from '@prisma/client';

export const deliveryController = {
  async logTemperature(req: Request, res: Response) {
    const result = temperatureLogSchema.safeParse(req.body);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    const data = await deliveryService.logTemperature(result.data);
    return success(res, data, data.alertCheck.isAlert ? '温度异常已告警' : '温度记录成功');
  },

  async createEmergencyOrder(req: Request, res: Response) {
    const result = emergencyOrderSchema.safeParse(req.body);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    if (!req.user) return fail(res, '请先登录', 401);
    const data = await deliveryService.createEmergencyOrder(result.data, req.user.userId);
    return success(res, data, '应急工单已创建', 201);
  },

  async updateEmergencyOrderStatus(req: Request, res: Response) {
    const { status } = req.body;
    if (!status) return fail(res, '请提供状态', 400);
    if (!req.user) return fail(res, '请先登录', 401);
    const data = await deliveryService.updateEmergencyOrderStatus(req.params.id, status as EmergencyOrderStatus, req.user.userId);
    return success(res, data, '状态已更新');
  },

  async startDelivery(req: Request, res: Response) {
    const { driverId } = req.body;
    if (!driverId) return fail(res, '请提供司机ID', 400);
    const data = await deliveryService.startDelivery(req.params.id, driverId);
    return success(res, data, '配送已启动');
  },

  async completeDelivery(req: Request, res: Response) {
    const data = await deliveryService.completeDelivery(req.params.id);
    return success(res, data, '配送已完成');
  },

  async listDeliveries(req: Request, res: Response) {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const data = await deliveryService.listDeliveries(req.query.status as string, page, pageSize);
    return success(res, data);
  },

  async getTemperatureLogs(req: Request, res: Response) {
    const { prisma } = await import('../config/database');
    const deliveryId = req.query.deliveryId as string;
    const where: any = {};
    if (deliveryId) where.deliveryId = deliveryId;
    const logs = await prisma.temperatureLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return success(res, logs);
  },

  async listEmergencyOrders(req: Request, res: Response) {
    const { prisma } = await import('../config/database');
    const status = req.query.status as string;
    const where: any = {};
    if (status) where.status = status;
    const orders = await prisma.emergencyOrder.findMany({
      where,
      include: { delivery: true, batch: { include: { vaccine: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return success(res, orders);
  },
};
