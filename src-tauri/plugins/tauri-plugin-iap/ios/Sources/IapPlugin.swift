// capyroom 内购桥 · StoreKit 2（2026-09-04）
//
// 四条命令，JS 直接 invoke('plugin:iap|<cmd>')（Rust 侧没有对应 command，tauri 把没登记的命令转给原生插件）：
//   products     {ids:[sku]}  → {products:[{id, displayPrice, price, name}]}   拉商品（拉不到＝这包没接商店，前端回落 mock）
//   purchase     {id: sku}    → {state: purchased|cancelled|pending, transactionId?, productId?}
//   restore      {}           → {products:[sku], items:[{productId, transactionId}]}   AppStore.sync() 后读当前凭证（会弹 Apple ID 登录）
//   entitlements {}           → 同上但不 sync、不弹框：启动时静默对账用（换机/重装/家人共享自动补账）
//
// 🔴 落账不在这里：Swift 只回"苹果说你有什么"，写 rewards.json 的永远是内核 reward_purchase（幂等）。
// 🔴 每笔 verified 交易都要 finish()，否则苹果会一直重发（Transaction.updates 里也收尾一遍）。
// 🔴 StoreKit 2 要 iOS 15；包的平台下限是 13（swift-rs 的默认目标），所以类整体 @available，
//    init 里按系统版本给一个只会 reject 的替身。
// ⚠️ 这个文件 Windows 上编不到，只有 CI（macOS runner）能验；改完必须跑一次 build-adhoc。
import SwiftRs
import Tauri
import UIKit
import WebKit
import StoreKit
import UserNotifications

struct ProductsArgs: Decodable { let ids: [String] }
struct PurchaseArgs: Decodable { let id: String }

struct ProductInfo: Encodable { let id: String; let displayPrice: String; let price: String; let name: String }
struct ProductsResponse: Encodable { let products: [ProductInfo] }
struct PurchaseResponse: Encodable { let state: String; let transactionId: String?; let productId: String? }
struct OwnedItem: Encodable { let productId: String; let transactionId: String }
struct OwnedResponse: Encodable { let products: [String]; let items: [OwnedItem] }

@available(iOS 15.0, *)
class IapPlugin: Plugin {
  private var updates: Task<Void, Never>?

  override init() {
    super.init()
    // 后台到账的交易（Ask to Buy 批准 / 中断购买 / 家人共享）在这里收尾，不 finish 苹果会一直重发
    updates = Task.detached {
      for await result in StoreKit.Transaction.updates {
        if case .verified(let t) = result { await t.finish() }
      }
    }
  }

  @objc public func products(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ProductsArgs.self)
    Task {
      do {
        let list = try await Product.products(for: args.ids)
        let out = list.map { ProductInfo(id: $0.id, displayPrice: $0.displayPrice, price: "\($0.price)", name: $0.displayName) }
        invoke.resolve(ProductsResponse(products: out))
      } catch {
        invoke.reject("拉商品失败：\(error.localizedDescription)")
      }
    }
  }

  @objc public func purchase(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PurchaseArgs.self)
    Task { @MainActor in
      do {
        guard let product = try await Product.products(for: [args.id]).first else {
          invoke.reject("商店里没有这件商品：\(args.id)")
          return
        }
        let result = try await product.purchase()
        switch result {
        case .success(let verification):
          switch verification {
          case .verified(let t):
            await t.finish()
            invoke.resolve(PurchaseResponse(state: "purchased", transactionId: String(t.id), productId: t.productID))
          case .unverified(_, let err):
            invoke.reject("交易校验未通过：\(err.localizedDescription)")
          }
        case .userCancelled:
          invoke.resolve(PurchaseResponse(state: "cancelled", transactionId: nil, productId: nil))
        case .pending:
          invoke.resolve(PurchaseResponse(state: "pending", transactionId: nil, productId: nil))
        @unknown default:
          invoke.resolve(PurchaseResponse(state: "unknown", transactionId: nil, productId: nil))
        }
      } catch {
        invoke.reject("购买失败：\(error.localizedDescription)")
      }
    }
  }

  @objc public func restore(_ invoke: Invoke) throws {
    Task {
      // sync 会弹 Apple ID 登录；用户取消也照样把本机已有的凭证读一遍
      do { try await AppStore.sync() } catch {}
      invoke.resolve(await Self.owned())
    }
  }

  @objc public func entitlements(_ invoke: Invoke) throws {
    Task { invoke.resolve(await Self.owned()) }
  }

  private static func owned() async -> OwnedResponse {
    var items: [OwnedItem] = []
    for await result in StoreKit.Transaction.currentEntitlements {
      if case .verified(let t) = result, t.revocationDate == nil {
        items.append(OwnedItem(productId: t.productID, transactionId: String(t.id)))
      }
    }
    return OwnedResponse(products: items.map { $0.productId }, items: items)
  }
}

/// iOS 15 以下：四条命令都拒绝，前端按"没有商店"处理（回落 mock，主题锁不生效）
class IapUnavailable: Plugin {
  @objc public func products(_ invoke: Invoke) { invoke.reject("需要 iOS 15 以上") }
  @objc public func purchase(_ invoke: Invoke) { invoke.reject("需要 iOS 15 以上") }
  @objc public func restore(_ invoke: Invoke) { invoke.reject("需要 iOS 15 以上") }
  @objc public func entitlements(_ invoke: Invoke) { invoke.reject("需要 iOS 15 以上") }
}

// ── 与内购无关，但整个 App 只有这里有 Swift（9-4 用户："杀掉 app 就不该有通知"）──
// 内核语义＝退出即暂停（core::restore 按存盘时刻折算），所以 App 被杀之后已排期的段末通知全是谎话。
// iOS 对"从多任务划掉"没有回调，唯一能抓的是 willTerminate：App 还在后台**未挂起**时划掉会来
// （从 App 直接拉多任务划掉＝最常见的杀法，就是这种）；挂起很久以后再划掉不会来，那种情况系统照发，
// 任何 App 都拦不住。queue 传 nil ＝ 在发通知的线程上**同步**执行，进程马上要没了，排到主队列异步会来不及。
private var terminateObserver: NSObjectProtocol?
private func installTerminateHook() {
  terminateObserver = NotificationCenter.default.addObserver(
    forName: UIApplication.willTerminateNotification, object: nil, queue: nil
  ) { _ in
    let center = UNUserNotificationCenter.current()
    center.removeAllPendingNotificationRequests()
    center.removeAllDeliveredNotifications()
  }
}

@_cdecl("init_plugin_iap")
func initPlugin() -> Plugin {
  installTerminateHook()
  if #available(iOS 15.0, *) { return IapPlugin() }
  return IapUnavailable()
}
