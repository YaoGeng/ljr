import { describe, expect, it } from 'bun:test';
import type { CurrentPricingView } from '../api/pricing';
import {
  isDirtyPricing,
  pricingDraftFromForm,
  pricingFormFromView,
  validatePricingForm,
} from './pricing-edit';

/** core CurrentPricingView 实文形态（v2：per_head 侧配置） */
const VIEW_WITH_PER_HEAD: CurrentPricingView = {
  version: 2,
  created_at: '2026-10-01T02:00:00.000Z',
  pricing: {
    per_head: '99.00',
    session_total: null,
    group_size: 5,
    accept_min: 2,
    accept_max: 6,
    room_modes: ['text', 'voice'],
    one_on_one_prices: {
      text: { per_round: '150.00' },
      voice: { per_15min: '200.00' },
      video: { per_15min: '300.00' },
    },
  },
};

/** 无任何版本：{version:0, created_at:null, pricing:null}（core 自定口径） */
const VIEW_EMPTY: CurrentPricingView = { version: 0, created_at: null, pricing: null };

describe('pricingFormFromView（服务端视图 → 表单态）', () => {
  it('有版本行：mode/金额/人数/范围/沟通形式/1对1 全字段带出', () => {
    const form = pricingFormFromView(VIEW_WITH_PER_HEAD);
    expect(form.priceMode).toBe('per_head');
    expect(form.perHead).toBe('99.00');
    expect(form.sessionTotal).toBe('');
    expect(form.groupSize).toBe('5');
    expect(form.acceptMin).toBe('2');
    expect(form.acceptMax).toBe('6');
    expect([...form.roomModes]).toEqual(['text', 'voice']);
    expect(form.oooText).toBe('150.00');
    expect(form.oooVoice).toBe('200.00');
    expect(form.oooVideo).toBe('300.00');
  });

  it('session_total 侧配置 → mode=session_total；null 列 → 空串', () => {
    const form = pricingFormFromView({
      version: 1,
      created_at: '2026-09-18T02:00:00.000Z',
      pricing: {
        per_head: null,
        session_total: '699.00',
        group_size: null,
        accept_min: null,
        accept_max: null,
        room_modes: null,
        one_on_one_prices: {
          text: { per_round: '120.00' },
          voice: { per_15min: '180.00' },
          video: { per_15min: '260.00' },
        },
      },
    });
    expect(form.priceMode).toBe('session_total');
    expect(form.sessionTotal).toBe('699.00');
    expect(form.perHead).toBe('');
    expect(form.groupSize).toBe('');
    expect(form.roomModes).toEqual([]);
  });

  it('无版本（pricing=null）→ 空表单（mode 缺省 per_head）', () => {
    const form = pricingFormFromView(VIEW_EMPTY);
    expect(form.priceMode).toBe('per_head');
    expect(form.perHead).toBe('');
    expect(form.oooText).toBe('');
    expect(form.roomModes).toEqual([]);
  });
});

describe('isDirtyPricing（未保存判定——离开确认前提）', () => {
  it('视图原样回填 → 不 dirty；改任一字段 → dirty；切计价模式 → dirty', () => {
    const form = pricingFormFromView(VIEW_WITH_PER_HEAD);
    expect(isDirtyPricing(form, VIEW_WITH_PER_HEAD)).toBe(false);
    expect(isDirtyPricing({ ...form, perHead: '109.00' }, VIEW_WITH_PER_HEAD)).toBe(true);
    expect(isDirtyPricing({ ...form, priceMode: 'session_total' }, VIEW_WITH_PER_HEAD)).toBe(true);
    expect(isDirtyPricing({ ...form, groupSize: '6' }, VIEW_WITH_PER_HEAD)).toBe(true);
    expect(isDirtyPricing({ ...form, oooText: '151.00' }, VIEW_WITH_PER_HEAD)).toBe(true);
    expect(isDirtyPricing({ ...form, acceptMax: '8' }, VIEW_WITH_PER_HEAD)).toBe(true);
  });

  it('沟通形式=多选集合（顺序无关）：重排不 dirty；增删 dirty', () => {
    const form = pricingFormFromView(VIEW_WITH_PER_HEAD);
    const reordered = { ...form, roomModes: ['voice', 'text'] as const };
    expect(isDirtyPricing(reordered, VIEW_WITH_PER_HEAD)).toBe(false);
    expect(isDirtyPricing({ ...form, roomModes: ['text'] }, VIEW_WITH_PER_HEAD)).toBe(true);
  });

  it('空视图：空表单不 dirty；任一输入 → dirty', () => {
    const form = pricingFormFromView(VIEW_EMPTY);
    expect(isDirtyPricing(form, VIEW_EMPTY)).toBe(false);
    expect(isDirtyPricing({ ...form, groupSize: '5' }, VIEW_EMPTY)).toBe(true);
    expect(isDirtyPricing({ ...form, oooVideo: '300.00' }, VIEW_EMPTY)).toBe(true);
  });
});

