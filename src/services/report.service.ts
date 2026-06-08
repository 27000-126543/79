import { prisma } from '../config/database';
import { AppError } from '../utils/response';
import { NotificationType, InventoryStatus, AppointmentStatus } from '@prisma/client';
import { notificationService } from './notification.service';
import { wsService } from './websocket.service';
import { z } from 'zod';
import { startOfDay, endOfDay, subDays, format, addDays, differenceInDays } from 'date-fns';
import { createObjectCsvWriter } from 'csv-writer';
import fs from 'fs';
import path from 'path';

export const reportQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  region: z.string().optional(),
  siteId: z.string().optional(),
});

class ReportService {
  async generateDailyReport(date: Date, region?: string, siteId?: string) {
    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);

    const whereSite: any = {};
    if (region) whereSite.region = region;
    if (siteId) whereSite.id = siteId;

    const sites = await prisma.vaccinationSite.findMany({ where: whereSite, select: { id: true, region: true } });
    const siteIds = sites.map((s) => s.id);

    let regionExists = true;
    if (region) {
      const regionCount = await prisma.vaccinationSite.count({ where: { region } })
        + await prisma.coldStorage.count({ where: { region } });
      regionExists = regionCount > 0;
    }

    if ((region && !regionExists) || (siteId && siteIds.length === 0)) {
      const data = {
        totalVaccinated: 0,
        lossRate: 0,
        adverseRate: 0,
        equipmentGoodRate: region && !regionExists ? 0 : 100,
        details: {
          vaccinatedBySite: [] as any[],
          scrappedQty: 0,
          usedQty: 0,
          adverseCount: 0,
          equipmentTotal: 0,
          equipmentGood: 0,
          scopeInvalid: true,
          scopeDescription: `${siteId ? '接种点' : ''}${region ? '区域' : ''}不存在或无数据，按空范围统计`,
        },
      };

      const report = await prisma.dailyReport.upsert({
        where: {
          reportDate_region_siteId: {
            reportDate: dayStart,
            region: region || '',
            siteId: siteId || '',
          },
        },
        create: {
          reportDate: dayStart,
          region: region || null,
          siteId: siteId || null,
          totalVaccinated: 0,
          lossRate: 0,
          adverseRate: 0,
          equipmentGoodRate: 0,
          data: data as any,
        },
        update: {
          totalVaccinated: 0,
          lossRate: 0,
          adverseRate: 0,
          equipmentGoodRate: 0,
          data: data as any,
        },
      });

      return report;
    }

    const vaccinatedCount = (siteIds.length > 0 || !region)
      ? await prisma.vaccinationRecord.count({
          where: {
            administrationDate: { gte: dayStart, lte: dayEnd },
            ...(siteIds.length > 0 ? { siteId: { in: siteIds } } : {}),
          },
        })
      : 0;

    const totalUsedQty = vaccinatedCount;

    let totalScrappedQty = 0;
    if (siteIds.length > 0 && !region) {
      const scrappedInScope = await prisma.scrappedRecord.findMany({
        where: {
          scrapDate: { gte: dayStart, lte: dayEnd },
        },
        include: { batch: true },
      });

      for (const scrapped of scrappedInScope) {
        const siteStocks = await prisma.inventoryStock.findMany({
          where: { batchId: scrapped.batchId, siteId: { in: siteIds } },
          select: { quantity: true },
        });
        if (siteStocks.length === 0) continue;

        const siteStockQty = siteStocks.reduce((s, i) => s + i.quantity, 0);
        const allStock = await prisma.inventoryStock.aggregate({
          where: { batchId: scrapped.batchId },
          _sum: { quantity: true },
        });
        const totalSiteStockQty = allStock._sum.quantity || 1;

        const ratio = totalSiteStockQty > 0 ? siteStockQty / totalSiteStockQty : 0;
        totalScrappedQty += Math.round(scrapped.quantity * ratio);
      }
    } else if (region) {
      const scrappedInRegion = await prisma.scrappedRecord.findMany({
        where: {
          scrapDate: { gte: dayStart, lte: dayEnd },
        },
        include: { batch: { include: { storageSlot: { include: { coldStorage: true } } } } },
      });
      totalScrappedQty = scrappedInRegion
        .filter((r) => r.batch.storageSlot?.coldStorage?.region === region)
        .reduce((s, r) => s + r.quantity, 0);
    } else {
      const allScrapped = await prisma.scrappedRecord.aggregate({
        where: { scrapDate: { gte: dayStart, lte: dayEnd } },
        _sum: { quantity: true },
      });
      totalScrappedQty = allScrapped._sum.quantity || 0;
    }

