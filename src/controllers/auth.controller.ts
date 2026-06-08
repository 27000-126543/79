import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, fail, AppError } from '../utils/response';
import { hashPassword, comparePassword, generateToken } from '../utils/auth';
import { z } from 'zod';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const registerSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  role: z.enum(['CDC_ADMIN', 'VACCINATION_STAFF', 'WAREHOUSE_STAFF', 'DELIVERY_STAFF', 'PARENT', 'AUDITOR', 'DRUG_ADMIN']),
  organization: z.string().optional(),
  region: z.string().optional(),
});

export const authController = {
  async login(req: Request, res: Response) {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      return fail(res, '请求参数错误', 400, result.error.issues);
    }

    const { username, password } = result.data;
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !comparePassword(password, user.passwordHash)) {
      return fail(res, '用户名或密码错误', 401);
    }

    const token = generateToken({
      userId: user.id,
      role: user.role,
      username: user.username,
    });

    return success(res, {
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        phone: user.phone,
        email: user.email,
        organization: user.organization,
        region: user.region,
      },
    }, '登录成功');
  },

  async register(req: Request, res: Response) {
    const result = registerSchema.safeParse(req.body);
    if (!result.success) {
      return fail(res, '请求参数错误', 400, result.error.issues);
    }

    const existing = await prisma.user.findUnique({ where: { username: result.data.username } });
    if (existing) {
      return fail(res, '用户名已存在', 400);
    }

    const user = await prisma.user.create({
      data: {
        ...result.data,
        passwordHash: hashPassword(result.data.password),
      },
    });

    return success(res, {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    }, '注册成功', 201);
  },

  async getCurrentUser(req: Request, res: Response) {
    if (!req.user) {
      return fail(res, '请先登录', 401);
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        phone: true,
        email: true,
        organization: true,
        region: true,
      },
    });
    if (!user) {
      throw new AppError('用户不存在', 404);
    }
    return success(res, user);
  },
};
