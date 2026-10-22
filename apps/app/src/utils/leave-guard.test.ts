import { describe, expect, it } from 'bun:test';
import { installPhysicalBackGuard } from './leave-guard';

/** web window 假件：记录注册/移除，可回放事件 */
function fakeWindow() {
  const listeners = new Map<string, Array<(ev: { preventDefault(): void }) => void>>();
  return {
    addEventListener(type: string, listener: (ev: { preventDefault(): void }) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type: string, listener: (ev: { preventDefault(): void }) => void) {
      const list = (listeners.get(type) ?? []).filter((l) => l !== listener);
      listeners.set(type, list);
    },
    fire(type: string): { prevented: boolean } {
      let prevented = false;
      for (const l of listeners.get(type) ?? []) {
        l({ preventDefault: () => (prevented = true) });
      }
      return { prevented };
    },
    count(type: string): number {
      return (listeners.get(type) ?? []).length;
    },
  };
}

/** native BackHandler 假件：记录注册/移除与句柄 remove 调用 */
function fakeBackHandler() {
  const calls: Array<{ event: string; handler: () => boolean }> = [];
  const removed: Array<{ event: string; handler: () => boolean }> = [];
  const handleRemoves: string[] = [];
  return {
    addEventListener(event: string, handler: () => boolean) {
      calls.push({ event, handler });
      return {
        remove: () => handleRemoves.push(`sub:${event}`),
      };
    },
    removeEventListener(event: string, handler: () => boolean) {
      removed.push({ event, handler });
    },
    fire(event: string): boolean[] {
      return calls.filter((c) => c.event === event).map((c) => c.handler());
    },
    removedEvents: () => removed.map((r) => r.event),
    handleRemoveCalls: () => handleRemoves,
  };
}

describe('installPhysicalBackGuard（修复环 I-1：物理/浏览器返回的未保存离开拦截）', () => {
  it('web 分支：注册 beforeunload——intercept=true 时事件被 preventDefault（浏览器原生确认）', () => {
    const win = fakeWindow();
    const release = installPhysicalBackGuard({
      intercept: () => true,
      windowTarget: win,
      backHandler: null,
    });
    expect(win.count('beforeunload')).toBe(1);
    expect(win.fire('beforeunload').prevented).toBe(true);
    release();
    expect(win.count('beforeunload')).toBe(0);
  });

  it('web 分支：intercept=false（clean）不 preventDefault；release 后再触发无效', () => {
    const win = fakeWindow();
    let interceptOn = false;
    const release = installPhysicalBackGuard({
      intercept: () => interceptOn,
      windowTarget: win,
      backHandler: null,
    });
    expect(win.fire('beforeunload').prevented).toBe(false);
    interceptOn = true;
    expect(win.fire('beforeunload').prevented).toBe(true);
    release();
    interceptOn = true;
    expect(win.fire('beforeunload').prevented).toBe(false); // 已清理：无监听
  });

  it('native 分支：hardwareBackPress 返回 intercept 结果（true=吞掉默认退出）；release 句柄+removeEventListener 双保险', () => {
    const bh = fakeBackHandler();
    let dirty = true;
    const release = installPhysicalBackGuard({
      intercept: () => dirty,
      windowTarget: null,
      backHandler: bh,
    });
    expect(bh.fire('hardwareBackPress')).toEqual([true]); // dirty：拦截
    dirty = false;
    expect(bh.fire('hardwareBackPress')).toEqual([false]); // clean：放行默认返回
    release();
    expect(bh.handleRemoveCalls()).toEqual(['sub:hardwareBackPress']);
    expect(bh.removedEvents()).toEqual(['hardwareBackPress']);
  });

  it('双环境皆缺（SSR/测试兜底）：无操作清理函数，不抛错', () => {
    const release = installPhysicalBackGuard({
      intercept: () => true,
      windowTarget: null,
      backHandler: null,
    });
    expect(release).toBeInstanceOf(Function);
    expect(() => release()).not.toThrow();
  });
});
