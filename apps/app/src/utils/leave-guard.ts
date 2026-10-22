/**
 * 物理返回拦截（M3-W2 T2 修复环 I-1）：未保存离开确认的两条物理路径收口。
 *   - web：window beforeunload——浏览器返回/关闭卸载 SPA 前触发浏览器原生「确认离开」
 *     （页内确认面板在 unload 时机不可展示，原生弹窗即 web 平台的确认形态）；
 *   - native（Android）：BackHandler hardwareBackPress——返回 true 吞掉默认退出，
 *     由 intercept 回调弹出页内确认面板（iOS 无硬件返回，不涉及）。
 *
 * 依赖注入形态（平台无关，bun test 直测）：screen 侧按 Platform.OS 注入真实
 * window/BackHandler（RN-web 的 BackHandler 是 console.error 桩——web 分支恒传 null
 * 不触达）；返回清理函数，卸载/确认完成后必须调用（防监听泄漏与残留拦截）。
 * 纯函数、无 react-native import。
 */

/** beforeunload 事件最小面（DOM 事件经注入收窄，不引入完整 DOM 类型耦合） */
export interface BeforeUnloadLikeEvent {
  preventDefault(): void;
  /** legacy Chrome/Edge 兼容位（现代浏览器仅需 preventDefault；赋值无害） */
  returnValue?: unknown;
}

export interface BeforeUnloadTarget {
  addEventListener(type: 'beforeunload', listener: (ev: BeforeUnloadLikeEvent) => void): void;
  removeEventListener(type: 'beforeunload', listener: (ev: BeforeUnloadLikeEvent) => void): void;
}

export interface BackHandlerLike {
  addEventListener(eventName: 'hardwareBackPress', handler: () => boolean): { remove(): void };
  /** 可选：RN-web 的 BackHandler 类型面仅含 addEventListener——句柄 remove 是主清理路径 */
  removeEventListener?(eventName: 'hardwareBackPress', handler: () => boolean): void;
}

export interface PhysicalBackGuardDeps {
  /**
   * 拦截裁决：true=拦截（web→preventDefault 触发原生确认；native→吞掉默认退出，
   * 由调用方出示页内确认面板）；false=放行（clean 态不设防的二次校验）
   */
  readonly intercept: () => boolean;
  /** web 环境 window；null=走 native 分支 */
  readonly windowTarget: BeforeUnloadTarget | null;
  /** native 环境 BackHandler；null=走 web 分支 */
  readonly backHandler: BackHandlerLike | null;
}

/** 安装物理返回拦截；返回清理函数（幂等可重调） */
export function installPhysicalBackGuard(deps: PhysicalBackGuardDeps): () => void {
  if (deps.windowTarget !== null) {
    const listener = (ev: BeforeUnloadLikeEvent): void => {
      if (!deps.intercept()) return;
      ev.preventDefault();
      ev.returnValue = ''; // legacy Chromium 兼容（赋空串即启用原生确认弹窗）
    };
    deps.windowTarget.addEventListener('beforeunload', listener);
    return () => {
      deps.windowTarget?.removeEventListener('beforeunload', listener);
    };
  }
  if (deps.backHandler !== null) {
    const handler = (): boolean => deps.intercept();
    const sub = deps.backHandler.addEventListener('hardwareBackPress', handler);
    return () => {
      sub.remove(); // RN 0.65+ 句柄制主路径
      deps.backHandler?.removeEventListener?.('hardwareBackPress', handler); // 旧版全局表双保险（类型面可缺）
    };
  }
  return () => undefined; // 双环境皆缺（SSR/测试兜底）：无物理返回面可拦
}
