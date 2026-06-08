import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, fail } from '../utils/response';
import { z } from 'zod';

const childSchema = z.object({
  parentId: z.string(),
  name: z.string(),
  gender: z.string(),
  birthDate: z.string().transform((d) => new Date(d)),
  idCard: z.string().optional(),
});

export const childController = {
  async create(req: Request, res: Response) {
    const result = childSchema.safeParse(req.body);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    const child = await prisma.child.create({ data: result.data });
    return success(res, child, '儿童信息创建成功', 201);
  },

  async list(req: Request, res: Response) {
    const parentId = req.query.parentId as string;
    const where: any = {};
    if (parentId) where.parentId = parentId;
    const children = await prisma.child.findMany({ where, include: { parent: { select: { id: true, name: true } } } });
    return success(res, children);
  },

  async getById(req: Request, res: Response) {
    const child = await prisma.child.findUnique({ where: { id: req.params.id }, include: { parent: true } });
    if (!child) return fail(res, '儿童信息不存在', 404);
    return success(res, child);
  },
};

export const siteController = {
  async list(req: Request, res: Response) {
    const region = req.query.region as string;
    const where: any = {};
    if (region) where.region = region;
    const sites = await prisma.vaccinationSite.findMany({ where });
    return success(res, sites);
  },

  async getById(req: Request, res: Response) {
    const site = await prisma.vaccinationSite.findUnique({ where: { id: req.params.id } });
    if (!site) return fail(res, '接种点不存在', 404);
    return success(res, site);
  },
};

export const vaccineController = {
  async list(req: Request, res: Response) {
    const vaccines = await prisma.vaccineCatalog.findMany({ include: { immunizationPlans: true } });
    return success(res, vaccines);
  },

  async getById(req: Request, res: Response) {
    const vaccine = await prisma.vaccineCatalog.findUnique({ where: { id: req.params.id }, include: { immunizationPlans: true } });
    if (!vaccine) return fail(res, '疫苗信息不存在', 404);
    return success(res, vaccine);
  },
};

export const notificationController = {
  async list(req: Request, res: Response) {
    if (!req.user) return fail(res, '请先登录', 401);
    const unreadOnly = req.query.unread === 'true';
    const where: any = { userId: req.user.userId };
    if (unreadOnly) where.isRead = false;

    const notifications = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return success(res, notifications);
  },

  async markRead(req: Request, res: Response) {
    if (!req.user) return fail(res, '请先登录', 401);
    const { id } = req.params;
    if (id === 'all') {
      await prisma.notification.updateMany({ where: { userId: req.user.userId }, data: { isRead: true, readAt: new Date() } });
      return success(res, null, '全部标记已读');
    }
    const notification = await prisma.notification.update({
      where: { id, userId: req.user.userId },
      data: { isRead: true, readAt: new Date() },
    });
    return success(res, notification);
  },
};

export const vehicleController = {
  async list(req: Request, res: Response) {
    const region = req.query.region as string;
    const where: any = {};
    if (region) where.region = region;
    const vehicles = await prisma.deliveryVehicle.findMany({ where, include: { equipment: true } });
    return success(res, vehicles);
  },
};

export const storageController = {
  async listColdStorages(req: Request, res: Response) {
    const region = req.query.region as string;
    const where: any = {};
    if (region) where.region = region;
    const storages = await prisma.coldStorage.findMany({ where, include: { slots: true, equipment: true } });
    return success(res, storages);
  },

  async listEquipment(req: Request, res: Response) {
    const where: any = {};
    if (req.query.coldStorageId) where.coldStorageId = req.query.coldStorageId;
    if (req.query.vehicleId) where.vehicleId = req.query.vehicleId;
    const equipment = await prisma.coldChainEquipment.findMany({ where, include: { inspections: { take: 5, orderBy: { inspectionDate: 'desc' } } } });
    return success(res, equipment);
  },
};
