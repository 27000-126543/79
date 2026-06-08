import { prisma } from '../config/database';
import { AppError } from '../utils/response';
import { NotificationType, AppointmentStatus } from '@prisma/client';
import { notificationService } from './notification.service';
import { wsService } from './websocket.service';
import { z } from 'zod';
import { addDays, addMonths, isBefore, differenceInCalendarDays } from 'date-fns';
import { config } from '../config';

export const vaccinationSchema = z.object({
  appointmentId: z.string().optional(),
  childId: z.string(),
  siteId: z.string(),
  vaccineId: z.string(),
  batchId: z.string(),
  administeredBy: z.string(),
  doseNumber: z.number().min(1),
  administrationDate: z.string().transform((d) => new Date(d)).optional(),
  siteReaction: z.string().optional(),
  systemicReaction: z.string().optional(),
  remarks: z.string().optional(),
  planId: z.string().optional(),
});

export const adverseReactionSchema = z.object({
  vaccinationRecordId: z.string(),
  reporterId: z.string(),
  severity: z.enum(['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING', 'FATAL']),
  symptoms: z.record(z.string(), z.unknown()),
  onsetDate: z.string().transform((d) => new Date(d)),
  description: z.string().optional(),
});

export const scrapSchema = z.object({
  batchId: z.string(),
  quantity: z.number().min(1),
  reason: z.string(),
  disposalMethod: z.string().optional(),
  witness: z.string().optional(),
});

class VaccinationService {
  private async calculateNextVaccinationDate(
    vaccineId: string,
    lastDate: Date,
    doseNumber: number,
    planId?: string
  ): Promise<Date | null> {
    const vaccine = await prisma.vaccineCatalog.findUnique({
      where: { id: vaccineId },
      select: { standardDoseCount: true, doseIntervalDays: true, name: true },
    });
    if (!vaccine) return null;

    if (vaccine.standardDoseCount === 1) {
      return null;
    }

    if (doseNumber >= vaccine.standardDoseCount) {
      return null;
    }

    let intervalDays = vaccine.doseIntervalDays;

    if (planId) {
      const nextPlan = await prisma.immunizationPlan.findFirst({
        where: { vaccineId, doseNumber: doseNumber + 1 },
        select: { intervalDays: true },
      });
      if (nextPlan && nextPlan.intervalDays > 0) {
        intervalDays = nextPlan.intervalDays;
      }
    } else {
      const nextPlan = await prisma.immunizationPlan.findFirst({
        where: { vaccineId, doseNumber: doseNumber + 1 },
        select: { intervalDays: true },
      });
      if (nextPlan && nextPlan.intervalDays > 0) {
        intervalDays = nextPlan.intervalDays;
      }
    }

    if (intervalDays <= 0) {
      return null;
    }

    return addDays(lastDate, intervalDays);
  }

