import { PrismaClient, UserRole, TemperatureZone, VaccineType } from '@prisma/client';
import { hashPassword } from '../src/utils/auth';

const prisma = new PrismaClient();

async function main() {
  console.log('开始初始化数据...');

  const cdcAdmin = await prisma.user.upsert({
    where: { username: 'cdc_admin' },
    update: {},
    create: {
      username: 'cdc_admin',
      passwordHash: hashPassword('admin123'),
      name: '疾控管理员',
      role: UserRole.CDC_ADMIN,
      phone: '13800000001',
      email: 'cdc@example.com',
      organization: '市疾控中心',
      region: 'east_district',
    },
  });
  console.log('✓ CDC管理员创建: cdc_admin / admin123');

  const warehouseStaff = await prisma.user.upsert({
    where: { username: 'warehouse' },
    update: {},
    create: {
      username: 'warehouse',
      passwordHash: hashPassword('ware123'),
      name: '仓库管理员',
      role: UserRole.WAREHOUSE_STAFF,
      phone: '13800000002',
      organization: '中心冷库',
      region: 'east_district',
    },
  });
  console.log('✓ 仓库管理员创建: warehouse / ware123');

  const vaccineStaff = await prisma.user.upsert({
    where: { username: 'vaccine_staff' },
    update: {},
    create: {
      username: 'vaccine_staff',
      passwordHash: hashPassword('vacc123'),
      name: '接种医生',
      role: UserRole.VACCINATION_STAFF,
      phone: '13800000003',
      organization: '东区接种点',
      region: 'east_district',
    },
  });
  console.log('✓ 接种人员创建: vaccine_staff / vacc123');

  const auditor = await prisma.user.upsert({
    where: { username: 'auditor' },
    update: {},
    create: {
      username: 'auditor',
      passwordHash: hashPassword('audit123'),
      name: '审核员',
      role: UserRole.AUDITOR,
      phone: '13800000004',
      organization: '不良反应监测中心',
    },
  });
  console.log('✓ 审核员创建: auditor / audit123');

  const parent = await prisma.user.upsert({
    where: { username: 'parent' },
    update: {},
    create: {
      username: 'parent',
      passwordHash: hashPassword('parent123'),
      name: '家长用户',
      role: UserRole.PARENT,
      phone: '13900000001',
    },
  });
  console.log('✓ 家长用户创建: parent / parent123');

  const deliveryStaff = await prisma.user.upsert({
    where: { username: 'delivery' },
    update: {},
    create: {
      username: 'delivery',
      passwordHash: hashPassword('deliv123'),
      name: '配送人员',
      role: UserRole.DELIVERY_STAFF,
      phone: '13800000005',
    },
  });
  console.log('✓ 配送人员创建: delivery / deliv123');

  const coldStorage = await prisma.coldStorage.upsert({
    where: { id: 'cs_001' },
    update: {},
    create: {
      id: 'cs_001',
      name: '东区一号冷库',
      location: '市疾控中心A栋1层',
      temperatureZone: TemperatureZone.REFRIGERATED,
      totalSlots: 50,
      usedSlots: 0,
      status: 'ACTIVE',
      region: 'east_district',
    },
  });

  for (let i = 1; i <= 20; i++) {
    await prisma.storageSlot.upsert({
      where: { id: `slot_${i.toString().padStart(3, '0')}` },
      update: {},
      create: {
        id: `slot_${i.toString().padStart(3, '0')}`,
        coldStorageId: coldStorage.id,
        slotCode: `R-A-${i.toString().padStart(3, '0')}`,
        temperatureZone: TemperatureZone.REFRIGERATED,
        isOccupied: false,
      },
    });
  }
  console.log('✓ 冷库和库位创建');

  const equipment = await prisma.coldChainEquipment.upsert({
    where: { serialNumber: 'EQ-REF-001' },
    update: {},
    create: {
      serialNumber: 'EQ-REF-001',
      equipmentType: '医用冷藏箱',
      model: 'Haier HYC-310',
      temperatureZone: TemperatureZone.REFRIGERATED,
      status: 'GOOD',
      coldStorageId: coldStorage.id,
      lastCalibration: new Date(),
      lastMaintenance: new Date(),
    },
  });
  console.log('✓ 冷链设备创建');

  const bcgVaccine = await prisma.vaccineCatalog.upsert({
    where: { code: 'BCG' },
    update: {},
    create: {
      code: 'BCG',
      name: '卡介苗',
      manufacturer: '北京生物制品研究所有限责任公司',
      type: VaccineType.LIVE_ATTENUATED,
      temperatureZone: TemperatureZone.REFRIGERATED,
      minTemperature: 2,
      maxTemperature: 8,
      standardDoseCount: 1,
      doseIntervalDays: 0,
      suitableAgeMonths: 0,
      maxAgeMonths: 12,
      description: '预防结核病',
    },
  });

  const hepbVaccine = await prisma.vaccineCatalog.upsert({
    where: { code: 'HEPB' },
    update: {},
    create: {
      code: 'HEPB',
      name: '乙肝疫苗',
      manufacturer: '深圳康泰生物制品股份有限公司',
      type: VaccineType.INACTIVATED,
      temperatureZone: TemperatureZone.REFRIGERATED,
      minTemperature: 2,
      maxTemperature: 8,
      standardDoseCount: 3,
      doseIntervalDays: 30,
      suitableAgeMonths: 0,
      description: '预防乙型肝炎',
    },
  });

  const dtpVaccine = await prisma.vaccineCatalog.upsert({
    where: { code: 'DTP' },
    update: {},
    create: {
      code: 'DTP',
      name: '百白破疫苗',
      manufacturer: '武汉生物制品研究所有限责任公司',
      type: VaccineType.INACTIVATED,
      temperatureZone: TemperatureZone.REFRIGERATED,
      minTemperature: 2,
      maxTemperature: 8,
      standardDoseCount: 4,
      doseIntervalDays: 28,
      suitableAgeMonths: 3,
      maxAgeMonths: 24,
      description: '预防百日咳、白喉、破伤风',
    },
  });

  const mmrVaccine = await prisma.vaccineCatalog.upsert({
    where: { code: 'MMR' },
    update: {},
    create: {
      code: 'MMR',
      name: '麻腮风疫苗',
      manufacturer: '上海生物制品研究所有限责任公司',
      type: VaccineType.LIVE_ATTENUATED,
      temperatureZone: TemperatureZone.REFRIGERATED,
      minTemperature: 2,
      maxTemperature: 8,
      standardDoseCount: 2,
      doseIntervalDays: 28,
      suitableAgeMonths: 8,
      maxAgeMonths: 24,
      description: '预防麻疹、腮腺炎、风疹',
    },
  });
  console.log('✓ 疫苗目录创建 (BCG, HEPB, DTP, MMR)');

  for (const v of [bcgVaccine, hepbVaccine, dtpVaccine, mmrVaccine]) {
    for (let dose = 1; dose <= v.standardDoseCount; dose++) {
      await prisma.immunizationPlan.upsert({
        where: { id: `plan_${v.code}_${dose}` },
        update: {},
        create: {
          id: `plan_${v.code}_${dose}`,
          vaccineId: v.id,
          doseNumber: dose,
          minAgeMonths: v.suitableAgeMonths + (dose - 1) * (v.doseIntervalDays / 30),
          intervalDays: dose === 1 ? 0 : v.doseIntervalDays,
        },
      });
    }
  }
  console.log('✓ 免疫规划程序创建');

  const site = await prisma.vaccinationSite.upsert({
    where: { id: 'site_001' },
    update: {},
    create: {
      id: 'site_001',
      name: '东区社区卫生服务中心接种门诊',
      address: '东区朝阳路100号',
      region: 'east_district',
      contactPerson: '张医生',
      contactPhone: '010-12345678',
      dailyCapacity: 200,
      status: 'ACTIVE',
      workingHours: { weekdays: '08:00-17:00', weekend: '08:00-12:00' },
    },
  });
  console.log('✓ 接种点创建');

  const vehicle = await prisma.deliveryVehicle.upsert({
    where: { plateNumber: '京A12345' },
    update: {},
    create: {
      plateNumber: '京A12345',
      temperatureZone: TemperatureZone.REFRIGERATED,
      minTemperature: 2,
      maxTemperature: 8,
      status: 'AVAILABLE',
      driverName: '王师傅',
      driverPhone: '13700000001',
      capacity: 500,
      region: 'east_district',
    },
  });

  await prisma.coldChainEquipment.upsert({
    where: { serialNumber: 'EQ-VEH-001' },
    update: {},
    create: {
      serialNumber: 'EQ-VEH-001',
      equipmentType: '车载冷藏箱',
      model: 'ColdChain V-200',
      temperatureZone: TemperatureZone.REFRIGERATED,
      status: 'GOOD',
      vehicleId: vehicle.id,
    },
  });
  console.log('✓ 配送车辆创建');

  const child = await prisma.child.upsert({
    where: { id: 'child_001' },
    update: {},
    create: {
      id: 'child_001',
      parentId: parent.id,
      name: '张小宝',
      gender: '男',
      birthDate: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000),
      idCard: '110101202301011234',
    },
  });
  console.log('✓ 儿童档案创建: 张小宝 (6月龄)');

  console.log('\n=======================================');
  console.log('  数据初始化完成！');
  console.log('=======================================');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
