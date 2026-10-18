import 'reflect-metadata';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module';

describe('GET /healthz（core 骨架冒烟）', () => {
  it('返回 200 与 status=ok', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    // D5 WSS 网关随 FulfillmentModule 注册（M2-W1 T3），init 前须挂 ws 适配器
    //（否则 Nest 回落加载未安装的 platform-socket.io 直接退出）——与 main.ts 装配同口径
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();

    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('@ljr/core');

    await app.close();
  });
});
