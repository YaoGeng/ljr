import { createHmac, createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { hmacSha256Hex, sha256Hex, utf8Bytes } from './hmac-sha256';

describe('纯 TS SHA-256/HMAC（dev 支付模拟器签名原语，node:crypto 交叉验证）', () => {
  it('FIPS 180 标准向量：sha256("abc")', () => {
    expect(sha256Hex(utf8Bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(utf8Bytes(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('长报文（>单块）与 node:crypto 一致', () => {
    const msg = 'ljr'.repeat(1000);
    expect(sha256Hex(utf8Bytes(msg))).toBe(createHash('sha256').update(msg).digest('hex'));
  });

  it('HMAC-SHA256：RFC 4231 测试向量 1', () => {
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('HMAC：随机密钥/报文（含 UTF-8 中文与超 64 字节密钥）与 node:crypto 全等', () => {
    for (const [key, msg] of [
      ['mock-secret', '{"order_id":1,"event_type":"PAY_SUCCESS"}'],
      ['律聚人-密钥-超过六十四字节-'.repeat(4), '回调报文·中文载荷'],
      ['k', ''],
      ['x'.repeat(63), 'x'.repeat(200)],
    ] as const) {
      expect(hmacSha256Hex(key, msg)).toBe(
        createHmac('sha256', key).update(msg, 'utf8').digest('hex'),
      );
    }
  });

  it('utf8Bytes：中文按 3 字节、代理对 emoji 按 4 字节编码', () => {
    expect(utf8Bytes('劳')).toHaveLength(3);
    expect(utf8Bytes('🚀')).toHaveLength(4);
  });
});
