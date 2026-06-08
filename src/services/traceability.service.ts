import { prisma } from '../config/database';
import { AppError } from '../utils/response';

interface TraceEvent {
  timestamp: Date;
  eventType:
    | 'INCOMING'
    | 'EQUIPMENT_INSPECTION'
    | 'STORAGE_ASSIGNED'
    | 'REQUISITION_APPROVED'
    | 'DELIVERY_STARTED'
    | 'TEMPERATURE_LOG'
    | 'TEMPERATURE_ALERT'
    | 'DELIVERY_COMPLETED'
    | 'SITE_RECEIVED'
    | 'VACCINATION'
    | 'SCRAPPED';
  description: string;
  operator?: { id: string; name: string };
  location?: string;
  details?: any;
  eventRef?: { type: string; id: string; no?: string };
}

class TraceabilityService {
  async getBatchTraceability(batchNumber?: string, batchId?: string) {
    const whereBatch: any = {};
    if (batchNumber) whereBatch.batchNumber = batchNumber;
    else if (batchId) whereBatch.id = batchId;
    else throw new AppError('请提供批次号或批次ID', 400);

    const batch = await prisma.vaccineBatch.findUnique({
      where: whereBatch,
      include: {
        vaccine: true,
        storageSlot: { include: { coldStorage: true } },
        incomingRecords: { include: { receiver: { select: { id: true, name: true } } } },
        siteStock: { include: { site: true } },
        vaccinations: {
          include: {
            site: true,
            administrator: { select: { id: true, name: true } },
            child: { select: { id: true, name: true } },
          },
        },
        scrappedRecords: { include: { scrappedByUser: { select: { id: true, name: true } } } },
        temperatureLogs: {
          include: { equipment: true },
          orderBy: { timestamp: 'asc' },
        },
        emergencyOrders: {
          include: { delivery: true },
          orderBy: { createdAt: 'asc' },
        },
        inventoryLogs: {
          include: { operator: { select: { id: true, name: true } } },
          orderBy: { timestamp: 'asc' },
        },
      },
    });
    if (!batch) throw new AppError('疫苗批次不存在', 404);

    const events: TraceEvent[] = [];

    for (const incoming of batch.incomingRecords) {
      events.push({
        timestamp: incoming.receivedDate,
        eventType: 'INCOMING',
        description: `疫苗批签发入库：${incoming.quantity}剂，批签发号 ${incoming.batchApprovalNo}，检验结果：${incoming.inspectionResult}`,
        operator: incoming.receiver,
        location: batch.storageSlot?.coldStorage?.name,
        details: {
          quantity: incoming.quantity,
          batchApprovalNo: incoming.batchApprovalNo,
          inspectionResult: incoming.inspectionResult,
          equipmentData: incoming.equipmentData,
          remarks: incoming.remarks,
        },
        eventRef: { type: 'INCOMING_RECORD', id: incoming.id },
      });
    }

    if (batch.storageSlot?.coldStorage) {
      const storageId = batch.storageSlot.coldStorage.id;
      const inspections = await prisma.equipmentInspection.findMany({
        where: {
          equipment: { coldStorageId: storageId },
          inspectionDate: {
            gte: batch.createdAt,
            lte: new Date(batch.createdAt.getTime() + 24 * 3600 * 1000),
          },
        },
        include: { inspector: { select: { id: true, name: true } }, equipment: true },
        orderBy: { inspectionDate: 'asc' },
      });

      for (const ins of inspections) {
        events.push({
          timestamp: ins.inspectionDate,
          eventType: 'EQUIPMENT_INSPECTION',
          description: `冷链设备初检：${ins.equipment.equipmentType}（${ins.equipment.model}），温度 ${ins.temperature}°C，湿度 ${ins.humidity ?? '-'}%，结果：${ins.result}`,
          operator: ins.inspector,
          location: batch.storageSlot?.coldStorage?.name,
          details: {
            equipmentId: ins.equipment.id,
            equipmentType: ins.equipment.equipmentType,
            serialNumber: ins.equipment.serialNumber,
            temperature: ins.temperature,
            humidity: ins.humidity,
            result: ins.result,
            remarks: ins.remarks,
          },
          eventRef: { type: 'EQUIPMENT_INSPECTION', id: ins.id },
        });
      }

      events.push({
        timestamp: batch.createdAt,
        eventType: 'STORAGE_ASSIGNED',
        description: `库位分配：${batch.storageSlot.coldStorage.name} → ${batch.storageSlot.slotCode}（${batch.storageSlot.temperatureZone}）`,
        location: `${batch.storageSlot.coldStorage.region}/${batch.storageSlot.coldStorage.name}`,
        details: {
          coldStorageId: batch.storageSlot.coldStorage.id,
          coldStorageName: batch.storageSlot.coldStorage.name,
          slotId: batch.storageSlot.id,
          slotCode: batch.storageSlot.slotCode,
          temperatureZone: batch.storageSlot.temperatureZone,
          threshold: { min: batch.minTemperature, max: batch.maxTemperature },
        },
      });
    }

    const requisitionItems = await prisma.requisitionItem.findMany({
      where: { batchId: batch.id },
      include: {
        requisition: {
          include: {
            site: true,
            delivery: {
              include: {
                vehicle: true,
                driver: { select: { id: true, name: true } },
                temperatureLogs: { orderBy: { timestamp: 'asc' } },
              },
            },
            approver: { select: { id: true, name: true } },
          },
        },
        vaccine: true,
      },
    });

    for (const item of requisitionItems) {
      const req = item.requisition;

      if (req.status === 'APPROVED' && req.approver) {
        events.push({
          timestamp: req.updatedAt,
          eventType: 'REQUISITION_APPROVED',
          description: `申领审批通过：申领单 ${req.requisitionNo}，发放 ${item.approvedQty ?? 0}剂 → ${req.site.name}（审批人：${req.approver.name}）`,
          operator: req.approver,
          location: req.site.name,
          details: {
            requisitionNo: req.requisitionNo,
            requisitionId: req.id,
            requestedQty: item.requestedQty,
            approvedQty: item.approvedQty,
            siteId: req.siteId,
            siteName: req.site.name,
            vehicleId: req.vehicleId,
          },
          eventRef: { type: 'REQUISITION', id: req.id, no: req.requisitionNo },
        });
      }

      if (req.delivery) {
        const del = req.delivery;
        if (del.departureTime && del.driver) {
          events.push({
            timestamp: del.departureTime,
            eventType: 'DELIVERY_STARTED',
            description: `配送启动：单号 ${del.deliveryNo}，车辆 ${del.vehicle.plateNumber}，司机 ${del.driver.name}，从中心冷库发往 ${req.site.name}`,
            operator: del.driver,
            location: `中心冷库 → ${req.site.name}`,
            details: {
              deliveryNo: del.deliveryNo,
              deliveryId: del.id,
              vehicleId: del.vehicleId,
              plateNumber: del.vehicle.plateNumber,
              driverId: del.driverId,
              threshold: { min: del.vehicle.minTemperature, max: del.vehicle.maxTemperature },
            },
            eventRef: { type: 'DELIVERY', id: del.id, no: del.deliveryNo },
          });
        }

        const alertEvents = await prisma.temperatureAlertEvent.findMany({
          where: { deliveryId: del.id },
          include: { emergencyOrder: true },
          orderBy: { firstAlertAt: 'asc' },
        });

        for (const ae of alertEvents) {
          events.push({
            timestamp: ae.firstAlertAt,
            eventType: 'TEMPERATURE_ALERT',
            description: `运输温度异常事件（${ae.eventNo}）：${ae.alertType}，最低 ${ae.minTemperature}°C / 最高 ${ae.maxTemperature}°C，持续 ${ae.durationMinutes} 分钟，状态：${ae.status}/${ae.handlingStatus}${ae.resolvedAt ? '，已恢复' : ''}`,
            details: {
              eventId: ae.id,
              eventNo: ae.eventNo,
              alertType: ae.alertType,
              minTemperature: ae.minTemperature,
              maxTemperature: ae.maxTemperature,
              firstAlertAt: ae.firstAlertAt,
              lastAlertAt: ae.lastAlertAt,
              resolvedAt: ae.resolvedAt,
              recoveredAt: ae.recoveredAt,
              recoveredTemperature: ae.recoveredTemperature,
              durationMinutes: ae.durationMinutes,
              logCount: ae.logCount,
              affectedBatchIds: ae.affectedBatchIds,
              status: ae.status,
              handlingStatus: ae.handlingStatus,
              handlingRemark: ae.handlingRemark,
              emergencyOrder: ae.emergencyOrder
                ? { id: ae.emergencyOrder.id, orderNo: ae.emergencyOrder.orderNo, type: ae.emergencyOrder.type, status: ae.emergencyOrder.status }
                : null,
            },
            eventRef: { type: 'TEMPERATURE_ALERT_EVENT', id: ae.id, no: ae.eventNo },
          });
        }

        const normalLogs = del.temperatureLogs.filter((t) => !t.isAlert);
        for (const tlog of normalLogs) {
          events.push({
            timestamp: tlog.timestamp,
            eventType: 'TEMPERATURE_LOG',
            description: `运输温度记录：${tlog.temperature}°C`,
            details: {
              deliveryId: del.id,
              temperature: tlog.temperature,
              isAlert: false,
              equipmentId: tlog.equipmentId,
            },
          });
        }

        if (del.arrivalTime) {
          events.push({
            timestamp: del.arrivalTime,
            eventType: 'DELIVERY_COMPLETED',
            description: `配送完成：单号 ${del.deliveryNo}，已送达 ${req.site.name}`,
            location: req.site.name,
            details: { deliveryNo: del.deliveryNo, arrivalTime: del.arrivalTime },
            eventRef: { type: 'DELIVERY', id: del.id, no: del.deliveryNo },
          });

          events.push({
            timestamp: del.arrivalTime,
            eventType: 'SITE_RECEIVED',
            description: `接种点入库：${req.site.name} 收到 ${item.approvedQty ?? 0}剂 ${batch.vaccine.name}（批次 ${batch.batchNumber}，审批单号 ${req.requisitionNo}）`,
            location: req.site.name,
            details: {
              siteId: req.siteId,
              siteName: req.site.name,
              quantity: item.approvedQty ?? item.deliveredQty ?? 0,
              batchId: batch.id,
              batchNumber: batch.batchNumber,
              requisitionNo: req.requisitionNo,
              deliveryNo: del.deliveryNo,
            },
          });
        }
      }
    }

    for (const vacc of batch.vaccinations) {
      events.push({
        timestamp: vacc.administrationDate,
        eventType: 'VACCINATION',
        description: `接种使用：${vacc.site.name}，接种人 ${vacc.administrator.name}，受种者 ${vacc.child.name}，第 ${vacc.doseNumber} 剂，接种证号 ${vacc.certificateNo}`,
        operator: vacc.administrator,
        location: vacc.site.name,
        details: {
          certificateNo: vacc.certificateNo,
          childId: vacc.childId,
          childName: vacc.child.name,
          doseNumber: vacc.doseNumber,
          siteId: vacc.siteId,
          nextVaccinationDate: vacc.nextVaccinationDate,
          appointmentId: vacc.appointmentId,
        },
        eventRef: { type: 'VACCINATION_RECORD', id: vacc.id, no: vacc.certificateNo },
      });
    }

    for (const scrap of batch.scrappedRecords) {
      events.push({
        timestamp: scrap.scrapDate,
        eventType: 'SCRAPPED',
        description: `报废处理：${scrap.quantity}剂，原因：${scrap.reason}，处理方式：${scrap.disposalMethod ?? '-'}`,
        operator: scrap.scrappedByUser,
        details: {
          scrapNo: scrap.scrapNo,
          quantity: scrap.quantity,
          reason: scrap.reason,
          witness: scrap.witness,
          disposalMethod: scrap.disposalMethod,
        },
        eventRef: { type: 'SCRAPPED_RECORD', id: scrap.id, no: scrap.scrapNo },
      });
    }

    events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return {
      batch: {
        id: batch.id,
        batchNumber: batch.batchNumber,
        vaccineId: batch.vaccineId,
        vaccineName: batch.vaccine.name,
        manufactureDate: batch.manufactureDate,
        expiryDate: batch.expiryDate,
        totalQuantity: batch.totalQuantity,
        availableQuantity: batch.availableQuantity,
        status: batch.status,
        temperatureZone: batch.temperatureZone,
        threshold: { min: batch.minTemperature, max: batch.maxTemperature },
        lotApprovalNumber: batch.lotApprovalNumber,
        issuer: batch.issuer,
        storage: batch.storageSlot
          ? {
              coldStorage: batch.storageSlot.coldStorage?.name,
              region: batch.storageSlot.coldStorage?.region,
              slotCode: batch.storageSlot.slotCode,
            }
          : null,
      },
      totalEvents: events.length,
      timeline: events,
    };
  }

