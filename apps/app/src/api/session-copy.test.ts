import { describe, expect, it } from 'bun:test';
import type { SessionView } from './sessions';
import {
  SESSION_STATUS_COPY,
  SESSION_STATUS_FILTERS,
  filterSessionsByStatus,
  priceModeCopy,
  roomModeCopy,
  sessionClosedNote,
  sessionStatusCopy,
  specialtyCopy,
} from './session-copy';

/** C1 状态机全集（session.machine 十态；REFUNDED 属退款域语义不落场次机） */
const C1_STATUSES = [
  'CREATED',
  'FULL',
  'CONFIRMED',
  'OPEN',
  'IN_SERVICE',
  'FINISHED',
  'HOLD',
  'SETTLED',
  'FAILED',
  'CANCELLED',
] as const;

function sessionOf(status: SessionView['status']): SessionView {
  return {
    id: 1,
    lawyer_id: 2,
    mode: 'B2C',
    specialty: 'labor_arbitration',
    city: '北京',
    slot_start: '2026-11-06T12:00:00Z',
    price_mode: 'per_head',
    unit_price: '199.00',
    session_total: '995.00',
    capacity: 5,
    joined: 3,
    enroll_deadline: '2026-11-05T12:00:00Z',
    room_mode: 'text',
    status,
    created_at: '2026-10-20T10:00:00Z',
  };
}

describe('场次状态文案映射表（单源，禁散写三元）', () => {
  it('C1 十态逐态有文案与色调档（映射缺态即测试红）', () => {
    for (const status of C1_STATUSES) {
      const copy = SESSION_STATUS_COPY[status];
      expect(copy.label.length).toBeGreaterThan(0);
      expect(['open', 'grouped', 'live', 'finished', 'failed']).toContain(copy.tone);
    }
    expect(SESSION_STATUS_COPY.CREATED.label).toBe('报名中');
    expect(SESSION_STATUS_COPY.IN_SERVICE.label).toBe('进行中');
    expect(SESSION_STATUS_COPY.FAILED.label).toBe('已流标 · 退款');
  });

  it('未知状态回退显示原码（fail-visible 不吞不撒谎）', () => {
    expect(sessionStatusCopy('SOMETHING_NEW')).toEqual({
      label: 'SOMETHING_NEW',
      tone: 'finished',
    });
  });

  it('计价/沟通形式/专项文案映射 + 未知值回退原码', () => {
    expect(priceModeCopy('per_head')).toBe('人头价');
    expect(priceModeCopy('session_total')).toBe('总价分摊');
    expect(priceModeCopy('odd_mode')).toBe('odd_mode');
    expect(roomModeCopy('text')).toBe('图文');
    expect(roomModeCopy('voice')).toBe('语音');
    expect(roomModeCopy('video')).toBe('视频');
    expect(roomModeCopy('wechat')).toBe('wechat');
    expect(specialtyCopy('labor_arbitration')).toBe('劳动仲裁');
    expect(specialtyCopy('divorce')).toBe('divorce');
  });
});

describe('报名关闭说明（非报名中态分组文案，评审 I2——FAILED 不得落入「满员成团」句式）', () => {
  it('成团链（FULL/CONFIRMED/OPEN/IN_SERVICE）用「满员成团后不再接受新报名」句式', () => {
    for (const status of ['FULL', 'CONFIRMED', 'OPEN', 'IN_SERVICE'] as const) {
      expect(sessionClosedNote(status)).toContain('满员成团后不再接受新报名');
    }
  });

  it('FAILED=流标退款句；CANCELLED=取消退款句；终态三句逐字（均不落入「满员成团」句式）', () => {
    expect(sessionClosedNote('FAILED')).toBe('已流标，报名费用将原路全额自动退款。');
    expect(sessionClosedNote('CANCELLED')).toBe('场次已取消，已支付报名将按取消规则处理退款。');
    expect(sessionClosedNote('FINISHED')).toBe('场次已结束，不再接受新报名。');
    expect(sessionClosedNote('HOLD')).toBe('场次已结束（结算处理中），不再接受新报名。');
    expect(sessionClosedNote('SETTLED')).toBe('场次已结算，不再接受新报名。');
    for (const status of ['FAILED', 'CANCELLED', 'FINISHED', 'HOLD', 'SETTLED'] as const) {
      expect(sessionClosedNote(status)).not.toContain('满员成团');
    }
  });

  it('未知状态回退：状态文案 + 通用关闭句（fail-visible 不吞）', () => {
    expect(sessionClosedNote('SOMETHING_NEW')).toBe('SOMETHING_NEW——不再接受新报名。');
  });
});

describe('列表状态筛选（客户端过滤，映射表驱动）', () => {
  const list = [
    sessionOf('CREATED'),
    sessionOf('FULL'),
    sessionOf('CONFIRMED'),
    sessionOf('IN_SERVICE'),
    sessionOf('FINISHED'),
    sessionOf('FAILED'),
  ];

  it('全部=原样；报名中=仅 CREATED', () => {
    expect(filterSessionsByStatus(list, 'all')).toHaveLength(6);
    const created = filterSessionsByStatus(list, 'CREATED');
    expect(created.map((s) => s.status)).toEqual(['CREATED']);
  });

  it('已成团=FULL+CONFIRMED；进行中=OPEN+IN_SERVICE（生命周期分组单源）', () => {
    expect(filterSessionsByStatus(list, 'GROUPED').map((s) => s.status)).toEqual([
      'FULL',
      'CONFIRMED',
    ]);
    expect(filterSessionsByStatus(list, 'LIVE').map((s) => s.status)).toEqual(['IN_SERVICE']);
  });

  it('筛选键须在登记表内（防散写魔法键）', () => {
    expect(SESSION_STATUS_FILTERS.map((f) => f.key)).toEqual([
      'all',
      'CREATED',
      'GROUPED',
      'LIVE',
      'DONE',
      'FAILED',
    ]);
  });

  it('公开列表可用档=仅 all/CREATED（core W3-12：列表只回报名中——其余档禁用+角标，评审 S7）', () => {
    for (const f of SESSION_STATUS_FILTERS) {
      expect(f.available).toBe(f.key === 'all' || f.key === 'CREATED');
    }
  });
});
