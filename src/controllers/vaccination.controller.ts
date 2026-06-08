import { Request, Response } from 'express';
import { vaccinationService, vaccinationSchema, adverseReactionSchema, scrapSchema } from '../services/vaccination.service';
import { success, fail } from '../utils/response';

export const vaccinationController = {
  async createVaccination(req: Request, res: Response) {
    const result = vaccinationSchema.safeParse(req.body);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    const data = await vaccinationService.createVaccinationRecord(result.data);
    return success(res, data, '接种记录已创建', 201);
  },

  async getCertificate(req: Request, res: Response) {
    const data = await vaccinationService.getVaccinationCertificate(req.params.id);
    return success(res, data);
  },

  async getChildHistory(req: Request, res: Response) {
    const data = await vaccinationService.getChildVaccinationHistory(req.params.childId);
    return success(res, data);
  },

  async reportAdverseReaction(req: Request, res: Response) {
    const result = adverseReactionSchema.safeParse(req.body);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    const data = await vaccinationService.reportAdverseReaction(result.data);
    return success(res, data, '不良反应已上报', 201);
  },

  async updateAdverseReactionStatus(req: Request, res: Response) {
    const { status, conclusion } = req.body;
    if (!status) return fail(res, '请提供状态', 400);
    if (!req.user) return fail(res, '请先登录', 401);
    const data = await vaccinationService.updateAdverseReactionStatus(req.params.id, status, req.user.userId, conclusion);
    return success(res, data, '状态已更新');
  },

  async listAdverseReactions(req: Request, res: Response) {
    const { prisma } = await import('../config/database');
    const where: any = {};
    if (req.query.severity) where.severity = req.query.severity;
    if (req.query.status) where.status = req.query.status;

    const records = await prisma.adverseReactionReport.findMany({
      where,
      include: {
        vaccinationRecord: { include: { child: true, vaccine: true, site: true } },
        reporter: { select: { id: true, name: true } },
        assignedAuditor: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return success(res, records);
  },

  async checkExpiryAndScrap(req: Request, res: Response) {
    const data = await vaccinationService.checkNearExpiryAndScrap();
    return success(res, data, `已完成：锁定近效期${data.locked}批，报废过期${data.scrapped}批`);
  },

  async manualScrap(req: Request, res: Response) {
    const result = scrapSchema.safeParse(req.body);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    if (!req.user) return fail(res, '请先登录', 401);
    const data = await vaccinationService.manualScrap(result.data, req.user.userId);
    return success(res, data, '报废记录已创建', 201);
  },

  async listScrappedRecords(req: Request, res: Response) {
    const { prisma } = await import('../config/database');
    const records = await prisma.scrappedRecord.findMany({
      include: { batch: { include: { vaccine: true } } },
      orderBy: { scrapDate: 'desc' },
    });
    return success(res, records);
  },

  async listInventory(req: Request, res: Response) {
    const { prisma } = await import('../config/database');
    const where: any = {};
    if (req.query.siteId) where.siteId = req.query.siteId;
    if (req.query.status) where.status = req.query.status;

    const records = await prisma.inventoryStock.findMany({
      where,
      include: { batch: { include: { vaccine: true } }, site: true },
      orderBy: { lastUpdated: 'desc' },
    });
    return success(res, records);
  },

  async listVaccineBatches(req: Request, res: Response) {
    const { prisma } = await import('../config/database');
    const where: any = {};
    if (req.query.vaccineId) where.vaccineId = req.query.vaccineId;
    if (req.query.status) where.status = req.query.status;

    const records = await prisma.vaccineBatch.findMany({
      where,
      include: { vaccine: true, storageSlot: { include: { coldStorage: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return success(res, records);
  },
};
