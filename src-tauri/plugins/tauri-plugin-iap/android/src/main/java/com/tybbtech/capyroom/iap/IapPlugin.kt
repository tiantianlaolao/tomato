// capyroom 内购桥 · Google Play Billing 7（2026-09-29）
//
// 与 ios/Sources/IapPlugin.swift 同一份契约，JS 一行不改就能在 Play 包上跑（plugin:iap|<cmd>）：
//   products     {ids:[sku]}  → {products:[{id, displayPrice, price, name}]}
//   purchase     {id: sku}    → {state: purchased|cancelled|pending, transactionId?, productId?}
//   restore      {}           → {products:[sku], items:[{productId, transactionId}]}   查本账号当前拥有的（Play 不弹框）
//   entitlements {}           → 同上（Play 上两者一样：queryPurchasesAsync 本来就是静默的）
//
// 🔴 落账不在这里：只回"Google 说你有什么"，写 rewards.json 的永远是内核 reward_purchase（幂等）。
// 🔴 每笔 PURCHASED 都要 acknowledge，3 天不确认 Google 会自动退款；restore/entitlements 里也补一遍。
// 🔴 transactionId 用 orderId（GPA.xxxx）；沙盒/许可测试账号没有 orderId 时退回 purchaseToken 前 24 位。
// ⚠️ 这个文件 Windows 上编不到，只有 CI 能验；改完必须跑一次 build-android-play。
package com.tybbtech.capyroom.iap

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams

@InvokeArg
class ProductsArgs {
    var ids: List<String> = emptyList()
}

@InvokeArg
class PurchaseArgs {
    lateinit var id: String
}

@TauriPlugin
class IapPlugin(private val activity: Activity) : Plugin(activity), PurchasesUpdatedListener {
    private var client: BillingClient? = null
    private val details = HashMap<String, ProductDetails>()
    // 正在进行的购买：Google 的结果从 onPurchasesUpdated 回来，得把 invoke 留着
    private var pending: Invoke? = null
    private var pendingSku: String? = null

