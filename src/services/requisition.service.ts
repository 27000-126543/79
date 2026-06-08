import { prisma } from '../config/database';
import { AppError } from '../utils/response';
import { TemperatureZone, NotificationType, InventoryStatus } from '@prisma/client';
import { notificationService } from './notification.service';
import { wsService } from './websocket.service';
import { z } from 'zod';
import { addDays, subDays } from 'date-fns';

export const requisitionCreateSchema = z.object({
  siteId: z.string(),
  items: z.array(
    z.object({
      vaccineId: z.string(),
      requestedQty: z.number().min(1),
    })
  ),
  vehicleId: z.string().optional(),
});

export const requisitionApproveSchema = z.object({
  items: z.array(
    z.object({
      requisitionItemId: z.string(),
      approvedQty: z.number().min(0),
      batchId: z.string().optional(),
    })
  ),
  vehicleId: z.string(),
});

class RequisitionService {
  async calculateRecommendedQty(siteId: string, vaccineId: string, requestedQty: number): Promise<{ recommended: number; reason: string; historical: number }> {
    const thirtyDaysAgo = subDays(new Date(), 30);
    const lastConsumed = await prisma.vaccinationRecord.aggregate({
      where: {
        siteId,
        vaccineId,
        administrationDate: { gte: thirtyDaysAgo },
      },
      _count: true,
    });
    const historicalDaily = lastConsumed._count / 30;

    const siteStock = await prisma.inventoryStock.aggregate({
      where: {
        siteId,
        batch: { vaccineId },
        status: { not: InventoryStatus.SCRAPPED },
      },
      _sum: { quantity: true },
    });
    const currentStock = siteStock._sum?.quantity || 0;

    const safetyStock = Math.ceil(historicalDaily * 14);
    const avgConsumption = Math.ceil(historicalDaily * 30);

    let recommended = Math.max(requestedQty, avgConsumption - currentStock);
    recommended = Math.max(recommended, safetyStock);
    recommended = Math.max(recommended, 0);

    let reason = `基于近30日日均消耗${historicalDaily.toFixed(1)}剂计算，安全库存${safetyStock}剂`;
    if (currentStock > avgConsumption) {
      reason += `；当前库存${currentStock}剂已充足，建议减少申领量`;
    }

    const nearExpiryBatches = await prisma.inventoryStock.findMany({
      where: {
        siteId,
        batch: {
          vaccineId,
          expiryDate: { lte: addDays(new Date(), 60) },
        },
      },
      include: { batch: true },
    });
    if (nearExpiryBatches.length > 0) {
      const nearExpiryQty = nearExpiryBatches.reduce((s, i) => s + i.quantity, 0);
      reason += `；存在${nearExpiryQty}剂近效期疫苗，请优先使用`;
      recommended = Math.max(0, recommended - Math.floor(nearExpiryQty * 0.5));
    }

    return {
      recommended: Math.round(recommended),
      reason,
      historical: lastConsumed._count,
    };
  }

  async validateVehicleTemperature(vehicleId: string, vaccineIds: string[]): Promise<{ valid: boolean; mismatchVaccines?: { id: string; name: string; requiredZone: TemperatureZone }[]; vehicleZone?: TemperatureZone }> {
    const vehicle = await prisma.deliveryVehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) {
      return { valid: false };
    }

    const vaccines = await prisma.vaccineCatalog.findMany({
      where: { id: { in: vaccineIds } },
    });

    const mismatchVaccines = vaccines.filter((v) => v.temperatureZone !== vehicle.temperatureZone);

    if (mismatchVaccines.length > 0) {
      return {
        valid: false,
        mismatchVaccines: mismatchVaccines.map((v) => ({ id: v.id, name: v.name, requiredZone: v.temperatureZone })),
        vehicleZone: vehicle.temperatureZone,
      };
    }

