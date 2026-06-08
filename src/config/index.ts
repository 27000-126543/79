export const config = {
  port: parseInt(process.env.PORT || '3000'),
  jwtSecret: process.env.JWT_SECRET || 'vaccine-cold-chain-secret-key-2024',
  jwtExpiresIn: '7d',
  nearExpiryDays: 30,
  reminderDays: 7,
};
