import { prisma } from '../config/database';
import { AppError } from '../utils/response';
import { NotificationType, InventoryStatus, AppointmentStatus } from '@prisma/client';
import { notificationService } from './notification.service';
import { wsService } from './websocket.service';
import { z } from 'zod';
import { startOfDay, endOfDay, subDays, format } from 'date-fns';
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

    const vaccinatedCount = await prisma.vaccinationRecord.count({
      where: {
        administrationDate: { gte: dayStart, lte: dayEnd },
        ...(siteIds.length > 0 ? { siteId: { in: siteIds } } : {}),
      },
    });

    const totalUsedQty = vaccinatedCount;

    let totalScrappedQty = 0;
    if (siteIds.length > 0) {
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

    const adverseCount = await prisma.adverseReactionReport.count({
      where: {
        reportDate: { gte: dayStart, lte: dayEnd },
        vaccinationRecord: siteIds.length > 0 ? { siteId: { in: siteIds } } : undefined,
      } as any,
    });

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
}

export const reportService = new ReportService();