    return { valid: true, vehicleZone: vehicle.temperatureZone };
  }

  async createRequisition(data: z.infer<typeof requisitionCreateSchema>, requesterId: string) {
    const site = await prisma.vaccinationSite.findUnique({ where: { id: data.siteId } });
    if (!site) throw new AppError('接种点不存在', 404);

    if (data.vehicleId) {
      const vaccineIds = data.items.map((i) => i.vaccineId);
      const validation = await this.validateVehicleTemperature(data.vehicleId, vaccineIds);
      if (!validation.valid) {
        const suggestions = validation.mismatchVaccines
          ? validation.mismatchVaccines.map((v) => `${v.name}需要${this.translateZone(v.requiredZone)}车辆`).join('，')
          : '车辆不存在';
        throw new AppError(`运输车辆温区不匹配：${suggestions}。请调整车辆或选择适配温区的疫苗`, 400);
      }
    }

    return await prisma.$transaction(async (tx) => {
      const requisitionNo = `REQ${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const itemsWithRecommendation: Record<string, { recommended: number; reason: string }> = {};

      for (const item of data.items) {
        const rec = await this.calculateRecommendedQty(data.siteId, item.vaccineId, item.requestedQty);
        itemsWithRecommendation[item.vaccineId] = { recommended: rec.recommended, reason: rec.reason };
      }

      const requisition = await tx.vaccineRequisition.create({
        data: {
          requisitionNo,
          siteId: data.siteId,
          requestedBy: requesterId,
          status: 'PENDING',
          recommendedQty: itemsWithRecommendation,
          vehicleId: data.vehicleId,
          items: {
            create: data.items.map((item) => ({
              vaccineId: item.vaccineId,
              requestedQty: item.requestedQty,
              recommendedQty: itemsWithRecommendation[item.vaccineId].recommended,
            })),
          },
        },
        include: {
          items: { include: { vaccine: true } },
          site: true,
        },
      });

      wsService.sendStatusChange('requisition', requisition.id, 'CREATED', {
        requisitionNo,
        siteName: site.name,
        itemCount: requisition.items.length,
      });

      await notificationService.notifyCDC(
        NotificationType.VACCINE_ARRIVED,
        '新疫苗申领请求',
        `接种点 ${site.name} 提交疫苗申领，共 ${requisition.items.length} 项疫苗`,
        { requisitionId: requisition.id, siteName: site.name, requisitionNo }
      );

      return requisition;
    });
  }

  async approveRequisition(requisitionId: string, data: z.infer<typeof requisitionApproveSchema>, approverId: string) {
    const requisition = await prisma.vaccineRequisition.findUnique({
      where: { id: requisitionId },
      include: { items: { include: { vaccine: true } }, site: true },
    });
    if (!requisition) throw new AppError('申领单不存在', 404);
    if (requisition.status !== 'PENDING') throw new AppError('申领单状态不允许审批', 400);

    const vaccineIds = requisition.items.map((i) => i.vaccineId);
    const vehicleValidation = await this.validateVehicleTemperature(data.vehicleId, vaccineIds);
    if (!vehicleValidation.valid) {
      const suggestions = vehicleValidation.mismatchVaccines
        ? vehicleValidation.mismatchVaccines.map((v) => `${v.name}需要${this.translateZone(v.requiredZone)}`).join('，')
        : '车辆不存在';
      throw new AppError(`运输车辆温区校验失败：${suggestions}`, 400);
    }

    for (const item of data.items) {
      if (item.approvedQty > 0) {
        if (!item.batchId) {
          const reqItem = requisition.items.find((ri) => ri.id === item.requisitionItemId);
          throw new AppError(
            `疫苗 ${reqItem?.vaccine?.name || reqItem?.vaccineId || '未知'} 请指定要发放的批次`,
            400
          );
        }
        const batch = await prisma.vaccineBatch.findUnique({
          where: { id: item.batchId },
          include: { vaccine: true },
        });
        if (!batch) {
          throw new AppError(`批次ID ${item.batchId} 不存在`, 400);
        }
        if (batch.status === InventoryStatus.SCRAPPED || batch.status === InventoryStatus.EXPIRED) {
          throw new AppError(`批次 ${batch.batchNumber}（${batch.vaccine.name}）状态为${batch.status}，不可发放`, 400);
        }
        if (batch.availableQuantity < item.approvedQty) {
          throw new AppError(
            `批次 ${batch.batchNumber}（${batch.vaccine.name}）可用库存不足，当前可用${batch.availableQuantity}剂，申请发放${item.approvedQty}剂`,
            400
          );
        }
      }
    }

    return await prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.create({
        data: {
          deliveryNo: `DEL${Date.now()}${Math.floor(Math.random() * 1000)}`,
          vehicleId: data.vehicleId,
          status: 'PENDING',
          origin: '中心冷库',
          destination: requisition.site.name,
        },
      });

      for (const item of data.items) {
        await tx.requisitionItem.update({
          where: { id: item.requisitionItemId },
          data: { approvedQty: item.approvedQty, deliveredQty: 0 },
        });

        if (item.approvedQty > 0 && item.batchId) {
          const updateResult = await tx.vaccineBatch.updateMany({
            where: {
              id: item.batchId,
              availableQuantity: { gte: item.approvedQty },
            },
            data: {
              availableQuantity: { decrement: item.approvedQty },
              status: InventoryStatus.IN_TRANSIT,
            },
          });

          if (updateResult.count === 0) {
            const batch = await tx.vaccineBatch.findUnique({ where: { id: item.batchId }, include: { vaccine: true } });
            throw new AppError(
              `批次 ${batch?.batchNumber || item.batchId} 库存并发更新失败，当前可用${batch?.availableQuantity ?? 0}剂，请重试`,
              409
            );
          }

          await tx.inventoryLog.create({
            data: {
              batchId: item.batchId,
              action: 'ALLOCATED_TO_DELIVERY',
              quantity: item.approvedQty,
              location: delivery.deliveryNo,
              operatorId: approverId,
              reason: `申领单${requisition.requisitionNo}审批通过，转配送中`,
            },
          });
        }
      }

      const updated = await tx.vaccineRequisition.update({
        where: { id: requisitionId },
        data: { status: 'APPROVED', approvedBy: approverId, vehicleId: data.vehicleId, deliveryId: delivery.id },
        include: {
          items: { include: { vaccine: true } },
          site: true,
          delivery: true,
          approver: { select: { id: true, name: true } },
        },
      });

      wsService.sendStatusChange('requisition', requisitionId, 'APPROVED', { requisitionNo: updated.requisitionNo, deliveryNo: delivery.deliveryNo });

      await notificationService.notifyVaccinationSite(
        updated.site.region,
        NotificationType.VACCINE_ARRIVED,
        '疫苗申领已批准',
        `您的申领单 ${updated.requisitionNo} 已批准，配送单号 ${delivery.deliveryNo}`,
        { requisitionId: updated.id, deliveryId: delivery.id }
      );

      return updated;
    });
  }

  async rejectRequisition(requisitionId: string, reason: string, operatorId: string) {
    const requisition = await prisma.vaccineRequisition.findUnique({
      where: { id: requisitionId },
      include: { site: true },
    });
    if (!requisition) throw new AppError('申领单不存在', 404);

    const updated = await prisma.vaccineRequisition.update({
      where: { id: requisitionId },
      data: { status: 'REJECTED', rejectionReason: reason },
    });

    wsService.sendStatusChange('requisition', requisitionId, 'REJECTED', { requisitionNo: requisition.requisitionNo, reason });

    await notificationService.notifyVaccinationSite(
      requisition.site.region,
      NotificationType.VACCINE_ARRIVED,
      '疫苗申领被拒绝',
      `申领单 ${requisition.requisitionNo} 被拒绝：${reason}`,
      { requisitionId, reason }
    );

    return updated;
  }

  async listRequisitions(status?: string, siteId?: string, page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;
    const where: any = {};
    if (status) where.status = status;
    if (siteId) where.siteId = siteId;

    const [records, total] = await Promise.all([
      prisma.vaccineRequisition.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          items: { include: { vaccine: true } },
          site: true,
          vehicle: true,
          delivery: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.vaccineRequisition.count({ where }),
    ]);
    return { records, total, page, pageSize };
  }

  private translateZone(zone: TemperatureZone): string {
    const map: Record<TemperatureZone, string> = {
      ULTRA_LOW: '超低温',
      REFRIGERATED: '冷藏',
      FROZEN: '冷冻',
      ROOM_TEMP: '常温',
    };
    return map[zone];
  }
}

export const requisitionService = new RequisitionService();
