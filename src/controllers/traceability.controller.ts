import { Request, Response } from 'express';
import { traceabilityService } from '../services/traceability.service';
import { success, fail } from '../utils/response';

export const traceabilityController = {
  async getBatchTraceability(req: Request, res: Response) {
    const { batchNumber, batchId } = req.query;
    if (!batchNumber && !batchId) return fail(res, '请提供批次号(batchNumber)或批次ID(batchId)', 400);
    const data = await traceabilityService.getBatchTraceability(
      batchNumber as string | undefined,
      batchId as string | undefined
    );
    return success(res, data);
  },

  async getByCertificate(req: Request, res: Response) {
    const { certificateNo } = req.params;
    if (!certificateNo) return fail(res, '请提供接种证号', 400);
    const data = await traceabilityService.getTraceabilityByCertificate(certificateNo);
    return success(res, data);
  },
};
