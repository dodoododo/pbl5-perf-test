import { PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  it('disconnects Prisma when the Nest application closes', async () => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    // Test the hook without constructing Prisma's extended client proxy.
    const service = Object.create(PrismaService.prototype) as PrismaService;
    service.$disconnect = disconnect;

    await service.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