    const lossRate = totalUsedQty > 0
      ? (totalScrappedQty / (totalUsedQty + totalScrappedQty)) * 100
      : 0;

    const adverseCount = (siteIds.length > 0 || !region)
      ? await prisma.adverseReactionReport.count({
          where: {
            reportDate: { gte: dayStart, lte: dayEnd },
            vaccinationRecord: siteIds.length > 0 ? { siteId: { in: siteIds } } : undefined,
          } as any,
        })
      : 0;

    const adverseRate = vaccinatedCount > 0 ? (adverseCount / vaccinatedCount) * 100 : 0;

    const equipmentWhere: any = {};
    if (region) {
      equipmentWhere.coldStorage = { region };
    }
    const totalEquipment = await prisma.coldChainEquipment.count({ where: equipmentWhere });
    const goodEquipment = await prisma.coldChainEquipment.count({
      where: { ...equipmentWhere, status: 'GOOD' },
    });
    const equipmentGoodRate = totalEquipment > 0 ? (goodEquipment / totalEquipment) * 100 : 100;

    const data = {
      totalVaccinated: vaccinatedCount,
      lossRate: Math.round(lossRate * 100) / 100,
      adverseRate: Math.round(adverseRate * 100) / 100,
      equipmentGoodRate: Math.round(equipmentGoodRate * 100) / 100,
      details: {
        vaccinatedBySite: [] as any[],
        scrappedQty: totalScrappedQty,
        usedQty: totalUsedQty,
        adverseCount,
        equipmentTotal: totalEquipment,
        equipmentGood: goodEquipment,
      },
    };

    for (const site of sites) {
      const count = await prisma.vaccinationRecord.count({
        where: {
          siteId: site.id,
          administrationDate: { gte: dayStart, lte: dayEnd },
        },
      });
      data.details.vaccinatedBySite.push({ siteId: site.id, count });
    }

    const report = await prisma.dailyReport.upsert({
      where: {
        reportDate_region_siteId: {
          reportDate: dayStart,
          region: region || '',
          siteId: siteId || '',
        },
      },
      create: {
        reportDate: dayStart,
        region: region || null,
        siteId: siteId || null,
        totalVaccinated: vaccinatedCount,
        lossRate: data.lossRate,
        adverseRate: data.adverseRate,
        equipmentGoodRate: data.equipmentGoodRate,
        data: data as any,
      },
      update: {
        totalVaccinated: vaccinatedCount,
        lossRate: data.lossRate,
        adverseRate: data.adverseRate,
        equipmentGoodRate: data.equipmentGoodRate,
        data: data as any,
      },
    });

    wsService.sendStatusChange('daily_report', report.id, 'GENERATED', {
      date: format(dayStart, 'yyyy-MM-dd'),
      totalVaccinated: vaccinatedCount,
    });

    await notificationService.notifyCDC(
      NotificationType.REPORT_READY,
      '每日运营报表已生成',
      `${format(dayStart, 'yyyy-MM-dd')}运营报表已生成，接种${vaccinatedCount}剂，损耗率${data.lossRate}%`,
      { reportId: report.id, date: format(dayStart, 'yyyy-MM-dd') }
    );

