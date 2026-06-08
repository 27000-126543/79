import { prisma } from '../config/database';
import { AppError } from '../utils/response';
import { TemperatureZone, InventoryStatus } from '@prisma/client';
import { notificationService } from './notification.service';
import { wsService } from './websocket.service';
import { z } from 'zod';
import { NotificationType } from '@prisma/client';

export const incomingSchema = z.object({
  vaccineId: z.string(),
  batchNumber: z.string().min(1),
  manufactureDate: z.string().transform((d) => new Date(d)),
  expiryDate: z.string().transform((d) => new Date(d)),
  totalQuantity: z.number().min(1),
  lotApprovalNumber: z.string().optional(),
  issuer: z.string().optional(),
  minTemperature: z.number().optional(),
  maxTemperature: z.number().optional(),
  equipmentInspection: z.object({
    equipmentId: z.string(),
    temperature: z.number(),
    humidity: z.number().optional(),
    result: z.string(),
    remarks: z.string().optional(),
  }),
});

class IncomingService {
  async assignStorageSlot(temperatureZone: TemperatureZone, region?: string): Promise<{ slotId: string; coldStorageId: string; slotCode: string } | null> {
    const where: any = {
      isOccupied: false,
      temperatureZone,
      coldStorage: { status: 'ACTIVE' },
    };
    if (region) {
      where.coldStorage.region = region;
    }

    const slot = await prisma.storageSlot.findFirst({
      where,
      include: { coldStorage: true },
      orderBy: { coldStorageId: 'asc' },
    });

    if (!slot) return null;

    return {
      slotId: slot.id,
      coldStorageId: slot.coldStorageId,
      slotCode: slot.slotCode,
    };
  }

  async processIncoming(data: z.infer<typeof incomingSchema>, operatorId: string, region?: string) {
    const existingBatch = await prisma.vaccineBatch.findUnique({ where: { batchNumber: data.batchNumber } });
    if (existingBatch) {
      throw new AppError('该批次号已存在', 400);
    }

    const vaccine = await prisma.vaccineCatalog.findUnique({
      where: { id: data.vaccineId },
    });
    if (!vaccine) {
      throw new AppError('疫苗信息不存在', 404);
    }

    const minTemp = data.minTemperature ?? vaccine.minTemperature;
    const maxTemp = data.maxTemperature ?? vaccine.maxTemperature;
    const tempZone = vaccine.temperatureZone;

    const slotAssignment = await this.assignStorageSlot(tempZone, region);
    if (!slotAssignment) {
      throw new AppError(`无可用的${this.translateZone(tempZone)}库位，请检查冷库配置`, 503);
    }

    return await prisma.$transaction(async (tx) => {
      const equipment = await tx.coldChainEquipment.findUnique({
        where: { id: data.equipmentInspection.equipmentId },
      });
      if (!equipment) {
        throw new AppError('冷链设备不存在', 404);
      }

      await tx.equipmentInspection.create({
        data: {
          equipmentId: equipment.id,
          inspectorId: operatorId,
          inspectionDate: new Date(),
          temperature: data.equipmentInspection.temperature,
          humidity: data.equipmentInspection.humidity,
          result: data.equipmentInspection.result,
          remarks: data.equipmentInspection.remarks,
        },
      });

      if (data.equipmentInspection.result !== 'PASS') {
        throw new AppError(`冷链设备初检未通过: ${data.equipmentInspection.remarks || '结果不合格'}`, 400);
      }

      if (data.equipmentInspection.temperature < minTemp || data.equipmentInspection.temperature > maxTemp) {
        throw new AppError(`设备温度超出疫苗存储阈值范围（${minTemp}°C ~ ${maxTemp}°C），当前: ${data.equipmentInspection.temperature}°C`, 400);
      }

      const batch = await tx.vaccineBatch.create({
        data: {
          vaccineId: vaccine.id,
          batchNumber: data.batchNumber,
          manufactureDate: data.manufactureDate,
          expiryDate: data.expiryDate,
          totalQuantity: data.totalQuantity,
          availableQuantity: data.totalQuantity,
          minTemperature: minTemp,
          maxTemperature: maxTemp,
          temperatureZone: tempZone,
          status: InventoryStatus.NORMAL,
          lotApprovalNumber: data.lotApprovalNumber,
          issuer: data.issuer,
          storageSlotId: slotAssignment.slotId,
        },
      });

      await tx.storageSlot.update({
        where: { id: slotAssignment.slotId },
        data: { isOccupied: true, currentBatchId: batch.id },
      });

      await tx.coldStorage.update({
        where: { id: slotAssignment.coldStorageId },
        data: { usedSlots: { increment: 1 } },
      });

      await tx.incomingRecord.create({
        data: {
          batchId: batch.id,
          receivedBy: operatorId,
          receivedDate: new Date(),
          batchApprovalNo: data.lotApprovalNumber || '',
          quantity: data.totalQuantity,
          inspectionResult: data.equipmentInspection.result,
          equipmentData: {
            equipmentId: equipment.id,
            serialNumber: equipment.serialNumber,
            temperature: data.equipmentInspection.temperature,
            humidity: data.equipmentInspection.humidity,
          },
          remarks: `已分配库位: ${slotAssignment.slotCode}`,
        },
      });

      await tx.inventoryLog.create({
        data: {
          batchId: batch.id,
          action: 'INCOMING',
          quantity: data.totalQuantity,
          location: slotAssignment.slotCode,
          operatorId,
          reason: '批签发入库',
        },
      });

      await tx.temperatureLog.create({
        data: {
          temperature: data.equipmentInspection.temperature,
          equipmentId: equipment.id,
          batchId: batch.id,
          isAlert: false,
        },
      });

      wsService.sendStatusChange('vaccine_batch', batch.id, 'INCOMING', {
        batchNumber: batch.batchNumber,
        vaccineName: vaccine.name,
        slotCode: slotAssignment.slotCode,
      });

      await notificationService.notifyCDC(
        NotificationType.VACCINE_ARRIVED,
        '新疫苗批签发入库',
        `${vaccine.name}（批次: ${data.batchNumber}）已入库，库位: ${slotAssignment.slotCode}`,
        { batchId: batch.id, vaccineName: vaccine.name, batchNumber: data.batchNumber }
      );

      return {
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        vaccineName: vaccine.name,
        slotAssignment,
        temperatureThreshold: { min: minTemp, max: maxTemp, zone: tempZone },
        equipmentInspection: { passed: true, temperature: data.equipmentInspection.temperature },
      };
    });
  }

  private translateZone(zone: TemperatureZone): string {
    const map: Record<TemperatureZone, string> = {
      [TemperatureZone.ULTRA_LOW]: '超低温',
      [TemperatureZone.REFRIGERATED]: '冷藏',
      [TemperatureZone.FROZEN]: '冷冻',
      [TemperatureZone.ROOM_TEMP]: '常温',
    };
    return map[zone];
  }

  async listIncomingRecords(page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;
    const [records, total] = await Promise.all([
      prisma.incomingRecord.findMany({
        skip,
        take: pageSize,
        include: {
          batch: { include: { vaccine: true } },
          receiver: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.incomingRecord.count(),
    ]);
    return { records, total, page, pageSize };
  }
}

export const incomingService = new IncomingService();