  async createVaccinationRecord(data: z.infer<typeof vaccinationSchema>) {
    const child = await prisma.child.findUnique({ where: { id: data.childId } });
    if (!child) throw new AppError('儿童信息不存在', 404);

    const batch = await prisma.vaccineBatch.findUnique({ where: { id: data.batchId } });
    if (!batch) throw new AppError('疫苗批次不存在', 404);

    const siteStock = await prisma.inventoryStock.findFirst({
      where: { siteId: data.siteId, batchId: data.batchId, quantity: { gt: 0 } },
    });
    if (!siteStock) throw new AppError('该接种点无此批次疫苗库存', 400);

    const certificateNo = `CERT${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const adminDate = data.administrationDate || new Date();
    const nextDate = await this.calculateNextVaccinationDate(
      data.vaccineId,
      adminDate,
      data.doseNumber,
      data.planId
    );

    return prisma.$transaction(async (tx) => {
      await tx.inventoryStock.update({
        where: { id: siteStock.id },
        data: { quantity: { decrement: 1 }, lastUpdated: new Date() },
      });

      const record = await tx.vaccinationRecord.create({
        data: {
          certificateNo,
          appointmentId: data.appointmentId,
          childId: data.childId,
          siteId: data.siteId,
          vaccineId: data.vaccineId,
          batchId: data.batchId,
          administeredBy: data.administeredBy,
          administrationDate: adminDate,
          doseNumber: data.doseNumber,
          nextVaccinationDate: nextDate,
          siteReaction: data.siteReaction,
          systemicReaction: data.systemicReaction,
          remarks: data.remarks,
        },
        include: {
          child: true,
          site: true,
          vaccine: true,
          batch: true,
          administrator: { select: { id: true, name: true } },
        },
      });

      if (data.appointmentId) {
        await tx.appointment.update({
          where: { id: data.appointmentId },
          data: { status: AppointmentStatus.VACCINATED },
        });
      }

      if (data.planId) {
        await tx.childImmunizationPlan.updateMany({
          where: { childId: data.childId, planId: data.planId },
          data: {
            status: 'COMPLETED',
            completedDate: adminDate,
            vaccinationRecordId: record.id,
          },
        });
      }

      await tx.inventoryLog.create({
        data: {
          batchId: data.batchId,
          action: 'VACCINATION',
          quantity: 1,
          location: data.siteId,
          operatorId: data.administeredBy,
          reason: `接种使用，接种人：${child.name}`,
        },
      });

      wsService.sendStatusChange('vaccination_record', record.id, 'CREATED', {
        certificateNo,
        childName: record.child.name,
        vaccineName: record.vaccine.name,
      });

      if (record.child.parentId) {
        await notificationService.notifyUser(
          record.child.parentId,
          NotificationType.VACCINATION_COMPLETED,
          '接种完成',
          `${record.child.name}已完成${record.vaccine.name}接种，电子接种证号：${certificateNo}${nextDate ? `，下次接种：${nextDate.toLocaleDateString()}` : ''}`,
          { recordId: record.id, certificateNo, nextVaccinationDate: nextDate }
        );
      }

      if (nextDate) {
        this.scheduleNextVaccinationReminder(record.child.parentId, record.child.name, record.vaccine.name, nextDate);
      }

      return record;
    });
  }

  private async scheduleNextVaccinationReminder(parentId: string, childName: string, vaccineName: string, nextDate: Date) {
    const reminderDate = addDays(nextDate, -config.reminderDays);
    if (isBefore(new Date(), reminderDate)) {
      setTimeout(async () => {
        await notificationService.notifyUser(
          parentId,
          NotificationType.APPOINTMENT_REMINDER,
          '接种提醒',
          `${childName}的${vaccineName}下次接种日期为${nextDate.toLocaleDateString()}，请及时预约`,
          { nextDate }
        );
      }, Math.max(0, reminderDate.getTime() - Date.now()));
    }
  }

  async getVaccinationCertificate(recordId: string) {
    const record = await prisma.vaccinationRecord.findUnique({
      where: { id: recordId },
      include: {
        child: true,
        site: true,
        vaccine: true,
        batch: true,
        administrator: { select: { id: true, name: true } },
      },
    });
    if (!record) throw new AppError('接种记录不存在', 404);
    return record;
  }

  async getChildVaccinationHistory(childId: string) {
    const records = await prisma.vaccinationRecord.findMany({
      where: { childId },
      include: {
        vaccine: true,
        site: true,
        batch: true,
        administrator: { select: { id: true, name: true } },
      },
      orderBy: { administrationDate: 'desc' },
    });

    const plans = await prisma.childImmunizationPlan.findMany({
      where: { childId },
      include: { plan: { include: { vaccine: true } } },
    });

    return { records, immunizationPlans: plans };
  }

  async reportAdverseReaction(data: z.infer<typeof adverseReactionSchema>) {
    const vaccination = await prisma.vaccinationRecord.findUnique({
      where: { id: data.vaccinationRecordId },
      include: { child: true, site: true, vaccine: true },
    });
    if (!vaccination) throw new AppError('接种记录不存在', 404);

    return prisma.$transaction(async (tx) => {
      const reportNo = `AEF${Date.now()}${Math.floor(Math.random() * 1000)}`;

      let assignedAuditorId: string | null = null;
      const severe = ['SEVERE', 'LIFE_THREATENING', 'FATAL'].includes(data.severity);

      if (severe) {
        const auditors = await tx.user.findMany({
          where: { role: 'AUDITOR' },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        if (auditors.length > 0) {
          assignedAuditorId = auditors[Math.floor(Math.random() * auditors.length)].id;
        }
      } else {
        const auditors = await tx.user.findMany({
          where: { role: 'AUDITOR' },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        if (auditors.length > 0) {
          assignedAuditorId = auditors[0].id;
        }
      }

      const report = await tx.adverseReactionReport.create({
        data: {
          reportNo,
          vaccinationRecordId: data.vaccinationRecordId,
          reporterId: data.reporterId,
          severity: data.severity,
          symptoms: data.symptoms as any,
          onsetDate: data.onsetDate,
          description: data.description,
          status: severe ? 'INVESTIGATING' : 'UNDER_REVIEW',
          assignedAuditorId,
          notifiedDrugAdmin: severe,
        },
        include: {
          vaccinationRecord: { include: { child: true, vaccine: true } },
          reporter: { select: { id: true, name: true } },
          assignedAuditor: { select: { id: true, name: true } },
        },
      });

      wsService.sendStatusChange('adverse_reaction', report.id, severe ? 'INVESTIGATING' : 'REPORTED', {
        reportNo,
        severity: data.severity,
        childName: vaccination.child.name,
      });

      await notificationService.notifyCDC(
        NotificationType.ADVERSE_REACTION_REPORTED,
        severe ? '严重不良反应紧急报告' : '不良反应报告',
        `${vaccination.child.name}接种${vaccination.vaccine.name}后报告${this.translateSeverity(data.severity)}不良反应，报告号：${reportNo}`,
        { reportId: report.id, reportNo, severity: data.severity }
      );

      if (severe) {
        await notificationService.notifyDrugAdmin(
          NotificationType.ADVERSE_REACTION_REPORTED,
          '严重不良反应紧急通知',
          `${vaccination.child.name}接种${vaccination.vaccine.name}后发生${this.translateSeverity(data.severity)}不良反应，报告号：${reportNo}，请启动紧急调查`,
          { reportId: report.id, reportNo }
        );

        if (assignedAuditorId) {
          await notificationService.notifyUser(
            assignedAuditorId,
            NotificationType.EMERGENCY_ALERT,
            '紧急调查任务分配',
            `您被分配调查严重不良反应报告${reportNo}，请立即处理`,
            { reportId: report.id, reportNo }
          );
        }
      } else if (assignedAuditorId) {
        await notificationService.notifyUser(
          assignedAuditorId,
          NotificationType.ADVERSE_REACTION_REPORTED,
          '不良反应审核任务',
          `您被分配审核不良反应报告${reportNo}`,
          { reportId: report.id, reportNo }
        );
      }

      return report;
    });
  }

  async updateAdverseReactionStatus(reportId: string, status: string, operatorId: string, conclusion?: string) {
    const report = await prisma.adverseReactionReport.findUnique({ where: { id: reportId } });
    if (!report) throw new AppError('报告不存在', 404);

    const updated = await prisma.adverseReactionReport.update({
      where: { id: reportId },
      data: { status: status as any, conclusion, investigationData: conclusion ? { updatedBy: operatorId, conclusion, updatedAt: new Date() } as any : undefined },
    });

    wsService.sendStatusChange('adverse_reaction', reportId, status, { reportNo: report.reportNo });
    return updated;
  }

  async checkNearExpiryAndScrap() {
    const now = new Date();
    const nearExpiryDate = addDays(now, config.nearExpiryDays);
    const results: { locked: number; scrapped: number; messages: string[] } = { locked: 0, scrapped: 0, messages: [] };

    const nearExpiryBatches = await prisma.vaccineBatch.findMany({
      where: {
        status: 'NORMAL',
        expiryDate: { lte: nearExpiryDate, gte: now },
        availableQuantity: { gt: 0 },
      },
      include: { vaccine: true },
    });

    for (const batch of nearExpiryBatches) {
      await prisma.vaccineBatch.update({
        where: { id: batch.id },
        data: { status: 'NEAR_EXPIRY' },
      });
      await prisma.inventoryStock.updateMany({
        where: { batchId: batch.id, status: 'NORMAL' },
        data: { status: 'NEAR_EXPIRY', lockedQuantity: 0, lastUpdated: now },
      });
      results.locked++;
      results.messages.push(`${batch.vaccine.name}批次${batch.batchNumber}已标记近效期，请优先使用`);

      await notificationService.notifyCDC(
        NotificationType.INVENTORY_ALERT,
        '疫苗近效期提醒',
        `${batch.vaccine.name}（批次: ${batch.batchNumber}）将在${differenceInCalendarDays(batch.expiryDate, now)}天内过期，请优先调配使用`,
        { batchId: batch.id, batchNumber: batch.batchNumber, daysLeft: differenceInCalendarDays(batch.expiryDate, now) }
      );
    }

    const expiredBatches = await prisma.vaccineBatch.findMany({
      where: {
        status: { in: ['NORMAL', 'NEAR_EXPIRY', 'LOCKED'] },
        expiryDate: { lt: now },
        availableQuantity: { gt: 0 },
      },
      include: { vaccine: true },
    });

    for (const batch of expiredBatches) {
      const scrapNo = `SCP${Date.now()}${Math.floor(Math.random() * 1000)}`;
      await prisma.vaccineBatch.update({
        where: { id: batch.id },
        data: { status: 'EXPIRED', availableQuantity: 0 },
      });
      await prisma.inventoryStock.updateMany({
        where: { batchId: batch.id },
        data: { status: 'SCRAPPED', quantity: 0, lastUpdated: now },
      });
      await prisma.scrappedRecord.create({
        data: {
          scrapNo,
          batchId: batch.id,
          quantity: batch.availableQuantity,
          reason: '过期自动报废',
          scrappedBy: 'system',
          disposalMethod: '高温灭菌销毁',
        },
      });
      results.scrapped++;
      results.messages.push(`${batch.vaccine.name}批次${batch.batchNumber}已过期，自动报废${batch.availableQuantity}剂`);

      await notificationService.notifyCDC(
        NotificationType.INVENTORY_ALERT,
        '疫苗过期报废',
        `${batch.vaccine.name}（批次: ${batch.batchNumber}）已过期，自动报废${batch.availableQuantity}剂`,
        { batchId: batch.id, batchNumber: batch.batchNumber, scrappedQty: batch.availableQuantity }
      );
    }

    return results;
  }

  async manualScrap(data: z.infer<typeof scrapSchema>, operatorId: string) {
    const batch = await prisma.vaccineBatch.findUnique({
      where: { id: data.batchId },
      include: { vaccine: true },
    });
    if (!batch) throw new AppError('批次不存在', 404);
    if (batch.availableQuantity < data.quantity) {
      throw new AppError(`可用数量不足，当前可用${batch.availableQuantity}剂`, 400);
    }

    return prisma.$transaction(async (tx) => {
      await tx.vaccineBatch.update({
        where: { id: data.batchId },
        data: { availableQuantity: { decrement: data.quantity }, status: batch.availableQuantity - data.quantity === 0 ? 'SCRAPPED' : batch.status },
      });

      const scrapNo = `SCP${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const scrap = await tx.scrappedRecord.create({
        data: {
          scrapNo,
          batchId: data.batchId,
          quantity: data.quantity,
          reason: data.reason,
          scrappedBy: operatorId,
          disposalMethod: data.disposalMethod,
          witness: data.witness,
        },
      });

      await tx.inventoryLog.create({
        data: {
          batchId: data.batchId,
          action: 'SCRAP',
          quantity: data.quantity,
          operatorId,
          reason: data.reason,
        },
      });

      wsService.sendStatusChange('vaccine_batch', data.batchId, 'SCRAPPED', {
        batchNumber: batch.batchNumber,
        quantity: data.quantity,
      });

      await notificationService.notifyCDC(
        NotificationType.INVENTORY_ALERT,
        '疫苗报废',
        `${batch.vaccine.name}（批次: ${batch.batchNumber}）人工报废${data.quantity}剂，原因：${data.reason}`,
        { batchId: data.batchId, batchNumber: batch.batchNumber, quantity: data.quantity, reason: data.reason }
      );

      return scrap;
    });
  }

  private translateSeverity(severity: string): string {
    const map: Record<string, string> = {
      MILD: '轻度',
      MODERATE: '中度',
      SEVERE: '重度',
      LIFE_THREATENING: '危及生命',
      FATAL: '致死',
    };
    return map[severity] || severity;
  }
}

export const vaccinationService = new VaccinationService();
