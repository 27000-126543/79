import { Request, Response } from 'express';
import { appointmentService, appointmentCreateSchema } from '../services/appointment.service';
import { success, fail } from '../utils/response';
import { AppointmentStatus } from '@prisma/client';
import { parseISO } from 'date-fns';

export const appointmentController = {
  async create(req: Request, res: Response) {
    const result = appointmentCreateSchema.safeParse(req.body);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    if (!req.user) return fail(res, '请先登录', 401);
    const data = await appointmentService.createAppointment(result.data, req.user.userId);
    return success(res, data, '预约成功', 201);
  },

  async updateStatus(req: Request, res: Response) {
    const { status } = req.body;
    if (!status) return fail(res, '请提供状态', 400);
    const data = await appointmentService.updateAppointmentStatus(
      req.params.id,
      status as AppointmentStatus,
      req.user?.userId
    );
    return success(res, data, '状态已更新');
  },

  async checkAvailability(req: Request, res: Response) {
    const { siteId, date, vaccineId, childId, planId } = req.query;
    if (!siteId || !date) return fail(res, '请提供接种点和日期', 400);

    const d = parseISO(date as string);
    const [capacity, inventory, compliance, recommended] = await Promise.all([
      appointmentService.checkSiteCapacity(siteId as string, d, '09:00'),
      vaccineId ? appointmentService.checkInventory(siteId as string, vaccineId as string) : Promise.resolve(null),
      childId && vaccineId
        ? appointmentService.checkImmunizationCompliance(childId as string, vaccineId as string, planId as string | undefined)
        : Promise.resolve(null),
      appointmentService.getRecommendedTimeSlots(siteId as string, d),
    ]);

    return success(res, { capacity, inventory, compliance, recommendedSlots: recommended });
  },

  async list(req: Request, res: Response) {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const data = await appointmentService.listAppointments({
      childId: req.query.childId as string,
      siteId: req.query.siteId as string,
      status: req.query.status as string,
      date: req.query.date as string,
      page,
      pageSize,
    });
    return success(res, data);
  },

  async getById(req: Request, res: Response) {
    const { prisma } = await import('../config/database');
    const record = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: { child: true, site: true, vaccine: true, plan: true },
    });
    if (!record) return fail(res, '预约不存在', 404);
    return success(res, record);
  },
};