    // ---- 连接 ---------------------------------------------------------------
    private fun withClient(invoke: Invoke, body: (BillingClient) -> Unit) {
        val c = client ?: BillingClient.newBuilder(activity)
            .setListener(this)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build()
            .also { client = it }
        if (c.isReady) { body(c); return }
        c.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(r: BillingResult) {
                if (r.responseCode == BillingClient.BillingResponseCode.OK) body(c)
                else invoke.reject("Play 结算连不上：" + describe(r))
            }
            override fun onBillingServiceDisconnected() {
                // 下一次调用会再 startConnection；这里不重试，免得和正在进行的调用打架
            }
        })
    }

    private fun describe(r: BillingResult) = r.debugMessage + " (" + r.responseCode + ")"

    private fun queryDetails(c: BillingClient, ids: List<String>, cb: (BillingResult, List<ProductDetails>) -> Unit) {
        if (ids.isEmpty()) { cb(BillingResult.newBuilder().setResponseCode(BillingClient.BillingResponseCode.OK).build(), emptyList()); return }
        val list = ids.map {
            QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(BillingClient.ProductType.INAPP).build()
        }
        c.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(list).build()) { r, pds ->
            for (pd in pds) details[pd.productId] = pd
            cb(r, pds)
        }
    }

    private fun productInfo(pd: ProductDetails): JSObject {
        val o = pd.oneTimePurchaseOfferDetails
        val out = JSObject()
        out.put("id", pd.productId)
        out.put("displayPrice", o?.formattedPrice ?: "")
        out.put("price", if (o != null) String.format(java.util.Locale.US, "%.2f", o.priceAmountMicros / 1_000_000.0) else "")
        out.put("name", pd.name)
        return out
    }

    private fun txId(p: Purchase): String = p.orderId?.takeIf { it.isNotEmpty() } ?: p.purchaseToken.take(24)

    private fun acknowledge(c: BillingClient, p: Purchase) {
        if (p.purchaseState != Purchase.PurchaseState.PURCHASED || p.isAcknowledged) return
        c.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.purchaseToken).build()) { }
    }

    // ---- 命令 ---------------------------------------------------------------
    @Command
    fun products(invoke: Invoke) {
        val args = invoke.parseArgs(ProductsArgs::class.java)
        withClient(invoke) { c ->
            queryDetails(c, args.ids) { r, pds ->
                if (r.responseCode != BillingClient.BillingResponseCode.OK) { invoke.reject("拉商品失败：" + describe(r)); return@queryDetails }
                val arr = JSArray()
                for (pd in pds) arr.put(productInfo(pd))
                val out = JSObject(); out.put("products", arr)
                invoke.resolve(out)
            }
        }
    }

    @Command
    fun purchase(invoke: Invoke) {
        val args = invoke.parseArgs(PurchaseArgs::class.java)
        if (pending != null) { invoke.reject("上一笔购买还没结束"); return }
        withClient(invoke) { c ->
            val go = { pd: ProductDetails ->
                pending = invoke; pendingSku = pd.productId
                val params = BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(pd).build()))
                    .build()
                activity.runOnUiThread {
                    val r = c.launchBillingFlow(activity, params)
                    if (r.responseCode != BillingClient.BillingResponseCode.OK) {
                        pending = null; pendingSku = null
                        if (r.responseCode == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
                            // 已经买过（比如重装后还没恢复）：当成买成，前端落账即可
                            val out = JSObject(); out.put("state", "purchased"); out.put("productId", pd.productId); out.put("transactionId", "")
                            invoke.resolve(out)
                        } else invoke.reject("购买没拉起来：" + describe(r))
                    }
                }
            }
            val cached = details[args.id]
            if (cached != null) go(cached)
            else queryDetails(c, listOf(args.id)) { r, pds ->
                val pd = pds.firstOrNull { it.productId == args.id }
                if (pd == null) invoke.reject("商店里没有这件商品：" + args.id + (if (r.responseCode != BillingClient.BillingResponseCode.OK) "（" + describe(r) + "）" else ""))
                else go(pd)
            }
        }
    }

    // Google 的购买结果（用户付完 / 取消 / 待批准）都从这里回来
    override fun onPurchasesUpdated(r: BillingResult, purchases: MutableList<Purchase>?) {
        val c = client
        val inv = pending
        if (inv == null) {
            // 不是我们正在等的那笔（比如上次 PENDING 的购买这会儿批准了）：只做确认收货，落账等下次 entitlements 对账
            if (r.responseCode == BillingClient.BillingResponseCode.OK && c != null) purchases?.forEach { acknowledge(c, it) }
            return
        }
        val sku = pendingSku
        pending = null; pendingSku = null
        when (r.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                val p = purchases?.firstOrNull { sku == null || it.products.contains(sku) } ?: purchases?.firstOrNull()
                if (p == null) { inv.reject("购买没有完成"); return }
                val out = JSObject()
                when (p.purchaseState) {
                    Purchase.PurchaseState.PURCHASED -> {
                        if (c != null) acknowledge(c, p)
                        out.put("state", "purchased"); out.put("transactionId", txId(p)); out.put("productId", p.products.firstOrNull() ?: sku)
                    }
                    Purchase.PurchaseState.PENDING -> { out.put("state", "pending") }
                    else -> { out.put("state", "unknown") }
                }
                inv.resolve(out)
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> { val out = JSObject(); out.put("state", "cancelled"); inv.resolve(out) }
            BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> {
                val out = JSObject(); out.put("state", "purchased"); out.put("productId", sku); out.put("transactionId", ""); inv.resolve(out)
            }
            else -> inv.reject("购买失败：" + describe(r))
        }
    }

    private fun owned(invoke: Invoke) {
        withClient(invoke) { c ->
            c.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build()) { r, list ->
                if (r.responseCode != BillingClient.BillingResponseCode.OK) { invoke.reject("读不到已购：" + describe(r)); return@queryPurchasesAsync }
                val products = JSArray(); val items = JSArray()
                for (p in list) {
                    if (p.purchaseState != Purchase.PurchaseState.PURCHASED) continue
                    acknowledge(c, p)     // 漏掉 acknowledge 的这里补上（3 天不确认会被退款）
                    for (sku in p.products) {
                        products.put(sku)
                        val it = JSObject(); it.put("productId", sku); it.put("transactionId", txId(p)); items.put(it)
                    }
                }
                val out = JSObject(); out.put("products", products); out.put("items", items)
                invoke.resolve(out)
            }
        }
    }

    @Command
    fun restore(invoke: Invoke) { owned(invoke) }

    @Command
    fun entitlements(invoke: Invoke) { owned(invoke) }
}
