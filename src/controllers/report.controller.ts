import { Request, Response } from 'express';
import { reportService, reportQuerySchema } from '../services/report.service';
import { success, fail } from '../utils/response';
import { parseISO } from 'date-fns';
import fs from 'fs';

export const reportController = {
  async generateDaily(req: Request, res: Response) {
    const date = req.body.date ? parseISO(req.body.date) : new Date();
    const { region, siteId } = req.body;
    const data = await reportService.generateDailyReport(date, region, siteId);
    return success(res, data, '报表生成成功', 201);
  },

  async getReports(req: Request, res: Response) {
    const result = reportQuerySchema.safeParse(req.query);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    const data = await reportService.getReports(result.data);
    return success(res, data);
  },

  async exportCsv(req: Request, res: Response) {
    const result = reportQuerySchema.safeParse(req.query);
    if (!result.success) return fail(res, '参数验证失败', 400, result.error.issues);
    const filePath = await reportService.exportReportsCsv(result.data);
    const filename = filePath.split('/').pop();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  },

  async getRealTimeStats(req: Request, res: Response) {
    const { region, siteId } = req.query;
    const data = await reportService.getRealTimeStats(region as string | undefined, siteId as string | undefined);
    return success(res, data);
  },

  async getExpiryRiskBoard(req: Request, res: Response) {
    const { region, siteId } = req.query;
    const data = await reportService.getExpiryRiskBoard(
      region as string | undefined,
      siteId as string | undefined
    );
    return success(res, data);
  },

  async exportExpiryRiskCsv(req: Request, res: Response) {
    const { region, siteId } = req.query;
    const filePath = await reportService.exportExpiryRiskCsv(
      region as string | undefined,
      siteId as string | undefined
    );
    const filename = filePath.split('/').pop();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  },
};
