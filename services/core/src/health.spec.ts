import 'reflect-metadata';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module';

describe('GET /healthz（core 骨架冒烟）', () => {
  it('返回 200 与 status=ok', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('@ljr/core');

    await app.close();
  });
});
