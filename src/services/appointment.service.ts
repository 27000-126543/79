import { prisma } from '../config/database';
import { AppError } from '../utils/response';
import { AppointmentStatus, NotificationType } from '@prisma/client';
import { notificationService } from './notification.service';
import { wsService } from './websocket.service';
import { z } from 'zod';
import { differenceInMonths, addMonths, isSameDay, startOfDay, endOfDay, addMinutes, parseISO } from 'date-fns';

export const appointmentCreateSchema = z.object({
  childId: z.string(),
  siteId: z.string(),
  vaccineId: z.string(),
  planId: z.string().optional(),
  appointmentDate: z.string().transform((d) => new Date(d)),
  timeSlot: z.string(),
});

export const appointmentUpdateSchema = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'VACCINATED', 'CANCELLED', 'NO_SHOW']),
});

class AppointmentService {
  private calculateChildAgeMonths(birthDate: Date): number {
    return differenceInMonths(new Date(), birthDate);
  }

  async getPreviousVaccinationDate(childId: string, vaccineId: string): Promise<Date | null> {
    const record = await prisma.vaccinationRecord.findFirst({
      where: { childId, vaccineId },
      orderBy: { administrationDate: 'desc' },
    });
    return record ? record.administrationDate : null;
  }

  async checkImmunizationCompliance(childId: string, vaccineId: string, planId?: string): Promise<{ compliant: boolean; reason?: string; plan?: { minAge: number; maxAge?: number; intervalDays: number } }> {
    const child = await prisma.child.findUnique({ where: { id: childId } });
    if (!child) return { compliant: false, reason: '儿童信息不存在' };

    const vaccine = await prisma.vaccineCatalog.findUnique({ where: { id: vaccineId } });
    if (!vaccine) return { compliant: false, reason: '疫苗信息不存在' };

    const ageMonths = this.calculateChildAgeMonths(child.birthDate);

    let plan: any = null;
    if (planId) {
      plan = await prisma.immunizationPlan.findUnique({ where: { id: planId } });
    } else {
      plan = await prisma.immunizationPlan.findFirst({
        where: {
          vaccineId,
          minAgeMonths: { lte: ageMonths },
        },
        orderBy: [{ minAgeMonths: 'desc' }, { doseNumber: 'asc' }],
      });
    }

    if (!plan) {
      if (ageMonths < vaccine.suitableAgeMonths) {
        return { compliant: false, reason: `儿童年龄${ageMonths}月，未达到${vaccine.suitableAgeMonths}月接种年龄要求` };
      }
      if (vaccine.maxAgeMonths && ageMonths > vaccine.maxAgeMonths) {
        return { compliant: false, reason: `儿童年龄${ageMonths}月，已超出${vaccine.maxAgeMonths}月最大接种年龄` };
      }
      plan = { minAgeMonths: vaccine.suitableAgeMonths, maxAgeMonths: vaccine.maxAgeMonths, intervalDays: vaccine.doseIntervalDays };
    }

    if (ageMonths < plan.minAgeMonths) {
      return { compliant: false, reason: `儿童年龄${ageMonths}月，未达到该剂次${plan.minAgeMonths}月龄要求` };
    }
    if (plan.maxAgeMonths && ageMonths > plan.maxAgeMonths) {
      return { compliant: false, reason: `儿童年龄${ageMonths}月，已超出该剂次${plan.maxAgeMonths}月龄限制` };
    }

    const lastVaccination = await this.getPreviousVaccinationDate(childId, vaccineId);
    if (lastVaccination && plan.intervalDays > 0) {
      const interval = Math.floor((new Date().getTime() - lastVaccination.getTime()) / (1000 * 60 * 60 * 24));
      if (interval < plan.intervalDays) {
        return { compliant: false, reason: `与前一针间隔${interval}天，未达到${plan.intervalDays}天最小间隔要求` };
      }
    }

    return { compliant: true, plan: { minAge: plan.minAgeMonths, maxAge: plan.maxAgeMonths, intervalDays: plan.intervalDays } };
  }

