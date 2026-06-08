import { prisma } from '../config/database';
import { AppError } from '../utils/response';
import {
  EmergencyOrderType,
  EmergencyOrderStatus,
  NotificationType,
  TemperatureAlertEventStatus,
} from '@prisma/client';
import { notificationService } from './notification.service';
import { wsService } from './websocket.service';
import { z } from 'zod';
import { differenceInMinutes } from 'date-fns';

export const temperatureLogSchema = z.object({
  deliveryId: z.string(),
  temperature: z.number(),
  equipmentId: z.string().optional(),
  batchId: z.string().optional(),
});

export const emergencyOrderSchema = z.object({
  deliveryId: z.string(),
  type: z.enum(['SUSPEND_USE', 'RETURN_SHIPMENT', 'RECALL']),
  reason: z.string(),
  batchId: z.string().optional(),
});

class DeliveryService {
  async checkTemperatureAlert(deliveryId: string, temperature: number): Promise<{ isAlert: boolean; threshold?: { min: number; max: number }; alertType?: string }> {
    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        vehicle: true,
        requisition: { include: { items: { include: { vaccine: true } } } },
      },
    });
    if (!delivery) return { isAlert: false };

    const vehicle = delivery.vehicle;
    if (temperature < vehicle.minTemperature || temperature > vehicle.maxTemperature) {
      const alertType = temperature < vehicle.minTemperature ? 'LOW_TEMPERATURE' : 'HIGH_TEMPERATURE';
      return {
        isAlert: true,
        threshold: { min: vehicle.minTemperature, max: vehicle.maxTemperature },
        alertType,
      };
    }

    return { isAlert: false };
  }

  async logTemperature(data: z.infer<typeof temperatureLogSchema>) {
    const delivery = await prisma.delivery.findUnique({
      where: { id: data.deliveryId },
      include: { vehicle: true },
    });
    if (!delivery) throw new AppError('配送记录不存在', 404);

    const alertCheck = await this.checkTemperatureAlert(data.deliveryId, data.temperature);

    const log = await prisma.temperatureLog.create({
      data: {
        temperature: data.temperature,
        deliveryId: data.deliveryId,
        equipmentId: data.equipmentId,
        batchId: data.batchId,
        isAlert: alertCheck.isAlert,
        alertType: alertCheck.alertType,
      },
    });

    let alertEvent: any = null;

    if (alertCheck.isAlert) {
      alertEvent = await this.handleTemperatureAlert(
        delivery.id,
        data.temperature,
        alertCheck.alertType!,
        alertCheck.threshold!,
        log.id,
        data.batchId
      );
    } else {
      await this.resolveOngoingAlertEventIfNeeded(delivery.id, log.id);
    }

    return { log, alertCheck, alertEvent };
  }

  private async resolveOngoingAlertEventIfNeeded(deliveryId: string, logId: string) {
    const activeEvent = await prisma.temperatureAlertEvent.findFirst({
      where: { deliveryId, status: TemperatureAlertEventStatus.ACTIVE },
      orderBy: { firstAlertAt: 'desc' },
    });
    if (!activeEvent) return;

    const resolvedAt = new Date();
    const recoveredAt = resolvedAt;
    const log = await prisma.temperatureLog.findUnique({ where: { id: logId } });
    const recoveredTemperature = log?.temperature;
    const durationMinutes = Math.max(0, differenceInMinutes(resolvedAt, activeEvent.firstAlertAt));

    await prisma.temperatureAlertEvent.update({
      where: { id: activeEvent.id },
      data: {
        status: TemperatureAlertEventStatus.RESOLVED,
        resolvedAt,
        recoveredAt,
        recoveredTemperature,
        durationMinutes,
        lastAlertAt: resolvedAt,
        temperatureLogs: { connect: { id: logId } },
      },
    });

    wsService.sendStatusChange('temperature_alert_event', activeEvent.id, 'RESOLVED', {
      eventNo: activeEvent.eventNo,
      deliveryId,
      resolvedAt,
      recoveredAt,
      recoveredTemperature,
      durationMinutes,
    });

    if (activeEvent.emergencyOrderId) {
      await notificationService.notifyCDC(
        NotificationType.TEMPERATURE_ALERT,
        '冷链运输温度已恢复正常',
        `配送${deliveryId}温度恢复${recoveredTemperature ?? '未知'}°C，异常持续${durationMinutes}分钟，事件号${activeEvent.eventNo}`,
        { deliveryId, eventId: activeEvent.id, eventNo: activeEvent.eventNo, durationMinutes, recoveredTemperature }
      );
    }
  }

  async handleTemperatureAlert(
    deliveryId: string,
    temperature: number,
    alertType: string,
    threshold: { min: number; max: number },
    logId: string,
    batchId?: string
  ) {
    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        vehicle: true,
        requisition: { include: { site: true, items: { include: { vaccine: true } } } },
      },
    });
    if (!delivery) return null;

    const now = new Date();
    const newAffectedBatchIds = batchId
      ? [batchId]
      : delivery.requisition?.items.filter((i) => i.batchId).map((i) => i.batchId as string) || [];

    let existingActiveEvent = await prisma.temperatureAlertEvent.findFirst({
      where: {
        deliveryId,
        alertType,
        status: TemperatureAlertEventStatus.ACTIVE,
      },
      orderBy: { firstAlertAt: 'desc' },
    });

    let event: any;

    if (existingActiveEvent) {
      const existingBatchIds: string[] = Array.isArray((existingActiveEvent as any).affectedBatchIds)
        ? (existingActiveEvent as any).affectedBatchIds
        : [];
      const mergedBatchIds = Array.from(new Set([...existingBatchIds, ...newAffectedBatchIds]));
      const durationMinutes = Math.max(0, differenceInMinutes(now, existingActiveEvent.firstAlertAt));

      event = await prisma.temperatureAlertEvent.update({
        where: { id: existingActiveEvent.id },
        data: {
          minTemperature: Math.min(existingActiveEvent.minTemperature, temperature),
          maxTemperature: Math.max(existingActiveEvent.maxTemperature, temperature),
          lastAlertAt: now,
          durationMinutes,
          logCount: { increment: 1 },
          affectedBatchIds: mergedBatchIds as any,
          temperatureLogs: { connect: { id: logId } },
        },
        include: { emergencyOrder: true },
      });

      wsService.sendStatusChange('temperature_alert_event', event.id, 'UPDATED', {
        eventNo: event.eventNo,
        deliveryId,
        temperature,
        minTemperature: event.minTemperature,
        maxTemperature: event.maxTemperature,
        durationMinutes,
        logCount: event.logCount,
        affectedBatchIds: mergedBatchIds,
      });
    } else {
      const eventNo = `TAE${Date.now()}${Math.floor(Math.random() * 1000)}`;

      const autoOperator = await prisma.user.findFirst({
        where: { role: 'CDC_ADMIN' },
        select: { id: true },
      });
      if (!autoOperator) throw new AppError('系统中未配置CDC管理员，无法自动生成应急工单', 500);

      const order = await this.createEmergencyOrder(
        {
          deliveryId,
          type: alertType === 'LOW_TEMPERATURE' || alertType === 'HIGH_TEMPERATURE'
            ? EmergencyOrderType.SUSPEND_USE
            : EmergencyOrderType.RETURN_SHIPMENT,
          reason: `温度异常：当前${temperature}°C，阈值范围${threshold.min}°C~${threshold.max}°C`,
          batchId: undefined,
        },
        autoOperator.id
      );

      event = await prisma.temperatureAlertEvent.create({
        data: {
          eventNo,
          deliveryId,
          alertType,
          minTemperature: temperature,
          maxTemperature: temperature,
          firstAlertAt: now,
          lastAlertAt: now,
          durationMinutes: 0,
          logCount: 1,
          affectedBatchIds: newAffectedBatchIds as any,
          status: TemperatureAlertEventStatus.ACTIVE,
          emergencyOrderId: (order as { id: string }).id,
          temperatureLogs: { connect: { id: logId } },
        },
        include: { emergencyOrder: true },
      });

      wsService.sendStatusChange('delivery', deliveryId, 'TEMPERATURE_ALERT', {
        temperature,
        threshold,
        alertType,
        eventNo,
        emergencyOrderNo: (order as { orderNo: string }).orderNo,
      });

      wsService.sendStatusChange('temperature_alert_event', event.id, 'CREATED', {
        eventNo,
        deliveryId,
        temperature,
        threshold,
        alertType,
        emergencyOrderNo: (order as { orderNo: string }).orderNo,
      });

      if (delivery.requisition?.site.region) {
        await notificationService.notifyVaccinationSite(
          delivery.requisition.site.region,
          NotificationType.TEMPERATURE_ALERT,
          '冷链运输温度告警',
          `配送${delivery.deliveryNo}温度异常，事件号${eventNo}，当前${temperature}°C，已暂停使用并生成应急工单`,
          { deliveryId, temperature, threshold, eventId: event.id, eventNo, emergencyOrderNo: (order as { orderNo: string }).orderNo }
        );
      }

      await notificationService.notifyCDC(
        NotificationType.TEMPERATURE_ALERT,
        '冷链运输温度告警',
        `配送${delivery.deliveryNo}温度异常：${temperature}°C（阈值${threshold.min}~${threshold.max}），事件号${eventNo}`,
        { deliveryId, temperature, threshold, eventId: event.id, eventNo, emergencyOrderNo: (order as { orderNo: string }).orderNo }
      );
    }

    return event;
  }

  async getDeliveryAlertEvents(deliveryId: string) {
    const events = await prisma.temperatureAlertEvent.findMany({
      where: { deliveryId },
      include: {
        delivery: { include: { vehicle: true, requisition: { include: { site: true } } } },
        emergencyOrder: true,
        temperatureLogs: { orderBy: { timestamp: 'asc' } },
        handler: { select: { id: true, name: true } },
      },
      orderBy: { firstAlertAt: 'desc' },
    });
    return events.map((e) => ({
      id: e.id,
      eventNo: e.eventNo,
      alertType: e.alertType,
      minTemperature: e.minTemperature,
      maxTemperature: e.maxTemperature,
      firstAlertAt: e.firstAlertAt,
      lastAlertAt: e.lastAlertAt,
      resolvedAt: e.resolvedAt,
      recoveredAt: e.recoveredAt,
      recoveredTemperature: e.recoveredTemperature,
      durationMinutes: e.resolvedAt
        ? Math.max(0, differenceInMinutes(e.resolvedAt, e.firstAlertAt))
        : e.durationMinutes,
      logCount: e.logCount,
      affectedBatchIds: e.affectedBatchIds,
      status: e.status,
      handlingStatus: e.handlingStatus,
      remark: e.remark,
      handlingRemark: e.handlingRemark,
      handledAt: e.handledAt,
      handledBy: e.handler,
      emergencyOrder: e.emergencyOrder
        ? { id: e.emergencyOrder.id, orderNo: e.emergencyOrder.orderNo, type: e.emergencyOrder.type, status: e.emergencyOrder.status }
        : null,
      delivery: e.delivery
        ? { id: e.delivery.id, deliveryNo: e.delivery.deliveryNo, plateNumber: e.delivery.vehicle.plateNumber, siteName: e.delivery.requisition?.site.name }
        : null,
      alertLogsCount: e.temperatureLogs.length,
    }));
  }

  async listAlertEvents(status?: string, page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;
    const where: any = {};
    if (status) where.status = status;

    const [records, total] = await Promise.all([
      prisma.temperatureAlertEvent.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          delivery: { include: { vehicle: true, requisition: { include: { site: true } } } },
          emergencyOrder: true,
        },
        orderBy: { firstAlertAt: 'desc' },
      }),
      prisma.temperatureAlertEvent.count({ where }),
    ]);

    return { records, total, page, pageSize };
  }

  async updateAlertEventHandlingStatus(
    eventId: string,
    handlingStatus: string,
    operatorId: string,
    remark?: string
  ) {
    const event = await prisma.temperatureAlertEvent.findUnique({
      where: { id: eventId },
      include: { handler: { select: { id: true, name: true } } },
    });
    if (!event) throw new AppError('温度异常事件不存在', 404);

    const deliveryInfo = await prisma.delivery.findUnique({
      where: { id: event.deliveryId },
      include: { requisition: { include: { site: true } } },
    });

    const now = new Date();
    const data: any = { handlingStatus, handledBy: operatorId, handledAt: now };
    if (remark !== undefined) data.handlingRemark = remark;

    const updated = await prisma.temperatureAlertEvent.update({
      where: { id: eventId },
      data,
      include: {
        emergencyOrder: true,
        handler: { select: { id: true, name: true } },
      },
    });

    wsService.sendStatusChange('temperature_alert_event', eventId, handlingStatus, {
      eventNo: event.eventNo,
      handlingStatus,
      handledBy: operatorId,
      handledAt: now,
      handlingRemark: remark,
    });

    if (deliveryInfo?.requisition?.site.region) {
      await notificationService.notifyVaccinationSite(
        deliveryInfo.requisition.site.region,
        NotificationType.EMERGENCY_ALERT,
        `温度异常事件处理状态更新：${handlingStatus}`,
        `事件号${event.eventNo}处理状态已更新为${handlingStatus}${remark ? `，处理说明：${remark}` : ''}`,
        { eventId, eventNo: event.eventNo, handlingStatus, handledBy: operatorId, handlingRemark: remark }
      );
    }

    return updated;
  }

  async createEmergencyOrder(data: z.infer<typeof emergencyOrderSchema>, createdBy: string) {
    const orderNo = `EMG${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const order = await prisma.emergencyOrder.create({
      data: {
        orderNo,
        type: data.type,
        deliveryId: data.deliveryId,
        batchId: data.batchId,
        reason: data.reason,
        status: EmergencyOrderStatus.CREATED,
        createdBy,
        notifiedCDC: true,
        notifiedSite: true,
      },
    });

    wsService.sendStatusChange('emergency_order', order.id, 'CREATED', {
      orderNo,
      type: data.type,
      reason: data.reason,
    });

    return order;
  }

  async updateEmergencyOrderStatus(orderId: string, status: EmergencyOrderStatus, operatorId: string) {
    const order = await prisma.emergencyOrder.findUnique({
      where: { id: orderId },
      include: { delivery: { include: { requisition: { include: { site: true } } } } },
    });
    if (!order) throw new AppError('应急工单不存在', 404);

    const updated = await prisma.emergencyOrder.update({
      where: { id: orderId },
      data: { status },
    });

    wsService.sendStatusChange('emergency_order', orderId, status, { orderNo: order.orderNo });

    if (order.delivery?.requisition?.site.region) {
      await notificationService.notifyVaccinationSite(
        order.delivery.requisition.site.region,
        NotificationType.EMERGENCY_ALERT,
        `应急工单状态更新：${this.translateStatus(status)}`,
        `工单${order.orderNo}状态已更新为${this.translateStatus(status)}`,
        { orderId, orderNo: order.orderNo, status }
      );
    }

    return updated;
  }

  async startDelivery(deliveryId: string, driverId: string) {
    const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) throw new AppError('配送不存在', 404);

    const updated = await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: 'IN_TRANSIT', driverId, departureTime: new Date() },
    });

    wsService.sendStatusChange('delivery', deliveryId, 'IN_TRANSIT', { deliveryNo: updated.deliveryNo });
    return updated;
  }

  async completeDelivery(deliveryId: string) {
    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { requisition: { include: { items: { include: { vaccine: true, batch: true } }, site: true } } },
    });
    if (!delivery || !delivery.requisition) throw new AppError('配送或关联申领不存在', 404);

    const requisition = delivery.requisition;
    const deliveryNo = delivery.deliveryNo;
    const siteRegion = requisition.site.region;

    for (const item of requisition.items) {
      if (item.approvedQty && item.approvedQty > 0 && !item.batchId) {
        throw new AppError(
          `申领明细 ${item.id}（${item.vaccine.name}）未指定发放批次，无法完成签收，请先在审批时指定批次`,
          400
        );
      }
    }

    return await prisma.$transaction(async (tx) => {
      for (const item of requisition.items) {
        if (!item.approvedQty || item.approvedQty <= 0 || !item.batchId) continue;

        const batch = await tx.vaccineBatch.findUnique({
          where: { id: item.batchId },
          include: { vaccine: true },
        });
        if (!batch) {
          throw new AppError(
            `批次 ${item.batchId}（${item.vaccine.name}）不存在，无法完成签收`,
            404
          );
        }
        if (batch.status !== 'IN_TRANSIT') {
          throw new AppError(
            `批次 ${batch.batchNumber}（${batch.vaccine.name}）状态为 ${batch.status}，不是在途状态，无法签收`,
            400
          );
        }

        const existingStock = await tx.inventoryStock.findFirst({
          where: { siteId: requisition.siteId, batchId: item.batchId },
        });

        if (existingStock) {
          await tx.inventoryStock.update({
            where: { id: existingStock.id },
            data: { quantity: { increment: item.approvedQty }, status: 'NORMAL', lastUpdated: new Date() },
          });
        } else {
          await tx.inventoryStock.create({
            data: {
              siteId: requisition.siteId,
              batchId: item.batchId,
              quantity: item.approvedQty,
              status: 'NORMAL',
            },
          });
        }

        await tx.vaccineBatch.update({
          where: { id: item.batchId },
          data: { status: 'NORMAL' },
        });

        await tx.requisitionItem.update({
          where: { id: item.id },
          data: { deliveredQty: item.approvedQty },
        });
      }

      const updated = await tx.delivery.update({
        where: { id: deliveryId },
        data: { status: 'DELIVERED', arrivalTime: new Date() },
      });

      wsService.sendStatusChange('delivery', deliveryId, 'DELIVERED', { deliveryNo: updated.deliveryNo });

      await notificationService.notifyVaccinationSite(
        siteRegion,
        NotificationType.VACCINE_ARRIVED,
        '疫苗已送达',
        `配送${deliveryNo}已到达，请签收确认`,
        { deliveryId, deliveryNo }
      );

      return updated;
    });
  }

  async listDeliveries(status?: string, page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;
    const where: any = {};
    if (status) where.status = status;

    const [records, total] = await Promise.all([
      prisma.delivery.findMany({
        where,
        skip,
        take: pageSize,
        include: { vehicle: true, driver: { select: { id: true, name: true } }, requisition: { include: { site: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.delivery.count({ where }),
    ]);
    return { records, total, page, pageSize };
  }

  private translateStatus(status: EmergencyOrderStatus): string {
    const map: Record<EmergencyOrderStatus, string> = {
      CREATED: '已创建',
      IN_PROGRESS: '处理中',
      COMPLETED: '已完成',
      CANCELLED: '已取消',
    };
    return map[status];
  }
}

export const deliveryService = new DeliveryService();
