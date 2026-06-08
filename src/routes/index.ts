import { Router } from 'express';
import { authenticate, requireRoles } from '../middleware/auth.middleware';
import { authController } from '../controllers/auth.controller';
import { incomingController } from '../controllers/incoming.controller';
import { requisitionController } from '../controllers/requisition.controller';
import { deliveryController } from '../controllers/delivery.controller';
import { appointmentController } from '../controllers/appointment.controller';
import { vaccinationController } from '../controllers/vaccination.controller';
import { reportController } from '../controllers/report.controller';
import { traceabilityController } from '../controllers/traceability.controller';
import {
  childController,
  siteController,
  vaccineController,
  notificationController,
  vehicleController,
  storageController,
} from '../controllers/common.controller';
import { UserRole } from '@prisma/client';

const router = Router();

router.get('/health', (_req, res) => res.json({ code: 0, message: 'ok', timestamp: new Date().toISOString() }));

router.post('/auth/login', authController.login);
router.post('/auth/register', authController.register);
router.get('/auth/me', authenticate, authController.getCurrentUser);

router.get('/vaccines', vaccineController.list);
router.get('/vaccines/:id', vaccineController.getById);
router.get('/sites', siteController.list);
router.get('/sites/:id', siteController.getById);
router.get('/vehicles', vehicleController.list);
router.get('/cold-storages', storageController.listColdStorages);
router.get('/cold-chain-equipment', storageController.listEquipment);

router.use(authenticate);

router.post('/children', childController.create);
router.get('/children', childController.list);
router.get('/children/:id', childController.getById);

router.get('/notifications', notificationController.list);
router.put('/notifications/:id/read', notificationController.markRead);

router.get('/appointments/check-availability', appointmentController.checkAvailability);
router.post('/appointments', appointmentController.create);
router.get('/appointments', appointmentController.list);
router.get('/appointments/:id', appointmentController.getById);
router.put('/appointments/:id/status', appointmentController.updateStatus);

router.get('/vaccination/children/:childId/history', vaccinationController.getChildHistory);
router.get('/vaccination/records/:id/certificate', vaccinationController.getCertificate);
router.post('/vaccination/records', requireRoles(UserRole.VACCINATION_STAFF, UserRole.CDC_ADMIN), vaccinationController.createVaccination);
router.post('/vaccination/adverse-reactions', vaccinationController.reportAdverseReaction);
router.get('/vaccination/adverse-reactions', vaccinationController.listAdverseReactions);
router.put('/vaccination/adverse-reactions/:id/status', requireRoles(UserRole.AUDITOR, UserRole.CDC_ADMIN, UserRole.DRUG_ADMIN), vaccinationController.updateAdverseReactionStatus);

router.get('/inventory/stocks', vaccinationController.listInventory);
router.get('/inventory/batches', vaccinationController.listVaccineBatches);
router.post('/inventory/check-expiry', requireRoles(UserRole.WAREHOUSE_STAFF, UserRole.CDC_ADMIN), vaccinationController.checkExpiryAndScrap);
router.post('/inventory/scrap', requireRoles(UserRole.WAREHOUSE_STAFF, UserRole.CDC_ADMIN), vaccinationController.manualScrap);
router.get('/inventory/scrapped-records', vaccinationController.listScrappedRecords);

router.post('/incoming', requireRoles(UserRole.WAREHOUSE_STAFF, UserRole.CDC_ADMIN), incomingController.createIncoming);
router.get('/incoming', incomingController.listIncoming);

router.post('/requisitions', requisitionController.create);
router.get('/requisitions', requisitionController.list);
router.get('/requisitions/:id', requisitionController.getById);
router.put('/requisitions/:id/approve', requireRoles(UserRole.CDC_ADMIN, UserRole.WAREHOUSE_STAFF), requisitionController.approve);
router.put('/requisitions/:id/reject', requireRoles(UserRole.CDC_ADMIN, UserRole.WAREHOUSE_STAFF), requisitionController.reject);

router.post('/deliveries/temperature-log', deliveryController.logTemperature);
router.post('/deliveries/emergency-orders', deliveryController.createEmergencyOrder);
router.get('/deliveries/emergency-orders', deliveryController.listEmergencyOrders);
router.put('/deliveries/emergency-orders/:id/status', requireRoles(UserRole.CDC_ADMIN), deliveryController.updateEmergencyOrderStatus);
router.put('/deliveries/:id/start', requireRoles(UserRole.DELIVERY_STAFF, UserRole.CDC_ADMIN), deliveryController.startDelivery);
router.put('/deliveries/:id/complete', requireRoles(UserRole.DELIVERY_STAFF, UserRole.CDC_ADMIN), deliveryController.completeDelivery);
router.get('/deliveries', deliveryController.listDeliveries);
router.get('/deliveries/temperature-logs', deliveryController.getTemperatureLogs);

router.post('/reports/daily/generate', requireRoles(UserRole.CDC_ADMIN), reportController.generateDaily);
router.get('/reports', reportController.getReports);
router.get('/reports/export', reportController.exportCsv);
router.get('/reports/stats/realtime', reportController.getRealTimeStats);
router.get('/reports/expiry-risk', reportController.getExpiryRiskBoard);
router.get('/reports/expiry-risk/export', reportController.exportExpiryRiskCsv);

router.get('/traceability/batch', traceabilityController.getBatchTraceability);
router.get('/traceability/certificate/:certificateNo', traceabilityController.getByCertificate);

router.get('/deliveries/alert-events', deliveryController.listAlertEvents);
router.get('/deliveries/alert-events/by-delivery', deliveryController.getDeliveryAlertEvents);
router.put('/deliveries/alert-events/:id/status', requireRoles(UserRole.CDC_ADMIN), deliveryController.updateAlertEventStatus);

export default router;