  async checkInventory(siteId: string, vaccineId: string): Promise<{ available: boolean; totalAvailable: number; nearExpiryQty: number; suggestions?: string }> {
    const stock = await prisma.inventoryStock.findMany({
      where: {
        siteId,
        batch: { vaccineId },
        status: { in: ['NORMAL', 'NEAR_EXPIRY'] },
      },
      include: { batch: true },
    });

    let totalAvailable = 0;
    let nearExpiryQty = 0;
    const suggestions: string[] = [];

    const thirtyDaysLater = addMonths(new Date(), 1);
    for (const item of stock) {
      if (item.batch.expiryDate <= thirtyDaysLater) {
        nearExpiryQty += item.quantity;
      }
      totalAvailable += item.quantity - item.lockedQuantity;
    }

    if (nearExpiryQty > 0) {
      suggestions.push(`有${nearExpiryQty}剂近效期疫苗，建议优先使用`);
    }

    return {
      available: totalAvailable > 0,
      totalAvailable,
      nearExpiryQty,
      suggestions: suggestions.join('；'),
    };
  }

  async checkSiteCapacity(siteId: string, date: Date, timeSlot: string): Promise<{ available: boolean; currentCount: number; maxCapacity: number; alternativeSlots?: string[] }> {
    const site = await prisma.vaccinationSite.findUnique({ where: { id: siteId } });
    if (!site) return { available: false, currentCount: 0, maxCapacity: 0 };

    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);

