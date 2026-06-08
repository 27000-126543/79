import { prisma } from '../config/database';
import { wsService } from './websocket.service';
import { NotificationType, NotificationChannel, UserRole, Prisma } from '@prisma/client';

export interface CreateNotificationOptions {
  userId?: string;
  targetRoles?: UserRole[];
  targetRegion?: string;
  type: NotificationType;
  title: string;
  content: string;
  channel?: NotificationChannel;
  metadata?: Prisma.InputJsonValue;
  broadcastType?: string;
  broadcastData?: unknown;
}

class NotificationService {
  async createNotification(opts: CreateNotificationOptions) {
    const channel = opts.channel || NotificationChannel.SYSTEM;

    if (opts.userId) {
      const notification = await prisma.notification.create({
        data: {
          userId: opts.userId,
          type: opts.type,
          title: opts.title,
          content: opts.content,
          channel,
          metadata: opts.metadata,
        },
      });

      if (opts.broadcastType) {
        wsService.broadcastToUser(opts.userId, opts.broadcastType, opts.broadcastData || notification);
      }
      wsService.broadcastToUser(opts.userId, 'notification', notification);
      return notification;
    }

    if (opts.targetRoles) {
      const users = await prisma.user.findMany({
        where: {
          role: { in: opts.targetRoles },
          ...(opts.targetRegion ? { region: opts.targetRegion } : {}),
        },
        select: { id: true },
      });

      const notifications = await Promise.all(
        users.map((u) =>
          prisma.notification.create({
            data: {
              userId: u.id,
              type: opts.type,
              title: opts.title,
              content: opts.content,
              channel,
              metadata: opts.metadata,
            },
          })
        )
      );

      if (opts.broadcastType) {
        wsService.broadcastToRoles(
          opts.targetRoles,
          opts.broadcastType,
          opts.broadcastData || { count: notifications.length, type: opts.type },
          opts.targetRegion
        );
      }
      wsService.broadcastToRoles(
        opts.targetRoles,
        'notification_batch',
        { count: notifications.length, type: opts.type },
        opts.targetRegion
      );

      return notifications;
    }

    return null;
  }

  async notifyCDC(type: NotificationType, title: string, content: string, metadata?: Prisma.InputJsonValue) {
    return this.createNotification({
      targetRoles: [UserRole.CDC_ADMIN],
      type,
      title,
      content,
      metadata,
      broadcastType: 'cdc_notification',
    });
  }

  async notifyVaccinationSite(siteRegion: string, type: NotificationType, title: string, content: string, metadata?: Prisma.InputJsonValue) {
    return this.createNotification({
      targetRoles: [UserRole.VACCINATION_STAFF],
      targetRegion: siteRegion,
      type,
      title,
      content,
      metadata,
      broadcastType: 'site_notification',
    });
  }

  async notifyUser(userId: string, type: NotificationType, title: string, content: string, metadata?: Prisma.InputJsonValue) {
    return this.createNotification({
      userId,
      type,
      title,
      content,
      channel: NotificationChannel.APP_PUSH,
      metadata,
      broadcastType: 'user_notification',
    });
  }

  async notifyDrugAdmin(type: NotificationType, title: string, content: string, metadata?: Prisma.InputJsonValue) {
    return this.createNotification({
      targetRoles: [UserRole.DRUG_ADMIN],
      type,
      title,
      content,
      metadata,
      broadcastType: 'drug_admin_notification',
    });
  }
}

export const notificationService = new NotificationService();