describe('validatePricingForm（表单防呆——core normalizePricingWrite 值域镜像）', () => {
  const BASE = pricingFormFromView(VIEW_WITH_PER_HEAD);

  it('合法表单 → 零问题', () => {
    expect(validatePricingForm(BASE)).toEqual([]);
  });

  it('默认价格金额形态：非两位小数/空 → 问题（99、99.0、空串均拒）', () => {
    expect(validatePricingForm({ ...BASE, perHead: '99' }).join()).toContain('默认人头价');
    expect(validatePricingForm({ ...BASE, perHead: '99.0' })).not.toEqual([]);
    expect(validatePricingForm({ ...BASE, perHead: '' })).not.toEqual([]);
    expect(validatePricingForm({ ...BASE, perHead: '99.00' })).toEqual([]);
  });

  it('R-02 1对1 区间边界：text 50.00/300.00 收、49.99/300.01 拒（B3 §9 边界矩阵）', () => {
    expect(validatePricingForm({ ...BASE, oooText: '50.00' })).toEqual([]);
    expect(validatePricingForm({ ...BASE, oooText: '300.00' })).toEqual([]);
    expect(validatePricingForm({ ...BASE, oooText: '49.99' }).join()).toContain('50-300');
    expect(validatePricingForm({ ...BASE, oooText: '300.01' }).join()).toContain('50-300');
  });

  it('R-02 语音/视频 100-500：99.99/500.01 拒、100.00/500.00 收', () => {
    expect(validatePricingForm({ ...BASE, oooVoice: '99.99' })).not.toEqual([]);
    expect(validatePricingForm({ ...BASE, oooVoice: '100.00' })).toEqual([]);
    expect(validatePricingForm({ ...BASE, oooVideo: '500.00' })).toEqual([]);
    expect(validatePricingForm({ ...BASE, oooVideo: '500.01' }).join()).toContain('100-500');
  });

  it('1对1 非两位小数形态 → 问题（150/150.0 拒）', () => {
    expect(validatePricingForm({ ...BASE, oooText: '150' })).not.toEqual([]);
    expect(validatePricingForm({ ...BASE, oooVoice: '150.0' })).not.toEqual([]);
  });

  it('开团人数/接受范围：非正整数、越 smallint 上限、只填一半、min>max 均拒', () => {
    expect(validatePricingForm({ ...BASE, groupSize: '0' })).not.toEqual([]);
    expect(validatePricingForm({ ...BASE, groupSize: 'abc' })).not.toEqual([]);
    expect(validatePricingForm({ ...BASE, groupSize: '32768' })).not.toEqual([]);
    expect(validatePricingForm({ ...BASE, groupSize: '8' })).toEqual([]);
    expect(validatePricingForm({ ...BASE, acceptMin: '' })).not.toEqual([]); // 只填 max
    expect(validatePricingForm({ ...BASE, acceptMin: '7' })).not.toEqual([]); // min>max（max=6）
    expect(validatePricingForm({ ...BASE, acceptMin: '2', acceptMax: '' })).not.toEqual([]);
    expect(validatePricingForm({ ...BASE, acceptMin: '2', acceptMax: '6' })).toEqual([]);
    expect(validatePricingForm({ ...BASE, acceptMin: '', acceptMax: '' })).toEqual([]); // 成对留空=null 合法
  });
});

describe('pricingDraftFromForm（表单 → PUT/change 线形态草案）', () => {
  it('per_head 侧：未选侧置 null、空人数/范围 → null、room_modes 数组化', () => {
    const form = pricingFormFromView(VIEW_WITH_PER_HEAD);
    const draft = pricingDraftFromForm(form, 2);
    expect(draft).toEqual({
      base_version: 2,
      per_head: '99.00',
      session_total: null,
      group_size: 5,
      accept_min: 2,
      accept_max: 6,
      room_modes: ['text', 'voice'],
      one_on_one_prices: {
        text: { per_round: '150.00' },
        voice: { per_15min: '200.00' },
        video: { per_15min: '300.00' },
      },
    });
  });

  it('session_total 侧 + 空可空列：per_head=null、group_size/accept=null、空沟通形式=[]', () => {
    const draft = pricingDraftFromForm(
      {
        priceMode: 'session_total',
        perHead: '99.00',
        sessionTotal: '650.00',
        groupSize: '',
        acceptMin: '',
        acceptMax: '',
        roomModes: [],
        oooText: '100.00',
        oooVoice: '150.00',
        oooVideo: '200.00',
      },
      0,
    );
    expect(draft.per_head).toBeNull();
    expect(draft.session_total).toBe('650.00');
    expect(draft.group_size).toBeNull();
    expect(draft.accept_min).toBeNull();
    expect(draft.accept_max).toBeNull();
    expect(draft.room_modes).toEqual([]);
    expect(draft.base_version).toBe(0);
  });
});