    const appointmentCount = await prisma.appointment.count({
      where: {
        siteId,
        appointmentDate: { gte: dayStart, lte: dayEnd },
        timeSlot,
        status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.CHECKED_IN] },
      },
    });

    const hourlyCapacity = Math.ceil(site.dailyCapacity / 8);
    const available = appointmentCount < hourlyCapacity;

    const alternativeSlots: string[] = [];
    if (!available) {
      for (let hour = 8; hour < 17; hour++) {
        const slot = `${hour.toString().padStart(2, '0')}:00`;
        if (slot === timeSlot) continue;
        const count = await prisma.appointment.count({
          where: {
            siteId,
            appointmentDate: { gte: dayStart, lte: dayEnd },
            timeSlot: slot,
            status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.CHECKED_IN] },
          },
        });
        if (count < hourlyCapacity) {
          alternativeSlots.push(slot);
          if (alternativeSlots.length >= 3) break;
        }
      }
    }

    return { available, currentCount: appointmentCount, maxCapacity: hourlyCapacity, alternativeSlots };
  }

  async getRecommendedTimeSlots(siteId: string, date: Date): Promise<string[]> {
    const site = await prisma.vaccinationSite.findUnique({ where: { id: siteId } });
    if (!site) return [];

    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);
    const hourlyCapacity = Math.ceil(site.dailyCapacity / 8);
    const recommended: string[] = [];

    for (let hour = 8; hour < 17; hour++) {
      const slot = `${hour.toString().padStart(2, '0')}:00`;
      const count = await prisma.appointment.count({
        where: {
          siteId,
          appointmentDate: { gte: dayStart, lte: dayEnd },
          timeSlot: slot,
          status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.CHECKED_IN] },
        },
      });
      if (count < hourlyCapacity * 0.8) {
        recommended.push(slot);
      }
    }
    return recommended;
  }

  async createAppointment(data: z.infer<typeof appointmentCreateSchema>, createdBy: string) {
    const compliance = await this.checkImmunizationCompliance(data.childId, data.vaccineId, data.planId);
    if (!compliance.compliant) {
      throw new AppError(`接种合规校验失败：${compliance.reason}`, 400);
    }

    const inventory = await this.checkInventory(data.siteId, data.vaccineId);
    if (!inventory.available) {
      throw new AppError('该接种点当前疫苗库存不足', 400);
    }

    const capacity = await this.checkSiteCapacity(data.siteId, data.appointmentDate, data.timeSlot);
    if (!capacity.available) {
      const alternatives = capacity.alternativeSlots || [];
      throw new AppError(
        `该时段预约已满，请选择其他时段${alternatives.length > 0 ? '，推荐时段：' + alternatives.join('、') : ''}`,
        400
      );
    }

    const child = await prisma.child.findUnique({ where: { id: data.childId } });
    const site = await prisma.vaccinationSite.findUnique({ where: { id: data.siteId } });
    const vaccine = await prisma.vaccineCatalog.findUnique({ where: { id: data.vaccineId } });

    return prisma.$transaction(async (tx) => {
      const appointmentNo = `APT${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const appointment = await tx.appointment.create({
        data: {
          appointmentNo,
          childId: data.childId,
          siteId: data.siteId,
          vaccineId: data.vaccineId,
          planId: data.planId,
          appointmentDate: data.appointmentDate,
          timeSlot: data.timeSlot,
          status: AppointmentStatus.CONFIRMED,
          createdBy,
        },
        include: {
          child: true,
          site: true,
          vaccine: true,
        },
      });

      wsService.sendStatusChange('appointment', appointment.id, 'CONFIRMED', {
        appointmentNo,
        childName: appointment.child.name,
        vaccineName: appointment.vaccine.name,
        siteName: appointment.site.name,
      });

      if (child && child.parentId) {
        await notificationService.notifyUser(
          child.parentId,
          NotificationType.APPOINTMENT_CONFIRMED,
          '预约确认',
          `${appointment.child.name}的${vaccine?.name}接种预约已确认，${data.appointmentDate.toLocaleDateString()} ${data.timeSlot}，地点：${appointment.site.name}`,
          { appointmentId: appointment.id, appointmentNo }
        );
      }

      if (site?.region) {
        await notificationService.notifyVaccinationSite(
          site.region,
          NotificationType.APPOINTMENT_CONFIRMED,
          '新接种预约',
          `${appointment.child.name}预约${vaccine?.name}，${data.appointmentDate.toLocaleDateString()} ${data.timeSlot}`,
          { appointmentId: appointment.id }
        );
      }

      return {
        appointment,
        complianceCheck: compliance,
        inventoryCheck: inventory,
        capacityCheck: capacity,
      };
    });
  }

  async updateAppointmentStatus(appointmentId: string, status: AppointmentStatus, operatorId?: string) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { child: true, site: true, vaccine: true },
    });
    if (!appointment) throw new AppError('预约不存在', 404);

    const updated = await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status,
        ...(status === AppointmentStatus.CHECKED_IN ? { checkInTime: new Date() } : {}),
      },
    });

    wsService.sendStatusChange('appointment', appointmentId, status, { appointmentNo: appointment.appointmentNo });

    if (appointment.child.parentId && (status === AppointmentStatus.CANCELLED || status === AppointmentStatus.NO_SHOW)) {
      await notificationService.notifyUser(
        appointment.child.parentId,
        NotificationType.APPOINTMENT_REMINDER,
        '预约状态变更',
        `${appointment.child.name}的${appointment.vaccine.name}接种预约${this.translateStatus(status)}`,
        { appointmentId, status }
      );
    }

    return updated;
  }

  async listAppointments(params: { childId?: string; siteId?: string; status?: string; date?: string; page?: number; pageSize?: number }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (params.childId) where.childId = params.childId;
    if (params.siteId) where.siteId = params.siteId;
    if (params.status) where.status = params.status;
    if (params.date) {
      const d = parseISO(params.date);
      where.appointmentDate = { gte: startOfDay(d), lte: endOfDay(d) };
    }

    const [records, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        skip,
        take: pageSize,
        include: { child: true, site: true, vaccine: true, creator: { select: { id: true, name: true } } },
        orderBy: { appointmentDate: 'desc' },
      }),
      prisma.appointment.count({ where }),
    ]);
    return { records, total, page, pageSize };
  }

  private translateStatus(status: AppointmentStatus): string {
    const map: Record<AppointmentStatus, string> = {
      PENDING: '待确认',
      CONFIRMED: '已确认',
      CHECKED_IN: '已签到',
      VACCINATED: '已接种',
      CANCELLED: '已取消',
      NO_SHOW: '未到场',
    };
    return map[status];
  }
}

export const appointmentService = new AppointmentService();