  async getTraceabilityByCertificate(certificateNo: string) {
    const record = await prisma.vaccinationRecord.findUnique({
      where: { certificateNo },
      include: {
        child: { select: { id: true, name: true, birthDate: true, gender: true } },
        site: true,
        vaccine: true,
        batch: true,
        administrator: { select: { id: true, name: true } },
        appointment: true,
        adverseReaction: true,
      },
    });
    if (!record) throw new AppError('电子接种证不存在', 404);

    const batchTrace = await this.getBatchTraceability(undefined, record.batchId);

    const requisitionItem = await prisma.requisitionItem.findFirst({
      where: {
        batchId: record.batchId,
        requisition: { siteId: record.siteId, status: { in: ['APPROVED', 'DELIVERED'] } },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        requisition: {
          include: {
            site: true,
            approver: { select: { id: true, name: true } },
            delivery: {
              include: {
                vehicle: true,
                driver: { select: { id: true, name: true } },
                temperatureAlertEvents: {
                  include: { emergencyOrder: true, handler: { select: { id: true, name: true } } },
                  orderBy: { firstAlertAt: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    const allAlertEvents = requisitionItem?.requisition?.delivery?.temperatureAlertEvents ?? [];

    const affectingAlertEvents = allAlertEvents.filter((e) => {
      const affected = e.affectedBatchIds as unknown as string[] | null | undefined;
      if (!affected || affected.length === 0) return true;
      return affected.includes(record.batchId);
    });

    const hasActiveAlert = affectingAlertEvents.some((e) => e.status === 'ACTIVE');
    const hasAnyAlert = affectingAlertEvents.length > 0;
    const latestClosedHandling = affectingAlertEvents.find((e) => e.handlingStatus === 'CLOSED' || e.handlingStatus === 'ACTION_TAKEN');
    const emergencyOrders = affectingAlertEvents
      .filter((e) => !!e.emergencyOrder)
      .map((e) => e.emergencyOrder) as any[];
    const allowUse = !hasActiveAlert;
    const temperatureSafetyStatus: 'SAFE' | 'RECOVERED' | 'PENDING_REVIEW' | 'RISK_ACTIVE' =
      !hasAnyAlert ? 'SAFE' :
      hasActiveAlert ? 'RISK_ACTIVE' :
      latestClosedHandling ? 'RECOVERED' : 'PENDING_REVIEW';

    const otherBatchAlerts = allAlertEvents.length - affectingAlertEvents.length;

    return {
      certificate: {
        certificateNo: record.certificateNo,
        administrationDate: record.administrationDate,
        doseNumber: record.doseNumber,
        nextVaccinationDate: record.nextVaccinationDate,
        child: record.child,
        site: { id: record.siteId, name: record.site.name, region: record.site.region },
        vaccine: { id: record.vaccineId, name: record.vaccine.name },
        administrator: record.administrator,
        siteReaction: record.siteReaction,
        systemicReaction: record.systemicReaction,
        remarks: record.remarks,
      },
      batch: batchTrace.batch,
      delivery: requisitionItem?.requisition?.delivery
        ? {
            deliveryNo: requisitionItem.requisition.delivery.deliveryNo,
            departureTime: requisitionItem.requisition.delivery.departureTime,
            arrivalTime: requisitionItem.requisition.delivery.arrivalTime,
            status: requisitionItem.requisition.delivery.status,
            vehicle: requisitionItem.requisition.delivery.vehicle
              ? {
                  id: requisitionItem.requisition.delivery.vehicle.id,
                  plateNumber: requisitionItem.requisition.delivery.vehicle.plateNumber,
                  temperatureRange: {
                    min: requisitionItem.requisition.delivery.vehicle.minTemperature,
                    max: requisitionItem.requisition.delivery.vehicle.maxTemperature,
                  },
                }
              : null,
            driver: requisitionItem.requisition.delivery.driver,
            requisition: {
              requisitionNo: requisitionItem.requisition.requisitionNo,
              requisitionId: requisitionItem.requisition.id,
              approvedBy: requisitionItem.requisition.approver,
              approvedQty: requisitionItem.approvedQty,
              requestedQty: requisitionItem.requestedQty,
              siteName: requisitionItem.requisition.site.name,
            },
            temperatureAlertEvents: affectingAlertEvents.map((ae) => ({
              id: ae.id,
              eventNo: ae.eventNo,
              alertType: ae.alertType,
              minTemperature: ae.minTemperature,
              maxTemperature: ae.maxTemperature,
              firstAlertAt: ae.firstAlertAt,
              lastAlertAt: ae.lastAlertAt,
              resolvedAt: ae.resolvedAt,
              recoveredAt: ae.recoveredAt,
              recoveredTemperature: ae.recoveredTemperature,
              durationMinutes: ae.durationMinutes,
              logCount: ae.logCount,
              affectedBatchIds: ae.affectedBatchIds,
              status: ae.status,
              handlingStatus: ae.handlingStatus,
              handlingRemark: ae.handlingRemark,
              handledAt: ae.handledAt,
              handledBy: ae.handler,
              emergencyOrder: ae.emergencyOrder
                ? { id: ae.emergencyOrder.id, orderNo: ae.emergencyOrder.orderNo, type: ae.emergencyOrder.type, status: ae.emergencyOrder.status }
                : null,
            })),
            emergencyOrders,
          }
        : null,
      temperatureSafety: {
        status: temperatureSafetyStatus,
        hasAlert: hasAnyAlert,
        hasActiveAlert,
        recovered: !hasActiveAlert && hasAnyAlert,
        allowUse,
        otherBatchAlertsOnSameDelivery: otherBatchAlerts,
        description:
          temperatureSafetyStatus === 'SAFE'
            ? '运输过程无影响本批次的温度异常，可安全使用'
            : temperatureSafetyStatus === 'RECOVERED'
              ? '本批次曾发生温度异常，但已恢复并完成处置，可使用'
              : temperatureSafetyStatus === 'PENDING_REVIEW'
                ? '本批次曾发生温度异常，已恢复但尚未复核，建议等待审核结论'
                : '本批次当前正处于温度异常中，禁止使用',
      },
      fullTimeline: batchTrace.timeline,
      hasAdverseReaction: !!record.adverseReaction,
      adverseReaction: record.adverseReaction
        ? {
            reportNo: record.adverseReaction.reportNo,
            severity: record.adverseReaction.severity,
            status: record.adverseReaction.status,
            onsetDate: record.adverseReaction.onsetDate,
          }
        : null,
    };
  }
}

export const traceabilityService = new TraceabilityService();