    return report;
  }

  async getReports(params: z.infer<typeof reportQuerySchema>) {
    const where: any = {};
    if (params.startDate) {
      where.reportDate = { ...where.reportDate, gte: startOfDay(new Date(params.startDate)) };
    }
    if (params.endDate) {
      where.reportDate = { ...where.reportDate, lte: endOfDay(new Date(params.endDate)) };
    }
    if (params.region) where.region = params.region;
    if (params.siteId) where.siteId = params.siteId;

    const reports = await prisma.dailyReport.findMany({
      where,
      orderBy: { reportDate: 'desc' },
    });

    return reports;
  }

  async exportReportsCsv(params: z.infer<typeof reportQuerySchema>): Promise<string> {
    const reports = await this.getReports(params);

    const exportDir = path.join(process.cwd(), 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const filename = `reports_${Date.now()}.csv`;
    const filePath = path.join(exportDir, filename);

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'reportDate', title: '日期' },
        { id: 'region', title: '区域' },
        { id: 'siteId', title: '接种点ID' },
        { id: 'totalVaccinated', title: '接种量' },
        { id: 'lossRate', title: '损耗率(%)' },
        { id: 'adverseRate', title: '不良反应率(%)' },
        { id: 'equipmentGoodRate', title: '冷链设备完好率(%)' },
      ],
    });

    const records = reports.map((r) => ({
      reportDate: format(r.reportDate, 'yyyy-MM-dd'),
      region: r.region || '-',
      siteId: r.siteId || '-',
      totalVaccinated: r.totalVaccinated,
      lossRate: r.lossRate,
      adverseRate: r.adverseRate,
      equipmentGoodRate: r.equipmentGoodRate,
    }));

    await csvWriter.writeRecords(records);
    return filePath;
  }

  async getRealTimeStats(region?: string, siteId?: string) {
    const whereStock: any = { status: { not: InventoryStatus.SCRAPPED } };
    if (siteId) whereStock.siteId = siteId;

    const today = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());

    const [totalInventory, todayVaccinated, todayAppointments, pendingAppointments, activeDeliveries] = await Promise.all([
      prisma.inventoryStock.aggregate({ where: whereStock, _sum: { quantity: true } }),
      prisma.vaccinationRecord.count({
        where: {
          administrationDate: { gte: today, lte: todayEnd },
          ...(siteId ? { siteId } : {}),
        },
      }),
      prisma.appointment.count({
        where: {
          appointmentDate: { gte: today, lte: todayEnd },
          ...(siteId ? { siteId } : {}),
        },
      }),
      prisma.appointment.count({
        where: {
          status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
          appointmentDate: { gte: today },
          ...(siteId ? { siteId } : {}),
        },
      }),
      prisma.delivery.count({ where: { status: 'IN_TRANSIT' } }),
    ]);

    return {
      totalInventory: totalInventory._sum.quantity || 0,
      todayVaccinated,
      todayAppointments,
      pendingAppointments,
      activeDeliveries,
    };
  }

  async getExpiryRiskBoard(region?: string, siteId?: string) {
    const today = startOfDay(new Date());
    const in7Days = endOfDay(addDays(today, 7));
    const in30Days = endOfDay(addDays(today, 30));
    const in60Days = endOfDay(addDays(today, 60));
    const thirtyDaysAgo = startOfDay(subDays(today, 30));

    const whereSite: any = {};
    if (region) whereSite.region = region;
    if (siteId) whereSite.id = siteId;
    const sites = await prisma.vaccinationSite.findMany({ where: whereSite, select: { id: true, name: true, region: true } });
    const siteIds = sites.map((s) => s.id);

    let regionExists = true;
    if (region) {
      const regionCount = await prisma.vaccinationSite.count({ where: { region } })
        + await prisma.coldStorage.count({ where: { region } });
      regionExists = regionCount > 0;
    }

    if ((region && !regionExists) || (siteId && siteIds.length === 0)) {
      return {
        scopeInvalid: true,
        scopeDescription: `${siteId ? '接种点' : ''}${region ? '区域' : ''}不存在，按空范围统计`,
        summary: {
          expiringIn7Days: 0,
          expiringIn30Days: 0,
          expiringIn60Days: 0,
          totalAtRisk: 0,
          totalStock: 0,
        },
        batches: [],
        suggestions: [],
      };
    }

    const batchWhere: any = {
      status: { notIn: [InventoryStatus.SCRAPPED, InventoryStatus.EXPIRED] },
      availableQuantity: { gt: 0 },
    };

    const batches = await prisma.vaccineBatch.findMany({
      where: batchWhere,
      include: {
        vaccine: { select: { id: true, name: true } },
        storageSlot: { include: { coldStorage: { select: { id: true, name: true, region: true } } } },
        siteStock: { include: { site: { select: { id: true, name: true, region: true } } } },
      },
    });

    const filteredBatches = batches.filter((b) => {
      if (siteIds.length > 0) {
        return b.siteStock.some((s) => siteIds.includes(s.siteId));
      }
      if (region) {
        const inRegionStorage = b.storageSlot?.coldStorage?.region === region;
        const inRegionSite = b.siteStock.some((s) => s.site.region === region);
        return inRegionStorage || inRegionSite;
      }
      return true;
    });

    const thirtyDaysUsed: Record<string, number> = {};
    const recentVaccinations = await prisma.vaccinationRecord.groupBy({
      by: ['batchId', 'vaccineId'],
      where: {
        administrationDate: { gte: thirtyDaysAgo, lte: today },
        ...(siteIds.length > 0 ? { siteId: { in: siteIds } } : {}),
      },
      _count: { id: true },
    });
    for (const row of recentVaccinations) {
      thirtyDaysUsed[row.vaccineId] = (thirtyDaysUsed[row.vaccineId] || 0) + row._count.id;
    }

    const batchResults = filteredBatches
      .filter((b) => b.expiryDate.getTime() <= in60Days.getTime())
      .map((b) => {
        const daysToExpiry = differenceInDays(b.expiryDate, today);
        let riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';
        let riskWindow: '7_DAYS' | '30_DAYS' | '60_DAYS';

        if (daysToExpiry <= 7) {
          riskLevel = 'HIGH';
          riskWindow = '7_DAYS';
        } else if (daysToExpiry <= 30) {
          riskLevel = 'MEDIUM';
          riskWindow = '30_DAYS';
        } else {
          riskLevel = 'LOW';
          riskWindow = '60_DAYS';
        }

        const qtyInScope = siteIds.length > 0
          ? b.siteStock.filter((s) => siteIds.includes(s.siteId)).reduce((s, i) => s + i.quantity, 0)
          : region
            ? (b.storageSlot?.coldStorage?.region === region ? b.availableQuantity : 0)
              + b.siteStock.filter((s) => s.site.region === region).reduce((s, i) => s + i.quantity, 0)
            : b.availableQuantity + b.siteStock.reduce((s, i) => s + i.quantity, 0);

        const dailyUsage = (thirtyDaysUsed[b.vaccineId] || 0) / 30;
        const daysOfStock = dailyUsage > 0 ? qtyInScope / dailyUsage : Infinity;

        let suggestion: string;
        let action: 'ALLOCATE_TO_SITE' | 'PRIORITY_USE' | 'SUSPEND_REQUISITION' | 'MONITOR' | 'EXPEDITE_USE';

        if (riskLevel === 'HIGH') {
          if (dailyUsage > 0 && daysOfStock <= 14) {
            suggestion = `距效期仅${daysToExpiry}天，30天日均消耗${dailyUsage.toFixed(1)}剂，预计${daysOfStock.toFixed(0)}天用完，建议优先安排该站点接种使用`;
            action = 'PRIORITY_USE';
          } else if (dailyUsage > 0) {
            suggestion = `距效期仅${daysToExpiry}天，建议紧急调拨至近期有预约的接种点优先使用，避免报废`;
            action = 'ALLOCATE_TO_SITE';
          } else {
            suggestion = `距效期仅${daysToExpiry}天，近30天无消耗记录，建议立即暂停该疫苗申领并评估跨区调拨或报废`;
            action = 'SUSPEND_REQUISITION';
          }
        } else if (riskLevel === 'MEDIUM') {
          if (dailyUsage > 0 && daysOfStock <= 30) {
            suggestion = `距效期${daysToExpiry}天，预计${daysOfStock.toFixed(0)}天用完，建议在接种计划中优先排期`;
            action = 'PRIORITY_USE';
          } else {
            suggestion = `距效期${daysToExpiry}天，建议密切监控消耗速度，必要时调拨`;
            action = 'MONITOR';
          }
        } else {
          if (dailyUsage > 0 && daysOfStock <= 60) {
            suggestion = `距效期${daysToExpiry}天，预计${daysOfStock.toFixed(0)}天用完，可正常使用`;
            action = 'EXPEDITE_USE';
          } else {
            suggestion = `距效期${daysToExpiry}天，库存充足，建议监控`;
            action = 'MONITOR';
          }
        }

        return {
          batchId: b.id,
          batchNumber: b.batchNumber,
          vaccineId: b.vaccineId,
          vaccineName: b.vaccine.name,
          manufactureDate: b.manufactureDate,
          expiryDate: b.expiryDate,
          daysToExpiry,
          riskLevel,
          riskWindow,
          availableQuantity: b.availableQuantity,
          quantityInScope: qtyInScope,
          storage: b.storageSlot
            ? {
                coldStorageId: b.storageSlot.coldStorage?.id,
                coldStorageName: b.storageSlot.coldStorage?.name,
                region: b.storageSlot.coldStorage?.region,
                slotCode: b.storageSlot.slotCode,
              }
            : null,
          siteDistribution: b.siteStock.map((s) => ({
            siteId: s.siteId,
            siteName: s.site.name,
            region: s.site.region,
            quantity: s.quantity,
          })),
          usage: {
            last30DaysUsed: thirtyDaysUsed[b.vaccineId] || 0,
            avgDailyUsage: Number(dailyUsage.toFixed(2)),
            estimatedDaysOfStock: Number.isFinite(daysOfStock) ? Number(daysOfStock.toFixed(1)) : null,
          },
          suggestion,
          recommendedAction: action,
        };
      })
      .sort((a, b) => a.daysToExpiry - b.daysToExpiry);

    const expiringIn7Days = batchResults.filter((b) => b.riskWindow === '7_DAYS').reduce((s, b) => s + b.quantityInScope, 0);
    const expiringIn30Days = batchResults.filter((b) => b.riskWindow === '30_DAYS').reduce((s, b) => s + b.quantityInScope, 0);
    const expiringIn60Days = batchResults.filter((b) => b.riskWindow === '60_DAYS').reduce((s, b) => s + b.quantityInScope, 0);

    const totalInScope = batches.reduce((sum, b) => {
      const qty = siteIds.length > 0
        ? b.siteStock.filter((s) => siteIds.includes(s.siteId)).reduce((s, i) => s + i.quantity, 0)
        : region
          ? (b.storageSlot?.coldStorage?.region === region ? b.availableQuantity : 0)
            + b.siteStock.filter((s) => s.site.region === region).reduce((s, i) => s + i.quantity, 0)
          : b.availableQuantity + b.siteStock.reduce((s, i) => s + i.quantity, 0);
      return sum + qty;
    }, 0);

    const suggestions: any[] = [];
    const highRiskCount = batchResults.filter((b) => b.riskLevel === 'HIGH').length;
    const mediumRiskCount = batchResults.filter((b) => b.riskLevel === 'MEDIUM').length;

    if (highRiskCount > 0) {
      suggestions.push({
        priority: 'CRITICAL',
        title: `${highRiskCount}个批次7天内到期`,
        detail: `共${expiringIn7Days}剂在7天内到期，涉及${new Set(batchResults.filter((b) => b.riskLevel === 'HIGH').map((b) => b.vaccineName)).size}种疫苗，建议立即启动优先使用或跨区调拨`,
        affectedBatchCount: highRiskCount,
        affectedQty: expiringIn7Days,
      });
    }
    if (mediumRiskCount > 0) {
      suggestions.push({
        priority: 'WARN',
        title: `${mediumRiskCount}个批次30天内到期`,
        detail: `共${expiringIn30Days}剂在30天内到期，建议在接种排期中优先安排`,
        affectedBatchCount: mediumRiskCount,
        affectedQty: expiringIn30Days,
      });
    }
    const suspendCount = batchResults.filter((b) => b.recommendedAction === 'SUSPEND_REQUISITION').length;
    if (suspendCount > 0) {
      suggestions.push({
        priority: 'WARN',
        title: `${suspendCount}个批次建议暂停申领`,
        detail: `近30天无消耗且临近效期，建议暂停新的申领并评估跨区调拨可能性`,
        affectedBatchCount: suspendCount,
      });
    }
    if (suggestions.length === 0) {
      suggestions.push({
        priority: 'OK',
        title: '效期情况正常',
        detail: '未来60天内无高风险到期批次',
      });
    }

    return {
      scope: {
        region: region || null,
        siteId: siteId || null,
        siteIdsInScope: siteIds,
        generatedAt: new Date(),
      },
      summary: {
        expiringIn7Days,
        expiringIn30Days,
        expiringIn60Days,
        totalAtRisk: expiringIn7Days + expiringIn30Days + expiringIn60Days,
        totalStock: totalInScope,
        highRiskBatchCount: highRiskCount,
        mediumRiskBatchCount: mediumRiskCount,
      },
      batches: batchResults,
      suggestions,
    };
  }

  async exportExpiryRiskCsv(region?: string, siteId?: string): Promise<string> {
    const board = await this.getExpiryRiskBoard(region, siteId);

    const exportDir = path.join(process.cwd(), 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const filename = `expiry_risk_${Date.now()}.csv`;
    const filePath = path.join(exportDir, filename);

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'vaccineName', title: '疫苗名称' },
        { id: 'batchNumber', title: '批次号' },
        { id: 'manufactureDate', title: '生产日期' },
        { id: 'expiryDate', title: '有效期' },
        { id: 'daysToExpiry', title: '距到期天数' },
        { id: 'riskLevel', title: '风险等级' },
        { id: 'riskWindow', title: '风险窗口期' },
        { id: 'quantityInScope', title: '范围内库存(剂)' },
        { id: 'storageRegion', title: '所在区域' },
        { id: 'storageLocation', title: '冷库/库位' },
        { id: 'siteDistribution', title: '接种点分布' },
        { id: 'last30DaysUsed', title: '近30天消耗(剂)' },
        { id: 'avgDailyUsage', title: '日均消耗(剂)' },
        { id: 'estimatedDaysOfStock', title: '预计可用天数' },
        { id: 'recommendedAction', title: '建议动作' },
        { id: 'suggestion', title: '处置建议' },
      ],
    });

    const records = board.batches.map((b: any) => ({
      vaccineName: b.vaccineName,
      batchNumber: b.batchNumber,
      manufactureDate: format(b.manufactureDate, 'yyyy-MM-dd'),
      expiryDate: format(b.expiryDate, 'yyyy-MM-dd'),
      daysToExpiry: b.daysToExpiry,
      riskLevel: b.riskLevel,
      riskWindow: b.riskWindow,
      quantityInScope: b.quantityInScope,
      storageRegion: b.storage?.region || '-',
      storageLocation: b.storage ? `${b.storage.coldStorageName || '-'}/${b.storage.slotCode || '-'}` : '-',
      siteDistribution: b.siteDistribution.map((s: any) => `${s.siteName}(${s.quantity})`).join('; '),
      last30DaysUsed: b.usage.last30DaysUsed,
      avgDailyUsage: b.usage.avgDailyUsage,
      estimatedDaysOfStock: b.usage.estimatedDaysOfStock ?? '-',
      recommendedAction: b.recommendedAction,
      suggestion: b.suggestion,
    }));

    await csvWriter.writeRecords(records);
    return filePath;
  }
}

export const reportService = new ReportService();
